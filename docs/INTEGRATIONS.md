# Aelys — Integrations, Mail, Telegram v0.2

## 1. Product ordering

**DECIDED:** собственные модули прежде внешних интеграций. Также **DECIDED:** целевой MVP включает Mail и Telegram. Следовательно, нужно разделять `доменный модуль` и `действующее подключение`.

| Feature | Сразу в модульном ядре | Внешнее подключение |
|---|---|---|
| Mail | message/thread/draft/search/import API | Gmail OAuth read/drafts approved 2026-10-29; IMAP later |
| Calendar | native Aelys events / recurrence; separate read-only Google primary calendar import | Live OAuth acceptance needs owner credentials |
| Telegram | command/notification adapter abstraction | Реальный Bot API обязателен для рабочего бота |
| GitHub | repository association, manual links | OAuth, repo webhooks later |
| Finance | manual ledger/budgets | Банки / валютные котировки later |
| Weather / converter | utility interfaces optional | Providers later |

## 2. Mail domain

Internal entities: MailAccount, MailMessage, MailThread (or thread identifier), MailDraft, MailAttachmentRef, MailSyncState. Message IDs must be provider-aware; imported EML files get import source IDs/hashes. Do not silently duplicate imported messages.

### Planned use cases
- Search imported/connected mailbox.
- Ask AI to summarize messages from specific period and classify.
- Extract due date/task with source message reference.
- Draft a response. **Sending** is an external action requiring separate scope.

### Gmail integration (read/drafts approved 2026-10-29)
Owner approved Gmail reading and draft management. Implemented path uses browser-bound OAuth state + PKCE, encrypted refresh/access tokens, explicit paginated import and explicit draft publication. Sending is unavailable. Incremental mirroring, labels/deletions, attachments, background refresh, retention controls and production OAuth verification remain unfinished. See SELF_HOSTING.md for setup and limitations.

### Offline mail
Cached messages and drafts are available offline; new incoming mail and actual sending require network. Deferred send must never silently execute without the user having granted explicit send permission.

## 3. Telegram bot

### Личные команды (DECIDED 2026-11-01; реализованы в Phase 3)

```text
/start aelys_CODE  # одноразовая привязка владельца
/task <title>     # первая строка title, остальные description
/note <text>      # первая строка title, весь текст markdown_body
/today            # задачи/просрочка/события локального дня, без AI
/busy 18:00 <text> # до ближайшего HH:MM в настроенном timezone
/free             # очистить статус сразу
/help
```

Bot security:
- Enrollment challenge sent through authenticated Aelys UI, exchanged once in Telegram chat.
- Allowlist owner Telegram numeric ID, refuse commands from strangers.
- Validate webhook secret/token and idempotent `update_id`.
- Set anti-spam/rate limits; never print API keys or Mac-only transcript excerpts in Telegram without explicit feature permission.
- Acknowledgment of delayed reminders and retries; recheck if message is sent during temporary network failure.

### AI + automation
Bot can create tasks and request summaries through the same domain tools / Policy Engine. Avoid separate Telegram-specific business logic or direct database writes.

## 4. GitHub and repo tracking

A Project may reference a repo by HTTPS URL/remote and local path known **only on Mac**. Cloud store canonical repo ID/URL if user approves; never store local absolute paths by default. Read commits or associate agent runs after an integration adapter is approved.

## 5. Provider contract

```text
ProviderAdapter:
  capabilities() / auth_status()
  fetch_incremental(cursor)
  execute_write(action, scope, idempotency_key)
  revoke()
```

Not all providers implement writes. Capabilities must be explicit and feature-gated.

## 6. Decision gates

Gmail read/drafts approved by owner 2026-10-29; sending remains unapproved. The UI discloses manual imports and retention of loaded local mail after disconnect. Background sync/retention controls require further design.
Telegram Business incoming read/reply was approved by owner 2026-10-29. Live setup requires the owner’s bot/account connection; one bot serves personal commands and Business with one poller (ADR-027). Additional notification categories remain OPEN.
Before any bank connections: separate security and data sensitivity review.

### Telegram Business / Secretary Mode (owner approved 2026-10-29)

Owner requested a bot that reads incoming business chats and replies automatically
on the connected account's behalf. Implemented in the Phase 3 Telegram adapter
slice: encrypted write-only token, single-owner deep-link binding, local Bot API
long polling with durable cursor/receipts/lease, BusinessConnection ownership and
fresh `can_reply` checks, scoped AI generation and policy-checked sends. The owner
selects the allowed chats in Telegram, configures a BYOK provider/persona in Aelys,
and enables automatic replies explicitly. Draft/manual reply remains available.

This is a Business/Secretary bot, not an unrestricted personal-account client.
Customers cannot access owner Notes/Tasks/Mail/Finance or Mac tools. Only private
plain-text incoming messages are handled; unsupported media, forwarded messages
and bot echoes are ignored. No campaigns, proactive messages or Telegram Stars/
profile/gift operations are implemented. The same bot handles explicit owner commands and queued personal AI text.
Telegram reminder delivery, ephemeral personal media and explicit memory are implemented. Opt-in deterministic digest uses configured timezone and a
2-hour window; no catch-up or send retry. Secretary uses reply/no_reply/handoff,
waits reply_delay_seconds (default 90), then considers only the newest inbound in
each chat. Handoff persists an encrypted owner_note and a content-free Notification.
Personal confirmations are sent only after receipt/cursor commit and never replayed.

