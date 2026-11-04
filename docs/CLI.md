# Aelys macOS CLI

The signed Mac application includes a CLI. Install `scripts/aelys` in a directory
on your PATH, or invoke it from the checkout. It uses
`$HOME/Applications/Aelys.app`; set `AELYS_APP_PATH` for another installed bundle.

```sh
scripts/aelys --help
scripts/aelys --origin https://your-backend.example status
scripts/aelys --origin https://your-backend.example unlock
scripts/aelys --origin https://your-backend.example import /absolute/path/batch.json
scripts/aelys --origin https://your-backend.example import /absolute/path/batch.json --apply
```

Sign in/enroll this Mac in Aelys first. Authenticated commands honor the existing
Touch ID policy before reading Keychain. Device-key challenge/login creates an
independent temporary session, revoked on exit. Legacy password sign-ins use the
existing single-use refresh flow and durably replace the saved Keychain session;
that replacement remains available for the next GUI/CLI launch. A native OS file
lock excludes simultaneous GUI/CLI authentication (`CLOSE_AELYS_FIRST`). Close the
GUI before authenticated CLI commands. Locks release on exit/crash automatically.
An ambiguous legacy refresh failure follows the existing fail-closed policy and
may require signing in again; pending import operations remain in the outbox.
After a signed-app update, macOS may return `KEYCHAIN_ACCESS_REQUIRED`. Run
`unlock` for the existing Aelys item, or append `--unlock-keychain` after `--apply`
to unlock and import with one biometric check. Only these explicit recovery
actions permit the standard OS Keychain dialog; normal commands fail closed.
Enter any requested Mac password only into that system dialog. This uses the
same scoped recovery as the GUI and restores background interaction suppression.

Session passwords and bearer tokens are never accepted as command arguments or
printed. Provider/integration secrets use pipe-only stdin as described below.
The `api` command is limited to the existing native allowlist; it accepts no
arbitrary URL or credential headers. JSON status includes counts and account IDs
without mail content.

`import` defaults to a **local preview**: bounded schema/date validation, operation
counts and content digest; no network, Keychain or writes. Server-owned references,
recurrence and timezone rules receive their normal API validation during apply.
Input is at most 2 MB, with at most 200 combined events/mail-sync operations.

```json
{
  "version": 1,
  "events": [
    {
      "title": "Example lecture",
      "description": "Room A101",
      "starts_at": "2026-11-05T05:30:00Z",
      "ends_at": "2026-11-05T06:20:00Z",
      "timezone": "Asia/Almaty",
      "rrule": "FREQ=WEEKLY;BYDAY=TH;UNTIL=20261218T185959Z"
    }
  ],
  "mail_sync": []
}
```

All event fields follow `CalendarEventInput` / `POST /api/v1/calendar/events`.
Dates must be RFC3339 with an offset; `timezone` controls recurrence. Optional
fields include `all_day`, `project_id`, `linked_task_id`, and `reminder_at`.
`mail_sync` lists existing Gmail account IDs for explicit read/import, never send.

Apply saves the complete batch to `batch.json.aelys-outbox.json` (mode 0600,
fsync + atomic rename) before server mutations. Each successful operation is
checkpointed before the next. Retain this file and rerun the same command after
an interruption. Owner, origin and content digest must match. Changed input needs
a new file path; finished outboxes are retained as local receipts. Keep input and
outbox private and outside Git. Authentication secrets are never stored in them.

Calendar writes use stable owner/content-derived idempotency keys. Existing local
series with matching title, start/end instants, timezone, recurrence, all-day and
links are skipped, including series previously entered in the UI. Descriptions
are not part of that match and existing descriptions are preserved. Multiple
matching existing series stop the import for manual resolution. Google-imported
series are never treated as local duplicates or modified. Gmail retries use the
provider's existing stable message IDs. The batch stops at the first error;
completed operations stay committed and the pending local plan stays available.

A sibling `.aelys-lock` prevents simultaneous imports of the same file. After an
actual crash, verify that no import process remains before removing a stale lock.
No automatic lock expiry, credential export, background unlock, arbitrary shell,
server deployment, Google Calendar write or unrestricted HTTP route is provided.

