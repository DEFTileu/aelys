# Aelys macOS CLI

The signed Mac application includes a CLI. Install `scripts/aelys` in a directory
on your PATH, or invoke it from the checkout. It uses
`$HOME/Applications/Aelys.app`; set `AELYS_APP_PATH` for another installed bundle.

```sh
scripts/aelys --help
scripts/aelys --origin https://your-backend.example status
scripts/aelys --origin https://your-backend.example import /absolute/path/batch.json
scripts/aelys --origin https://your-backend.example import /absolute/path/batch.json --apply
```

Sign in/enroll this Mac in Aelys first. Authenticated commands honor the existing
Touch ID policy before reading Keychain. Device-key challenge/login creates an
independent temporary session, revoked on exit; the GUI session is left intact.
No password, bearer token, provider key or raw request option is accepted or
printed. JSON status includes counts and account IDs, without mail content.

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
server deployment, Google Calendar write or generic HTTP route is provided.

Scope: IMPLEMENTATION_PLAN Phase 3 / task 1, owner-requested calendar population
and repeatable import, with explicit existing Mail sync as a batch operation.
The CLI outbox is a local import queue; it does not edit the web client's IndexedDB.

Validation: native library tests 53 passed / 2 interactive Keychain checks ignored;
strict Clippy passed; mobile host cargo check and signed Mac release build passed.
Regression coverage includes non-mutating preview, input bounds, equivalent-offset
duplicate detection, imported-series exclusion, durable checkpoints, ambiguous
POST retry keys, owner/content conflicts, concurrent imports and symlink refusal.
Live import and installed-app acceptance are recorded separately after execution.
