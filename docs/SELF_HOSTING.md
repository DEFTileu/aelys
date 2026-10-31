# Local development and self-hosting

Aelys is a single-owner instance. The bootstrap endpoint initializes the one
owner; device enrollment identifies that owner's Web, Mac and Android devices.
It is not a public registration or team-account flow.

## Web + SQLite quickstart

From a clean checkout:

```sh
cp backend/.env.example backend/.env
# Edit backend/.env and replace AELYS_SECRET_KEY.

python3 -m venv .venv
.venv/bin/python -m pip install -e 'backend[test,quality]'
cd backend
PYTHONPATH=. ../.venv/bin/alembic upgrade head
PYTHONPATH=. ../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The quality extra installs the Ruff version required by `ruff.toml`. Run
`.venv/bin/ruff check backend/app backend/tests` from the repository root;
CI uses the same full check. The configuration targets the declared Python 3.12
minimum and recognizes FastAPI route declarations without suppressing ordinary
function-default diagnostics.

In a second terminal:

```sh
pnpm install --frozen-lockfile
VITE_API_BASE_URL=/api/v1 pnpm --filter @aelys/web dev --host 127.0.0.1 --port 5173
```

The Vite development server proxies `/api` to `http://127.0.0.1:8000` by
default. If that port is occupied by another local service, choose an available
backend port and start Vite with the explicit origin, for example:

The repository helper discovers available ports and reuses verified Aelys
services:

```sh
./scripts/start_local.sh
```

It keeps the standard `8000/5173` defaults when available and selects a loopback
fallback in `8001–8010` / `5174–5180` when they are occupied. Set
`AELYS_BACKEND_PORT` / `AELYS_WEB_PORT` for fixed ports: an occupied port is then
an error unless its existing Aelys service matches. `AELYS_BACKEND_ORIGIN`
connects to an existing backend and must be an HTTP(S) origin without credentials
or a path; it never silently starts a replacement server.

Backend discovery checks both health and the Aelys OpenAPI contract. Existing
Vite instances are reused only when their development metadata identifies the
same backend origin. The helper uses Python from `.venv`, falling back to
`python3`; starting a backend still requires `.venv/bin/uvicorn` and starting
the frontend requires `pnpm`.

Keep the helper terminal open while it owns a server. Ctrl+C, SIGTERM or child
failure closes only the processes created by that invocation, including Vite
descendants; reused servers remain running. When both services already exist,
the helper prints their URLs and exits. If only the web server existed, the
newly started backend remains supervised until the helper is stopped.
Use the explicit commands below for separate terminals.

```sh
# terminal 1, from the repository root
cd backend && ../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8001

# terminal 2, from the repository root
AELYS_BACKEND_ORIGIN=http://127.0.0.1:8001 \
  pnpm --filter @aelys/web exec vite --host 127.0.0.1 --port 5174 --strictPort
```

The same origin is used for `/api` and `/healthz`; no CORS or cleartext policy
is broadened by this local fallback.
Open the printed Web URL, go to Settings, and open the owner session. The Web
client enrolls a device credential for this browser after login.

## PostgreSQL

Set `AELYS_DATABASE_URL` to a PostgreSQL async URL, for example:

```text
postgresql+asyncpg://aelys:change-me@127.0.0.1:5432/aelys
```

Create the database and role using the PostgreSQL operator's normal secure
procedure, then run:

```sh
cd backend
PYTHONPATH=. ../.venv/bin/alembic upgrade head
```

Run the PostgreSQL integration tests with `AELYS_DATABASE_URL` set. Production
TLS, role hardening, backup retention and process supervision remain operator
responsibilities and are release prerequisites.

## Containerized backend + PostgreSQL

The repository includes `compose.self-hosted.yaml` for a reproducible local
operator setup. It starts only the backend and PostgreSQL; serve the built web
client through the operator's chosen web server and configure its API base URL.
Secrets are supplied through the shell and are never committed:

```sh
export AELYS_SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export POSTGRES_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
docker compose -f compose.self-hosted.yaml up --build
```

The backend is then available at `http://127.0.0.1:8000`; verify `/healthz`
and open `/docs` for the API contract. Stop it with:

```sh
docker compose -f compose.self-hosted.yaml down
```

The named PostgreSQL volume is retained by `down`; use the documented backup
and restore drill in [BACKUP_RESTORE.md](BACKUP_RESTORE.md) before removing it.
This Compose file is a local/self-hosting development path. TLS, reverse proxy,
operator role hardening, backups, monitoring and production process policy are
deliberate deployment responsibilities.

## Checks

```sh
make compile
make test
AELYS_SECRET_KEY="$AELYS_SECRET_KEY" make openapi
pnpm --filter @aelys/shared typecheck
pnpm --filter @aelys/shared test
pnpm --filter @aelys/web typecheck
pnpm --filter @aelys/web test
pnpm --filter @aelys/web build
cargo test --manifest-path apps/runtime/Cargo.toml --locked
```