Scope: IMPLEMENTATION_PLAN Phase 3 / task 1, owner-requested calendar population
and repeatable import, with explicit existing Mail sync as a batch operation.
The CLI outbox is a local import queue; it does not edit the web client's IndexedDB.

Validation: native library tests 55 passed / 2 interactive Keychain checks ignored;
strict Clippy passed; mobile host cargo check and signed Mac release build passed.
Regression coverage includes non-mutating preview, input bounds, equivalent-offset
duplicate detection, imported-series exclusion, durable checkpoints, ambiguous
POST retry keys, owner/content conflicts, concurrent imports and symlink refusal.
Live import and installed-app acceptance are recorded separately after execution.
Additional regression checks cover cross-process session exclusion/release and
legacy refresh replacement without revoking the saved sign-in.


## Commands for every existing server module

The CLI now exposes all 58 typed native operations and the 76 explicit domain
API routes used by the app. This covers Projects, Tasks, Notes/revisions,
Calendar/reminders, Finance, Focus, Mail/drafts, AI/providers/memory/actions,
Knowledge/search, Activity/notifications, Telegram, Automations and the existing
bounded agent operations. CLI-only operations list/revoke devices and start the
validated Gmail/Calendar browser handoff. `aelys operations` prints the complete
JSON catalogue, with synthetic examples for every typed operation and the API
route patterns. It runs offline and does not read Keychain.

```sh
aelys operations
aelys --origin https://your-backend.example tasks list
aelys --origin https://your-backend.example notes get NOTE_ID
aelys --origin https://your-backend.example projects list
aelys --origin https://your-backend.example finance summary
aelys --origin https://your-backend.example ai providers
aelys --origin https://your-backend.example devices list
aelys --origin https://your-backend.example notes create /private/note.json
aelys --origin https://your-backend.example notes create /private/note.json --apply
```

`note.json` is an ordinary typed body, for example
`{"title":"Semester","markdown_body":"Weekly plan","tags":["study"]}`.
The `create` shortcut also works for tasks, projects, calendar events, focus
sessions, mail drafts, AI conversations and automations. The catalogue provides
full update/delete/other operations, executed without any UI:

```json
{
  "type": "note_patch",
  "id": "NOTE_ID",
  "version": 1,
  "note": {"title": "Semester", "markdown_body": "Updated plan"}
}
```

```sh
aelys --origin https://your-backend.example exec /private/update-note.json
aelys --origin https://your-backend.example exec /private/update-note.json --apply
```

Reads execute immediately. Commands with mutations default to a local preview
(type, method and bounded path, without the request body); `--apply` sends them.
A versioned server update still needs the actual current version. Decimal finance
amounts must be strings such as `"1250.50"`; numeric JSON amounts are refused.
The server continues validating ownership, references, versions, external-event
read-only restrictions and policy. CLI access grants no extra server permissions.

Use `api METHOD /api/v1/PATH --body FILE --query FILE` for the catalogue's generic
API routes. Query JSON is a string-to-string object. Paths must exactly match the
allowlist, with valid IDs; full URLs, path traversal, auth/enrollment/pairing/sync
and credential-lease endpoints are refused. Credential query parameters are
refused. Explicit reads return domain data as JSON, including requested mail,
notes and search results: treat redirected output as personal data.

## Durable operation batches and receipts

```json
{
  "version": 2,
  "operations": [
    {"type":"task_create","task":{"title":"Prepare weekly review"}},
    {"type":"note_create","note":{"title":"Review","markdown_body":"Notes"}}
  ]
}
```

```sh
aelys --origin https://your-backend.example batch /private/work.json
aelys --origin https://your-backend.example batch /private/work.json --apply
aelys --origin https://your-backend.example receipt /private/work.json.aelys-operations.json
```

A private, atomically fsynced `FILE.aelys-operations.json` stores the complete
non-secret operation plan before domain mutations, plus per-operation progress
and sanitized results. Same-origin/owner/input checks and a sibling lock prevent
cross-account reuse and simultaneous runs. Successful entries are skipped when
the same command is rerun; pending entries continue. Limits: 2 MB input, 200
operations, 16 MB receipt. There is no claim that the server supports idempotency
on every route: if a mutation loses its response or its outcome is otherwise
uncertain, the receipt blocks replay and leaves later operations pending.

