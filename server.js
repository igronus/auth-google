require('dotenv').config();

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const app = express();

const session = require('express-session');

app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key', // change in prod
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // true if using HTTPS
}));

const PORT = process.env.PORT || 3000;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

app.use(express.static('public'));
app.use(express.json());

// Simple file-based cache for AI results
const fs = require('fs');
const path = require('path');
const EVENTS_DIR = path.join(__dirname, 'events');
if (!fs.existsSync(EVENTS_DIR)) {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
}
const sanitizeEventId = (id) => (id || '').toString().replace(/[^a-zA-Z0-9_-]/g, '_');

app.post('/ai', async (req, res) => {
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY);

    const { title, description, time, eventId } = req.body || {};
    if (!title && !description && !time) {
      return res.status(400).json({ error: 'Missing event data (title/description/time)' });
    }

    // Attempt cache read first if eventId provided
    let cachePath;
    if (eventId) {
      const safeId = sanitizeEventId(eventId);
      cachePath = path.join(EVENTS_DIR, `${safeId}.json`);
      if (fs.existsSync(cachePath)) {
        try {
          const cachedRaw = fs.readFileSync(cachePath, 'utf8');
          const cached = JSON.parse(cachedRaw);
          return res.json({ text: cached.text, cached: true });
        } catch (_) {
          // fallthrough to regen on parse error
          console.error('Failed to read from the path:', cachePath);
        }
      }
    }

    const prompt = [
      'You are an assistant that augments Google Calendar events with helpful context.',
      'Given the event details, provide a concise 1-3 sentence suggestion or context:',
      `- Title: ${title || '(none)'}`,
      `- Time: ${time || '(all day or unknown)'}`,
      `- Description: ${description || '(none)'}`,
      'Return plain text only. Keep it short and actionable.'
    ].join('\n');

    const result = await genAI.models.generateContent({
      model: "gemini-2.0-flash-exp",
      contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    let text = '';
    if (result?.response?.text) {
      text = result.response.text;
    } else if (result?.text) {
      text = result.text;
    } else if (result?.candidates?.[0]?.content?.parts?.[0]?.text) {
      text = result.candidates[0].content.parts[0].text;
    } else {
      text = '';
    }
    // Write to cache if path resolved
    if (cachePath && text) {
      try {
        fs.writeFileSync(cachePath, JSON.stringify({
          text,
          meta: {
            title: title || null,
            time: time || null,
            description: description || null,
            generatedAt: new Date().toISOString()
          }
        }, null, 2), 'utf8');
      } catch (e) {
        // ignore cache write errors
        console.error('Failed to writo to the path:', cachePath);
      }
    }
    res.json({ text, cached: false });
  } catch (error) {
    console.error('AI endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/me', (req, res) => {
  if (req.session.user && JSON.stringify(req.session.user) !== '{}') {
    res.json(req.session.user);
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// Logout endpoint
app.get('/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/');
  });
});

// Step 1: Redirect to Google Auth
app.get('/auth/google', (req, res) => {
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: [
      'openid',
      'profile',
      'email',
      'https://www.googleapis.com/auth/calendar.readonly',
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent'
  };
  const qs = new URLSearchParams(options);
  res.redirect(`${rootUrl}?${qs.toString()}`);
});

// Step 2: Handle callback and exchange code for tokens
app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });

  const tokens = await tokenRes.json();

  // Get user info
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`
    }
  });
  const userInfo = await userRes.json();

  // Store minimal info in session
  req.session.user = {
    id: userInfo.id,
    name: userInfo.name,
    email: userInfo.email,
    picture: userInfo.picture
  };

  req.session.tokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token // if you requested offline access
  };

  res.redirect('/'); // redirect to a profile page
});

app.get('/calendar/today', async (req, res) => {
  if (!req.session.tokens?.access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3); // today + tomorrow + the day after

  const params = new URLSearchParams({
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime'
  });

  const eventsRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: {
      Authorization: `Bearer ${req.session.tokens.access_token}`
    }
  });

  const eventsData = await eventsRes.json();
  res.json(eventsData.items || []);
});

// Four-day grouped events: yesterday, today, tomorrow, day after tomorrow
app.get('/calendar/four-days', async (req, res) => {
  if (!req.session.tokens?.access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const now = new Date();

    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

    const today = startOfDay(now);
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const dayAfter = new Date(today);
    dayAfter.setDate(today.getDate() + 2);

    const windowStart = yesterday; // start of yesterday
    const windowEnd = endOfDay(dayAfter); // end of day after tomorrow

    const params = new URLSearchParams({
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime'
    });

    const eventsRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: {
        Authorization: `Bearer ${req.session.tokens.access_token}`
      }
    });

    const eventsData = await eventsRes.json();
    const items = Array.isArray(eventsData.items) ? eventsData.items : [];

    // Group by YYYY-MM-DD (local time)
    const toKey = (event) => {
      const start = event.start?.dateTime || event.start?.date; // date for all-day
      const dateObj = start?.length > 10 ? new Date(start) : new Date(start + 'T00:00:00');
      const y = dateObj.getFullYear();
      const m = String(dateObj.getMonth() + 1).padStart(2, '0');
      const d = String(dateObj.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };

    const buckets = new Map();
    for (const ev of items) {
      const key = toKey(ev);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(ev);
    }

    const formatLabel = (d, baseToday) => {
      const delta = Math.floor((startOfDay(d) - baseToday) / (24 * 60 * 60 * 1000));
      if (delta === -1) return 'Yesterday';
      if (delta === 0) return 'Today';
      if (delta === 1) return 'Tomorrow';
      if (delta === 2) return 'Day After';
      return d.toDateString();
    };

    const days = [yesterday, today, tomorrow, dayAfter].map((d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const key = `${y}-${m}-${day}`;
      return {
        key,
        label: formatLabel(d, today),
        events: buckets.get(key) || []
      };
    });

    res.json({ days });
  } catch (err) {
    console.error('Four-days calendar error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/calendar/debug', async (req, res) => {
  if (!req.session.tokens?.access_token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Step 1: List calendars
    const calendarsRes = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: {
        Authorization: `Bearer ${req.session.tokens.access_token}`
      }
    });

    const calendarsData = await calendarsRes.json();

    if (!calendarsData.items) {
      return res.status(500).json({ error: 'Could not fetch calendars', data: calendarsData });
    }

    const results = [];

    // Step 2: For each calendar, fetch up to 5 events
    for (const cal of calendarsData.items) {
      const eventsRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?maxResults=5&singleEvents=true&orderBy=startTime`, {
        headers: {
          Authorization: `Bearer ${req.session.tokens.access_token}`
        }
      });
      const eventsData = await eventsRes.json();

      results.push({
        calendarId: cal.id,
        summary: cal.summary,
        events: eventsData.items || []
      });
    }

    res.json(results);

  } catch (err) {
    console.error('Calendar debug error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