See [TELEGRAM_BUSINESS.md](TELEGRAM_BUSINESS.md) for actual setup and retention.
A real token, connected Telegram account and configured AI key are still required
for live acceptance; automated tests do not substitute for that external check.


### Personal reminders — Stage 2, 2026-11-01

`/remind 18:00 text`, `/remind YYYY-MM-DD HH:MM text`, `/remind 2h text`
use the owner's timezone. They create a task and one Telegram reminder. Invalid
or explicit past times return an example. Deadline reminders are opt-in (5h and
10m before an unfinished task's due_at). Quiet hours delay every reminder until
the end of the window, including urgent ones. The same connector worker claims
and commits before delivery; fallback Notification survives failure, no retries.
The deterministic evening digest adds tomorrow, while /today stays unchanged.


### Personal text dialogue — Stage 3, 2026-11-01

Verified private owner text is queued encrypted with receipt/cursor. The same
connector supervises one bounded asynchronous turn per integration, leaving
polling/reminders available. Existing AIConversation/AIRun/router/usage and the
shared typed tool loop are reused. `/new` starts another conversation; history
is <=20 turns. Explicit owner action scopes, versioned Task CAS, UntrustedData
quotes, terminal restart recovery and plain <=4096 reply chunks are enforced.
No secretary access to these personal tools. Live credentials remain untested.

### Personal ephemeral media — Stage 4, 2026-11-01

Verified-owner voice/audio, photo, PDF and UTF-8 text now enter the same encrypted
queue. getFile and bounded in-memory download run only during processing. No
stored bytes or task/note attachments. Voice uses a separate transcription BYOK
key and a durably reserved, user-configured budget estimate. File turns have no
tools; only a later owner text can authorize creation. Model capability settings
and transcription configuration use the existing AI & models form. Secretary
media and personal-memory access remain excluded. Real audio/vision providers
and live Telegram have not been tested.

### Explicit owner memory — Stage 5, 2026-11-01

Memory now uses encrypted backend facts with explicit save/forget commands and
owner-only versioned API/settings. The personal text/voice registry gets separate
remember/forget scopes only from the current owner request. Lexical selection
adds at most 10 active facts as data, with no extractor or embeddings. Revoked
fact provenance also removes derived context before each provider step. Business
secretary never reads personal memory. Export/restore and key rotation include
memory; live external-provider acceptance is still outstanding.

### Task matrix/work dates — Stage 6

Existing TasksView adds a matrix using priority >=2 and an exact rolling 48-hour
UTC deadline boundary. Current row actions and filters are reused. Server-owned
start/completion timestamps and immutable transition metadata use the common
writer, preserving domain/sync versions across REST, AI and device pushes.
The Telegram digest adds stagnant in-progress work older than seven elapsed days;
/today remains unchanged. Final acceptance is recorded in the implementation report.

## Google Calendar readonly import (ADR-028, Stage 7)

`domains/google_calendar_oauth.py` reuses Gmail's extracted PKCE and one-use,
owner/session-bound state checks (`google_oauth.py`) and the encrypted backend
secret store. Gmail and Calendar have separate state cookies, token records,
connections and callbacks. Calendar requests only `calendar.readonly` and rejects
broader token scopes. The Google OAuth app client ID/secret settings are shared;
register `AELYS_CALENDAR_REDIRECT_URI` as an additional callback. Server setup is
shown in `backend/.env.example`. The browser receives only status and a consent URL.

Settings → Google Calendar offers Connect, Import now, Reconnect and Disconnect.
One primary calendar per owner. The existing sequential connector worker imports
at most once per 15-minute interval, independently of any Telegram connection.
A durable lease coordinates manual imports and multiple workers. Requests only
read Google events; local events are never exported. Pagination uses stable
`singleEvents=false`, `showDeleted=true` parameters. The sync cursor is encrypted
at rest; page tokens exist only in backend memory during the bounded fetch. A 410 discards the expired cursor and builds a new complete
snapshot; local reconciliation and the replacement cursor commit together only
after all pages succeed. Fetches are bounded at 100 pages / 10,000 items.

Imported CalendarEvent rows use a connection-specific external_source and Google
external_id, unique as a pair. Recurrence metadata retains RRULE/EXRULE/RDATE/EXDATE,
original instance starts and override relationships. Bounded occurrence projection
handles DST, all-day spans, moved/cancelled instances and series cancellation for
Calendar, /today and personal calendar reads. Imported edits/deletes return 409
`EXTERNAL_EVENT_READ_ONLY` through REST and device sync. They produce ordinary
versioned domain sync changes, including tombstones on cancellation/disconnect.
Disconnect clears credentials/cursor and removes imported local projections;
it does not change Google. Encrypted owner exports omit these regenerable Google
projections and their reminders together with connection state/credentials; reconnect
and import them after restore. Local events remain exportable. OAuth, revocation and actual imported calendars require
owner credentials for live acceptance and are not claimed as live-tested.

Protocol reference: [Google incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync)
and [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
