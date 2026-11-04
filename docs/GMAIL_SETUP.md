# Connect Gmail to Aelys

Gmail reads and draft management are approved (ADR-020). Sending is unavailable.
The deployment must have a Google OAuth **Web application** client; a desktop-client
JSON is not interchangeable because tokens and the callback belong to the API.

1. In your Google Cloud project, enable the Gmail API.
2. Configure Google Auth Platform branding/audience. For an external app in testing,
   add your Gmail address as a test user. Keep the existing read/draft scopes.
3. Create an OAuth client of type Web application. Register the exact callback:
   `https://api-production-1cea.up.railway.app/api/v1/mail/gmail/callback`
   (self-hosters substitute their own API origin).
4. Save the client JSON locally. Do not paste the client secret into chats, source,
   screenshots, frontend settings or logs. Configure these **server-only** variables:
   `AELYS_GMAIL_CLIENT_ID`, `AELYS_GMAIL_CLIENT_SECRET`, `AELYS_GMAIL_REDIRECT_URI`.
   Keep the existing encrypted secret-store key; do not rotate it for this setup.
   Railway CLI supports supplying a single variable value through stdin rather
   than command-line arguments. Restart/redeploy the API after configuration.
5. In Aelys: Settings → Connected accounts → Connect Gmail. On native hosts the
   system browser opens a one-use backend handoff, which sets the browser cookie
   before Google authorization. Complete consent and return to Aelys.
6. The account refreshes on return. Choose **Load latest** to import messages or
   **Load drafts** to import drafts. These are explicit imports, not email sends.

The browser completion page works on an API-only deployment and contains no
OAuth code, capability or Google token. Handoffs expire in ten minutes and fail
on replay, logout, expired session or revoked device. A new connection does not
change Aelys sign-in or grant browser access to the native session.

Testing-mode Google grants can expire; use Reconnect Gmail when Google requires
renewed consent. Google app verification/production consent depends on your app
configuration and is separate from this code fix.

Official setup: [Gmail server-side authorization](https://developers.google.com/workspace/gmail/api/auth/web-server).
Implementation and local/live acceptance: [Gmail connection repair](optimization/gmail-connection.md).


## Google Calendar

The same Web application client can support the separate read-only Calendar
connection. Enable Google Calendar API and add the exact Calendar callback:
`https://api-production-1cea.up.railway.app/api/v1/calendar/google/callback`.
Set backend-only `AELYS_CALENDAR_REDIRECT_URI` to that value, retaining the existing
Gmail client ID/secret and provider encryption key. Add `calendar.readonly` to
the Google consent configuration; actual Calendar consent is separate from Gmail.
After deploying migration 0041, open Settings → Google Calendar → Connect, finish
Google consent in the system browser and choose Import now. The native callback
shows a static completion page; no frontend route is required on the API host.
