# Provider HTTP stream cancellation and polling

Historical first slice. Header/POST cancellation and SQLite SSE transaction
follow-through are now implemented; see [current evidence](provider-io-cancellation.md).

2026-10-30. Task: IMPLEMENTATION_PLAN Phase 4, task 5 (cancellation), within
the active cross-platform optimization goal. Internal transport change only;
no API/schema/migration/permission or product decision.

## Reproduced failures

Three new loopback HTTP tests failed against the previous implementation:

1. Local cancellation with a still-false durable status check exceeded the
   one-second completion bound. The branch cancelled the line read but awaited
   an uncancelled durable poller indefinitely.
2. Cancelling the outer consumer left line/event/durable helper tasks pending.
   `asyncio.wait` did not cancel or join its children when its caller exited.
3. Twenty buffered SSE frames invoked the durable check **41 times**. Every
   data/blank line restarted a poller that immediately ran its callback.

## Change

Each line wait now cancels and joins all helper tasks in `finally`, including
local/durable cancellation, outer request cancellation, normal EOF, error and
generator close. Cleanup completes before yielding to the caller, so a durable
callback does not remain active while the caller uses the same SQLAlchemy
session. A failed durable check raises a generic transport failure instead of
being silently treated as a successful end of the stream.

The 250 ms polling cadence is retained across helper restarts. The same
twenty-frame test now records **one** durable callback. This is a count of the
transport's callback invocations on synthetic loopback traffic, not total SQL
queries for an AI run or a live-provider performance benchmark. Execution/API
authorization and cancellation checks outside the transport are unchanged.

## Verification

- Initial new regression run: **3 failed**, reproducing the failures above.
- `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests --junitxml=/tmp/aelys-backend-ai-transport-20261030.xml -o junit_family=xunit1`:
  **172 passed, 3 skipped**, one existing Starlette/httpx deprecation warning.
  Six HTTP regressions cover local and durable cancellation, outer cancellation,
  callback cadence, redacted check failure and closing a generator after a
  partial read. Tests verify the server sees the connection close and helpers
  are done. No real provider credentials or external requests were used.
  JUnit properties record `sse_frames=20`, `durable_checks=1`.
- `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`:
  passed, all 65 application source files.
- `.venv/bin/ruff check --select E9,F backend/app backend/tests`: passed.
- `.venv/bin/ruff check backend/tests/ai_automation/test_http_transport_cancellation.py`:
  passed. Unfiltered application Ruff still reports **497** findings and is
  explicitly not a passing repository-wide gate.
- `.venv/bin/bandit -q -r backend/app -ll`: passed.
- Current generated OpenAPI dictionary exactly matches `docs/openapi.json`.
- `git diff --check`: passed.

After validation, the task-created backend was gracefully restarted with its
original arguments, environment and existing database, without printing secrets
or rotating credentials. New PID **1128**, cwd `backend`, database
`backend/aelys.db`, listener `127.0.0.1:8000`. Direct health and the Vite proxies
on **5173/5174** all returned `{"status":"ok"}`. The old PID 33756 exited before
replacement; no forced termination or unrelated service change was performed.

This slice covers streaming reads after provider headers have arrived. Cancelling
pending provider headers and non-streaming completion POSTs still requires a
separate transport change and tests. Credentialed providers, native Keychain
restart/sleep-wake and actual Android SDK/device/APK gates remain unverified.
No frontend/shared/Rust sources changed, so their previous evidence was not
repeated or used to claim new platform coverage. No commits or publication.