Use [BACKUP_RESTORE.md](BACKUP_RESTORE.md) for encrypted single-owner export
and restore. Raw Mac agent sessions are intentionally outside that workflow.

The macOS and Android wrappers have separate platform prerequisites and are not
claimed as packaged releases until their platform gates pass. Vendor execution
also remains fail-closed until the signed helper/isolation evidence is present.

## AI providers and Gmail

Run `alembic upgrade head` through `0016_gmail_connection` before using Gmail.
Settings → AI & models supports Claude/OpenRouter, a model ID, encrypted key
registration/replacement/removal, and a read-only credential probe. Enter a
model ID available to your provider account; the probe verifies the key, and
model access is verified by the first chat request. Chats keep user/assistant
history on the backend. API keys are never returned or put in the offline outbox.
A real provider completion has not been verified without owner credentials.

The owner approved Gmail **reading and drafts**, on 2026-10-29. To enable it:

1. Enable Gmail API in your Google Cloud project. Configure its OAuth consent
   screen and add your account as a test user for a private testing app.
2. Create a **Web application** OAuth client. Register this exact local redirect
   URI: `http://127.0.0.1:5173/api/v1/mail/gmail/callback`.
3. Set `AELYS_GMAIL_CLIENT_ID`, `AELYS_GMAIL_CLIENT_SECRET` and
   `AELYS_GMAIL_REDIRECT_URI` in the backend environment. Keep the client secret
   out of Git. Restart the backend; use the same `127.0.0.1:5173` web origin.
4. Open Mail → Connect Gmail and approve access in Google. Load latest Gmail
   reads 25 messages; Load older mail continues pagination. Load Gmail drafts
   imports 25 new drafts at a time and keeps existing local edits.
5. Compose/Save draft keeps a local draft. **Save to Gmail** explicitly creates
   or updates the draft in the selected Google mailbox. Discard local draft
   removes only the Aelys copy. Aelys has no email-send endpoint.

Google's `gmail.compose` scope includes sending as well as managing drafts;
Google does not offer a standalone draft-only OAuth scope. Aelys requests
`gmail.readonly` and `gmail.compose`, and implements no send action. See the
[Google scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes)
and [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).

OAuth uses a browser-bound, hashed, expiring single-use state and PKCE; access
and refresh tokens are encrypted in `gmail_credentials`, never returned to the
frontend or included in owner exports/sync. Disconnect removes local tokens and
attempts Google revocation. It retains previously loaded messages and drafts.
If revocation cannot be confirmed, remove Aelys access in your Google account.
The provider secret rotation script also rotates Gmail token/verifier envelopes.

If draft creation has an uncertain result, Aelys stops retries to avoid creating
multiple copies. Check Gmail before creating a replacement local draft.
Gmail sync is manual and imports new messages/drafts; it does not mirror Gmail
labels, deletions, attachments, or external changes to already imported drafts.
A live OAuth round trip still requires your own configured Google client.
Production reverse proxies must exclude callback query strings from access logs;
the built-in Uvicorn logger redacts codes/state for this callback. Production
TLS and Google OAuth verification remain operator prerequisites.

### Phase 3 local module migrations

Install the updated backend dependencies (`python-dateutil` supplies RFC RRULE
parsing), then run the existing Alembic upgrade command through `0022_telegram_business`.
Migration 0018 fails if old data contains multiple active sessions for an owner;
resolve those sessions explicitly before retrying. It does not delete them.
Migration 0019 keeps SQLite ledger decimals as text for exact future writes;
it cannot recover precision already lost in old SQLite NUMERIC values and
intentionally refuses a lossy SQLite downgrade. PostgreSQL retains NUMERIC.

Migration 0021 repairs the two `ai_runs` foreign keys omitted by legacy SQLite
upgrades in revision 0013. It preserves existing records and stops if orphaned
references need explicit resolution. Fresh databases and already repaired
schemas are unchanged.

Calendar reminders appear in the web notification center while Aelys is open
and connected; due occurrences catch up on reconnect. Background OS push is not
part of this slice. Cached personal module reads work on previously loaded
records. Their mutation controls require a connection and report
`OFFLINE_WRITE_UNAVAILABLE`; durable mutation replay is not advertised.

## Browser sign-in

Open the web app directly (locally `http://127.0.0.1:5173`). A new instance offers
first-owner setup; an initialized instance offers sign-in using its existing
email/password. All modules become available after this single entry step;
Settings is no longer the place to initialize a session. Existing accounts and
data are preserved. Sessions restore from an HttpOnly cookie on reopening, and
access tokens renew automatically. Default lifetimes are 15 minutes for access
and 30 days for refresh, using the existing auth settings.

Serve `/api/v1` and `/healthz` through the same origin as the web app. Vite already
proxies both to `127.0.0.1:8000`. Use HTTPS for remote installations. If a trusted
reverse proxy sends an Origin different from the backend's own origin, set
`AELYS_BROWSER_ORIGINS` to a JSON array of the exact trusted web origins (default
loopback origins on port 5173); this is a CSRF allowlist, not a CORS bypass.
Keep `AELYS_SECRET_KEY` stable in the backend environment so restarts preserve
sessions. Signing out works from Settings; revoked devices cannot restore.

