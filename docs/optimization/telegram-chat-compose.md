# Telegram manual chat composition

Task: Phase 3 / Telegram commands and verified binding, manual Business messaging.
Owner request 2026-11-01: allow several typed messages in an open chat; retain the
composer when unavailable, disable Send. Uses existing Messages design.

Assumptions: existing verified private Business chats only; last incoming <=24h,
can_reply and Policy Engine remain required. No general Telegram client, arbitrary
contacts, attachment sending, new scheduler or credential scope. Unrelated main
checkout contains staged work including deletion of MessagesView; it is preserved.
Implementation isolated on codex/telegram-chat-compose from main 051791f. No push.

Implementation: telegram_chat.py, GET chats availability, POST chats/send, shared
API types, Messages composer/expiry/accessibility/keyboard gating and native button.
The old reply endpoint remains intact for secretary drafts. Migration 0035 adds
content-free durable receipts with owner/key uniqueness and HMAC request binding;
canonical sent text uses the existing encrypted owner-direction message row.
An independent durable receipt is necessary because one inbound record cannot
represent several idempotent manual operations without overwriting reply history.
Receipts are excluded from exports; disconnect purges them. No secret rotation
changes: new receipts contain no encrypted content or token.

Red tests reproduced unavailable endpoints and missing UTC output. Additional
regressions cover consecutive sends, unchanged secretary state, idempotency,
concurrent SQLite/PostgreSQL claims, failed/unknown no replay, fresh permission
revocation, expired window/pause, policy denial, restart recovery, echo deduplication,
disconnect during I/O, actual 0034 upgrade/downgrade preservation, editable disabled
composer, exact expiry, double click, pending draft preservation and offline/cache
restrictions. Browser verification uses actual HTTP/database code and an explicitly
synthetic Telegram transport; no credentials or real external sends.

Validation results are recorded below after the final run.

## Local validation

- Full `make test` with fresh PostgreSQL migration DB and disposable PostgreSQL
  AI/Calendar/Telegram contracts: **962 passed, 2 skipped, 1 warning, 243.16s**.
  Two global mounted PostgreSQL contracts ran separately: **2 passed, 1.39s**.
  Final UTC/unconfigured/migration additions: **19 passed, 8.33s** (includes
  actual 0034 schema upgrade/downgrade and preserved owner). The full suite's
  count predates those last three added regressions; it is not a second full run.
- New same-key concurrent receipt proof on actual SQLite and PostgreSQL plus
  manual send regressions: **18 passed, 16.17s**. Existing Telegram Business/
  personal-command combined regression: **103 passed, 24.27s** before the last
  extra UTC/unconfigured tests. No real Telegram HTTP is involved.
- Shared typecheck + **38 tests**; web typecheck + **495 tests / 63 files** and
  production build passed. Focused Messages suite **18 passed**. Ruff, mypy
  (**93 source files**), Bandit and compileall passed. OpenAPI regenerated.
- SQLite and PostgreSQL Alembic check passed; one head 0035_telegram_chat_sends.
  Empty/incremental migration tests covered both backends in full make test.
- Real browser on isolated 5183/8013 with synthetic local data and an explicitly
  offline fake Telegram transport: two successive typed sends after an existing
  sent reply both returned new canonical owner messages, each shown once. Closed
  window kept an editable input but disabled native Send, with an inline reason.
  Verified desktop, dark mobile 375px, landscape and reduced-motion; no horizontal
  overflow and a 44px Send target. Screenshots inspected. One retry was needed
  after resizing had already opened the mobile chat; no forced click was used.
- SQLite UTC serialization first reproduced a timezone-less wire timestamp;
  MessageOut now explicitly restores UTC, preventing a shifted countdown.

No actual Telegram delivery, token/account permissions or live Business acceptance
is claimed. No messages were sent to the user's contacts. Existing 5173/5182
services and the dirty main checkout were left unchanged. Preview 5183 is a
synthetic test stand, not the owner's real Telegram connection. No push or PR.
