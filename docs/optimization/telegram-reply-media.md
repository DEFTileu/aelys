# Optional Telegram replies and private media viewing

Milestone: Phase 3 / Telegram commands and verified binding. Owner request:
ordinary text by default, selectable Reply in the Messages UI, received photo and
audio display. Extends codex/telegram-chat-compose; does not modify dirty main.

The old secretary send passed reply_to_message_id unconditionally. It now omits
that parameter. Manual chat sends accept an explicitly selected same-chat remote
message ID, validate ownership/source/deletion, bind it into receipt idempotency,
and store the confirmed quote reference. No new chat initiation or permissions.

Business photos/voice/audio are ingested as encrypted metadata and optional caption,
never bytes. An authenticated owner endpoint retrieves bounded bytes through the
existing policy and Telegram transport, validates signatures, and checks current
message/connection authority again after I/O. No-store, nosniff and sandbox headers;
no file IDs, token URLs or filenames in public descriptors. Existing 7-day TTL,
delete/disconnect and encryption-key rotation cover metadata. The browser loads
media only on request, uses native image/audio controls and revokes object URLs.

Migrations: 0036 adds nullable media_metadata / reply_to_telegram_message_id to
Business messages. No external SDK, queue, storage vendor, attachment storage,
AI/media analysis or new scheduler. Tests first reproduced forced reply behavior,
missing media metadata/API/UI, then exercised selected/foreign reply targets,
key conflicts, bounded downloads, unsafe signatures, deletion/disconnect during
I/O, captions, stale automatic-reply suppression, key rotation, UTC and upgrades.
Previously valid legacy owner/cust media tests were updated to the now approved
caption/viewing behavior; bot echoes/forwards remain excluded.

Real browser acceptance uses a synthetic local Business connection and offline
Telegram transport. No actual Telegram/model request or user-contact send. The
stand is 5183/8013, login 1/1; 5173/5182 and other worktrees remain unchanged.
Validation and commit evidence will be appended after the final run.

## Validation

- Full backend `make test` with fresh PostgreSQL migration DB and disposable
  PostgreSQL contracts: **986 passed, 2 skipped, 1 warning in 212.24s**. The two
  global mounted PostgreSQL contracts were run separately on a fresh migrated
  database: **2 passed in 1.26s**. Warning is existing Starlette/httpx deprecation.
- Combined Telegram reply/media/legacy Business/manual/rotation/migration tests:
  **106 passed in 20.93s**. Actual old-schema 0035->0036 upgrade/downgrade and
  previous 0034 upgrade: **2 passed in 8.67s**. Empty/incremental migration
  SQLite/PostgreSQL coverage also ran inside full make test; check has no drift,
  one head `0036_telegram_reply_media`.
- Web typecheck, **503 tests / 64 files**, production build passed. Focused
  Messages/media UI: **26 passed**. Shared typecheck / **43 tests** passed.
  Ruff, mypy (**94 source files**), Bandit, compileall passed; no new dependency.
  OpenAPI regenerated and checked against the mounted application.
- Browser: actual authenticated requests to the local test backend. A 2103x748
  photo loaded as a blob; a 1-second audio fixture reached currentTime>0 with
  native controls and autoplay=false. A selected photo reply returned 200 and
  rendered the quote with its ordinary text. Desktop had no horizontal overflow;
  mobile dark/reduced-motion checked separately. Files are fixture data, not user
  Telegram downloads; no real Telegram/model call is claimed.
- Browser caught a real integration issue: the existing page CSP allowed blob
  images but blocked blob audio. Added `media-src 'self' blob:` to the web page,
  then actual audio playback succeeded. No remote media origins, script policy,
  CLI sandbox or auth permission was broadened. One wait selector was corrected
  because quoted text and the reply body share the same bubble; the API send had
  already succeeded, so no duplicate request was issued.

Only newly ingested supported media has retained metadata. Old media discarded
by earlier versions cannot be reconstructed through this connector. Protected/
unsupported formats and expired Telegram files can still require opening Telegram.
This slice is web Messages viewing and explicit text replies; it does not claim
native transport media support, media upload/send or Business AI media processing.
Other worktrees and live 5173/5182 services remain unchanged. Main integration
is separate because the original checkout contains unrelated staged changes.
