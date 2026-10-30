# Provider cancellation across HTTP stages and durable SSE delivery

The AI API cancellation/revocation and send-boundary state checks have since
also passed on fresh migrated PostgreSQL databases; see
[PostgreSQL AI contracts](postgres-ai-contracts.md). Counts below retain the
original SQLite-slice evidence.

2026-10-30. Scope: IMPLEMENTATION_PLAN Phase 4 task 5, cancellation. Continues
the preceding provider stream cleanup. No API schema, migration, owner decision,
provider permission or frontend/native source change.

## Reproduced problems

Six new loopback tests initially exceeded the one-second cancellation bound:
local or durable cancellation while streaming headers were pending, while
completion POST headers were pending, and while a completion body was pending.
Previously, cancellation helpers existed only after streaming headers arrived;
ordinary POSTs waited for their full response regardless of cancellation.

Strengthening the API revocation test exposed another failure: the stream held
an uncommitted SQLite event write while waiting for the provider. Logout then
failed with `database is locked`. The old test could observe the preceding
run's transport, falsely accepting revocation before the new request began.

## Implementation

- `app/ai/http_transport.py` now owns the typed transport; `api.HttpxTransport`
  still references it for existing injection sites. A shared cancellation wait
  wraps streaming header reads, individual SSE lines and the whole completion
  POST, including its body. Already-cancelled local/durable runs are checked
  before issuing provider HTTP requests.
- Each wait cancels and joins its I/O/event/status tasks before returning,
  raising or yielding. The 250 ms durable-check cadence survives wait boundaries;
  callbacks do not keep using the API DB session during event persistence.
  Existing timeouts, redirect/TLS settings and provider URL policy remain.
- Completion cancellation propagates as `RunCancelled` through provider adapters.
  The API resets the read transaction, conditionally persists cancellation and
  emits `ai.run.cancelled`. It cannot turn a local signal arriving before the
  cancel endpoint's commit into a failed run or a tool execution.
- Intermediate SSE events commit before delivery and the next provider wait,
  releasing SQLite's writer lock. Completed/failed events are deferred until
  their final run state is persisted in the same transaction, then delivered.
  Cancellation status never changes back to completed/failed.
- API tests now wait for the current transport and simulate its real durable
  cancellation callback, covering active revocation for both stream and tool
  completion modes. A separate-connection observer checks terminal event and
  run state at the actual ASGI send boundary, rather than after response EOF.

## Verification

- Initial targeted run: **6 failed**, reproducing missing header/POST cancellation.
- Strengthened active-stream revocation reproduced SQLite writer blocking;
  the corrected transaction boundaries pass the same case.
- `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests --junitxml=/tmp/aelys-provider-io-cancellation-20261030.xml -o junit_family=xunit1`:
  **191 passed, 3 skipped**, one existing Starlette/httpx warning. The transport
  file contains 22 real loopback HTTP cases: local/durable/pre-cancellation,
  consumer cancellation across headers/body/SSE, successful JSON completion,
  malformed event shapes, error cleanup and generator close. API tests cover
  both generation modes, cancellation, active session revocation and terminal
  persistence before delivery. No real provider account/credentials were used.
- The twenty-frame transport test still records **one durable callback**;
  the earlier implementation recorded 41. This excludes cancellation checks
  performed separately by execution/API code and is not a total SQL count.
- Mypy with `--explicit-package-bases --ignore-missing-imports --check-untyped-defs`:
  passed for **66 application source files**.
- Fatal Ruff (`--select E9,F`) over backend app/tests: passed. Unfiltered Ruff
  passes for the new transport and all three touched test files; the full
  application still reports **497** findings and is not a clean lint gate.
- Full Bandit (`.venv/bin/bandit -q -r backend/app -ll`): passed.
- Generated OpenAPI exactly matches the checked-in dictionary; no contract regeneration.
- `git diff --check`: passed.

The task-created backend was gracefully restarted after validation, reusing its
original environment and existing `backend/aelys.db` without disclosing values
or rotating secrets. Old PID 1128 completed shutdown; new PID **17334** serves
`127.0.0.1:8000`. Direct health and both Vite proxies **5173/5174** returned OK.
No personal records were created by these tests, no external messages were
sent, and no unrelated process was stopped. No staging/commits/publication.

This evidence combines real loopback transport tests and isolated API/SQLite
tests with injected provider responses. Credentialed provider execution,
native Keychain restart/sleep-wake, and the actual Android SDK/device/APK gates
remain unverified. Other PostgreSQL evidence is scoped to its existing tests;
this slice does not claim PostgreSQL AI transaction/concurrency acceptance.