## Dashboard layout and weather

On Home, drag a widget by its header/grip to reorder it, or drag the lower-right
corner to change width and height. Neither gesture requires Customize. The same
handles support arrow keys: the header reorders, the corner changes dimensions.
Customize remains for adding/removing built-in widgets and resetting the layout.
Layout changes save immediately in this browser (`aelys.desktop.home.v1`), including
while offline; they do not currently sync to other devices. Legacy layouts remain
readable. A storage failure is shown instead of claiming a durable save.

For weather, click the city/temperature pill at the top, the weather widget's
city button, or Settings → **Погода и город**. Search for a city and select the
correct country/region, or click **Использовать моё местоположение** and grant
browser permission. Automatic mode resumes only after that explicit selection
and when browser permission remains granted; it never opens permission prompts
on its own. Manual selection turns automatic mode off. Weather can be disabled
from the same settings panel.

Weather uses the documented [Open-Meteo forecast API](https://open-meteo.com/en/docs)
and [geocoding API](https://open-meteo.com/en/docs/geocoding-api), without a key for
this personal, noncommercial instance. Attribution is displayed alongside weather
and search. [Service terms](https://open-meteo.com/en/terms) apply; commercial use
is outside this slice. Requests go directly from the browser to these two fixed
HTTPS hosts, without Aelys credentials or referrer. Coordinates are rounded to
0.1° before requests/storage. Exact browser coordinates never go to the backend,
logs, IndexedDB or sync. Selected location and last successful forecast are stored
locally (`aelys.weather.v1`). Updates are shared across the pill/widget, cached
for 30 minutes, and retried on reconnect/focus; offline data retains its timestamp.

Geolocation requires HTTPS or loopback and a browser/OS that supports it. A
frontend/reverse-proxy Permissions-Policy must allow `geolocation=(self)`; Aelys
uses this narrow policy and keeps camera/microphone disabled. If the embedded
browser refuses location access, choose a city manually or use a supported
external browser. No permission bypass or IP-location service is used.


## Telegram Business assistant

In Settings → **Telegram**, enter your BotFather token, enable Secretary Mode in
BotFather, and open the single-use owner-binding link from your own Telegram
account. Then connect the same bot in Telegram's business/chatbot settings and
select the chats and reply permissions. The Aelys panel shows bot configuration,
owner binding and Business connection separately; a token alone is not a connected
business assistant.

Choose an existing AI provider with its saved API key and model, write the
assistant's business instructions, and enable **Читать и отвечать автоматически**.
The selected chat text is sent to that provider to generate replies; private
Aelys modules and tools are excluded. Automatic reply is off until this explicit
configuration. The backend polls Telegram while it runs, so localhost needs no
public domain or inbound webhook. An existing webhook causes a visible conflict
and is never deleted automatically.

The connector worker is supervised by the FastAPI lifespan and keeps its offset,
update receipts and polling lease in the database. No separate daemon or new SDK
is required. Upgrade to migration `0022_telegram_business` before starting the new
backend. Stop the backend during encryption-key rotation; the existing rotation
script now rotates Telegram token, business text/drafts, chat labels and persona
along with provider and Gmail secrets. Keep the encryption material stable.

Only recent incoming plain-text private messages receive automatic replies.
Replies require active owner-bound BusinessConnection rights and an incoming
message within Telegram's 24-hour window. Unknown delivery stays visibly unknown;
no automatic retry can silently duplicate a reply. Pause, revoke Telegram rights,
or disconnect to stop the assistant. Message text is encrypted at rest and erased
after seven days; deletions/revocations erase affected cached content, and
Disconnect purges the connector's message/connection records and token. These
records are excluded from general owner export and browser offline queues.

See [Telegram Business setup and limits](TELEGRAM_BUSINESS.md) and
[validation](TELEGRAM_BUSINESS_VALIDATION.md). Live acceptance needs your own bot,
Telegram account and configured AI key; none were supplied during implementation.

### Embedding protection

`frame-ancestors` must be an HTTP Content-Security-Policy response header; browsers
ignore it in a meta element. The API (and same-origin QA server) already emits
`X-Frame-Options: DENY`. Configure the production static web server to send
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on
HTML responses; the client meta policy alone cannot enforce embedding protection.

## First owner without a password

By default the server no longer creates an owner from an email and password. On an empty server it prints a one-time setup token to the console (`python -m app.core.admin setup-token` prints another). Claim it with `POST /api/v1/auth/setup/claim` (see `QR_PAIRING_AUTH_PROPOSAL.md`). The app screens for this are not built yet; until they are, a fresh install that wants the old first-run screen must set `AELYS_PASSWORD_BOOTSTRAP_ENABLED=true`. Existing owners are unaffected.