Check the server's current state first. **Only after establishing that the
operation did not happen**, explicitly reset that zero-based receipt entry:

```sh
aelys --origin https://your-backend.example receipt /private/work.json.aelys-operations.json --retry 0 --confirmed-not-applied
```

This is an owner assertion, not an automatic deduplication check. An interrupted
read may safely retry. Completed operations retain their original result; to
perform a deliberate new action, use a new input/receipt file. Do not put private
plans or receipts in Git. Stale sibling locks require checking the original
process has exited before removal. The original version-1 timetable `import`
format and receipts remain supported unchanged.

## Secrets, integrations and devices

Input containing provider keys, bot tokens or other credential fields is
accepted **only from piped stdin** (`exec -`, `batch -`, or `api ... --body -`),
never through CLI argument values. Interactive stdin is refused so a pasted key
cannot echo in the terminal. A private explicit `--receipt PATH` is required for
stdin mutations. Use a password manager or equivalent local process to supply
JSON; do not embed a real key in a shell command or shell history.

Secrets are sent only over the authenticated, validated backend route. Their
values are omitted from preview, receipt and returned JSON, including nested
credential fields and echoed input-secret strings. Secret-bearing commands are
single-attempt: another key change requires a new receipt. Secrets are never
returned to the renderer or saved in the CLI outbox. Existing backend encryption
and policy checks remain authoritative.

```sh
aelys --origin https://your-backend.example connect gmail --receipt /private/gmail-connect.json --apply
aelys --origin https://your-backend.example connect calendar --receipt /private/calendar-connect.json --apply
aelys --origin https://your-backend.example devices revoke DEVICE_ID --receipt /private/revoke-device.json --apply
```

Google consent still happens in the browser. The CLI obtains the existing
short-lived one-use ticket, validates the selected-backend URL/provider path,
and opens only that URL via a fixed OS executable; the ticket is never printed
or persisted. Listing devices is read-only. Revocation uses the existing
owner-scoped backend endpoint and can invalidate the current device if selected.
Enrollment/recovery/private-key export are not generic CLI commands.

## What authentication establishes

Keychain stores the enrolled device identity or legacy rotating session. If its
existing Touch ID policy is enabled, authentication happens before any secret
read; disabling that policy in Aelys removes the biometric step but not server
checks or Keychain protection. The user chose to disable it on 2026-11-04.
Device login signs a fresh, expiring, one-use backend challenge; the backend
checks the enrolled public key and refuses revoked devices/replayed challenges.
Legacy login rotates the saved refresh credential once and persists its
replacement. HTTPS certificate validation and redirect refusal are retained.

Each domain request presents the short-lived access token in memory. Backend
`current_principal` checks its signature, expiry/type, existing owner, live session
and active owner-bound device; resource handlers then enforce owner/policy/version
checks. Knowing an origin, owner ID or device ID is insufficient. A token already
issued to a device remains a bearer credential until expiry/revocation; the device
does not sign every domain request.

This identifies the **owner/device**, not the human or agent typing each command.
A local process that can invoke the signed binary and is allowed by macOS to use
its saved identity acts with the owner's authority. The CLI adds no remote
listener, static global API key or new permission bypass. `--apply` is protection
against accidental command execution, not an authorization boundary against a
local process. A sandboxed/limited agent still needs its existing project grant;
this CLI does not validate isolation or lift the runtime's fail-closed gates.

## Scope and limits

This is transport parity for the existing owner-domain API, not a new backend
feature set. Mail sending and Google Calendar writes remain unavailable. Local
appearance/layout preferences, client-only tools, OS notifications and full raw
Mac agent-history indexing are outside this server API. `settings show` reports
the signed-in profile; provider and Telegram settings use their documented API
operations. CLI authentication still requires closing the GUI because legacy
credentials must not rotate in two processes. No new migrations or backend
service changes are needed.

Implementation task: IMPLEMENTATION_PLAN Phase 1 / task 3, extending the existing
authenticated device transport with a CLI surface and bounded error/output
handling. Tests cover every catalogue example, aliases, allowlist/secret/decimal
validation, checkpoint/resume, blocked uncertain replay, owner/input conflicts,
receipt permissions and explicit recovery. Server native/device/browser auth
suites independently exercise login, rotation, challenge replay and revocation.
