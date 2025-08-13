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

const PORT = 3000;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/auth/google/callback';

app.use(express.static('public'));

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
