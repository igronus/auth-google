# Auth with Google

The app to get logged in via google.

## Setup

### Getting the code

```
git clone ...
cd ...
npm install
```

### Create a Google Cloud project & OAuth credentials

Go to Google Cloud Console.

Create a new project (or pick an existing one).

In APIs & Services → Credentials, click Create Credentials → OAuth client ID.

Select Web Application.

Add Authorized JavaScript origins (your app URL, e.g. http://localhost:3000).

Add Authorized redirect URIs (e.g. http://localhost:3000/auth/google/callback).

Save and copy the Client ID and Client Secret.

## Running

```
node server
```
