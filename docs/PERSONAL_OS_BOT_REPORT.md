# Personal OS bot — implementation and acceptance report

Date: 2026-11-01. Milestone: Phase 3, Telegram commands and verified binding.
Branch: `feat/personal-os-bot`, isolated worktree from local main `40f822e`.
Owner instructions require stages 0–7 in order, each validated and committed
before the next begins. This report is an in-progress ledger, not acceptance.
No push, PR, main modification, Railway deployment or MySDU modification.

## Owner decisions and scope

Approved on 2026-11-01: unified domain sync change-log; Telegram reminders and
quiet hours; personal AI dialogue; ephemeral voice/photo/PDF/text processing;
explicit encrypted lexical memory; task matrix/work timestamps; Google Calendar
read-only import. Existing AI runtime and Policy Engine are reused.

No MCP, RAG, embeddings, document search, attachment storage, Business media,
secretary facts beyond /busy, rolling summary, tool shortlist, group chat or
MySDU import. Sheets monitor stays in MySDU. Web UI copy is English; bot owner
replies Russian. Attachments storage remains OPEN. No credentials are assumed.
Business context must never include personal memory/tasks/notes/calendar.

## Stage ledger

| Stage | Status | Evidence / remaining work |
|---|---|---|
| 0 — merge origin/main | Accepted locally | Fetched origin/main `378ecb3`; merging into feature branch. Automation capture and rule drafts retained; contract additions retained; UI resolved by Luna medium; migration regression by Terra medium. Merge revision 0028 joins both heads without changing historical revisions. All CI commands passed locally, details below. |
| 1 — unified change-log | Accepted locally | Shared transactional writer, domain push and compatibility implemented; final backend 375 passed + 2 separately covered PG skips, 52 targeted new contracts. Details below. |
| 2 — reminders/digest | Accepted locally | Claims, quiet hours, /remind, deadline options, tomorrow and browser persistence passed. Final backend 418 passed plus 2 separate PG cases; web 414; shared 36. |
| 3 — personal dialogue | Accepted locally | Encrypted queue, shared loop/usage, current owner scopes, persistent conversation and /new; 552 backend passed, 2 PG cases separately passed. |
| 4 — ephemeral media | Accepted locally | Bounded in-memory download, separate transcription BYOK/budget estimate, image/PDF adapters, no-tool file turns. Backend 731 passed plus 2 PG cases; web 416; shared 36; settings browser persistence verified. |
| 5 — explicit memory | Accepted locally | Encrypted explicit facts, lexical best 10, CAS API/settings, owner commands/tools, provenance-aware forget, export/rotation. Backend 823 passed plus 2 PG cases; web 418; shared 37; browser create/edit/reload/forget verified. |
| 6 — task matrix/time | Not started | Server timestamps/history, matrix and stagnant digest required. |
| 7 — Google Calendar | Not started | Read-only OAuth/PKCE/state, incremental import/disconnect, external event protections required. |

## Validation

New worktree .venv and `pnpm install --frozen-lockfile` completed. The merge
combines local main 40f822e and fetched origin/main 378ecb3 (11/18 divergent
commits). Automation create_task still calls capture and origin's draft/run
endpoints remain. Telegram UI retains manual terminal-decision overrides and
owner-note separation; its UI copy is English (14 focused tests passed).

Stage 0 validation so far:

- shared typecheck/test: passed, 36 tests; web typecheck/test/build: passed,
  410 tests in 53 files; mobile scripts: 5 passed.
- Ruff, mypy (72 source files), Bandit, compile and pip-audit: passed;
  local editable package unavailable on PyPI is the audit's explicit skip.
  Added one missing dict[str, str] annotation in imported finance code for mypy.
- Merge regression: 3 SQLite tests passed. Test fixtures rewind real migrations
  (rather than stamp a current schema) and verify data from both parent heads.
  Independent PostgreSQL upgrades from both branch revisions preserved cursor
  and passed alembic check. PostgreSQL fresh upgrade/check: passed, one head 0028.
- PostgreSQL integration 2 passed; AI SQLite/PostgreSQL contracts 8 passed.
- Runtime tests: 30 unit + 15 contract tests passed, fmt/clippy passed. Cold
  shell-helper startup on this Mac measured 3.747s then 0.030/0.042s warm; original
  2s startup tests failed. Only helper startup/credential-scope-test waiting
  increased to 10s; process-tree termination bounds, 100ms timeout test and
  production sandbox/runner remain unchanged.
- start_local Ruff/mypy passed; tests 19 passed on repeat after CPU-heavy initial
  compilation (initial run had two fixture-start timeouts).
- native-transport fmt/test/clippy passed (33 passed, 2 local hardware probes
  ignored); android-session-store tests passed; desktop/mobile fmt/check passed.
- docker compose config and backend image build passed (local validation tag).
- OpenAPI regenerated from merged app; contains both API additions.

Full backend final rerun: **323 passed, 2 skipped**, one existing Starlette
warning (PostgreSQL-specific cases covered separately above). Desktop release
build passed (`pnpm --filter @aelys/desktop tauri:build`, 3m33s). Stage 0 is
accepted locally. No signing/notarization or installation acceptance is claimed. Initial backend run collected
unfinished merge fixtures and reported 321 passed, 2 fixture failures, 2 skipped;
those fixtures now pass narrowly, and the full run is repeated.

## Live acceptance still required

Real Telegram connection and ownership, real model JSON/tool behaviour,
transcription with a real BYOK endpoint, ephemeral photo/PDF processing with a
capable model, and Google OAuth/import require owner credentials and are not
claimed by offline tests. Local browser settings acceptance is required before
final completion. No later stage or overall goal is accepted yet.


## Stage1 client audit

Audit baseline: immutable Stage 0 merge commit `baa5496`, 2026-11-01.
This section records observed client behaviour and regression evidence, not
Stage 1 implementation acceptance. Later stage/status sections are maintained
by the parent agent.

### Current mounted flow and resource kinds

- `apps/web/src/lib/api.ts::getSharedApiClient()` supplies the shared `ApiClient`
  with authenticated browser fetch or native transport and an IndexedDB store
  partitioned by backend origin and owner (`aelys-shared-v3`). The native host
  uses the same web client through its credential-owning transport.
- Module views read domain REST endpoints: Tasks calls `/tasks`, Notes `/notes`,
  Projects `/projects`, and Calendar `/calendar/occurrences` (with event detail
  and reminder endpoints). They receive domain rows, not `SyncRecord` rows.
  At this baseline, searching application callers found no invocation of
  `syncPush`, `syncPull`, `syncBootstrap`, `syncAck`, or `syncStatus`; those
  methods are exposed by `packages/shared/src/api-client.ts` for consumers.
  Thus fixing the server change-log alone does not establish a mounted client
  pull/apply/ack loop.
- Shared GET requests cache successful domain responses when a cache key is
  supplied and may use that cache after network/5xx failure. Auth/validation
  errors do not fall back. Mutations go to REST first; transport failure may
  enqueue the original REST request and stable idempotency key. When supplied,
  `offlineEntityKey` and its optimistic value are stored with the outbox entry
  in one IndexedDB transaction (`packages/shared/src/offline.ts`). Project
  creation uses this optional entity path; it is not universal. TasksView
  writes explicitly disable offline queuing, as do calendar methods by default.
- `AuthGate` starts outbox replay after authentication: immediately, on online
  and focus events, and every 30 seconds. Replay reissues the original REST
  requests with their existing idempotency keys, removes successful entries,
  and retains rejected entries for resolution; it does not translate them into
  `/sync/push` operations. Cache invalidation follows successful writes.
- Mounted `/api/v1/sync/push` validates `Operation.resource_kind` against
  `app.sync.api.ALLOWED`: `project`, `note`, `task`, `event`,
  `finance_transaction`, `focus_session`, `mail_message`, `mail_draft`,
  `ai_message`. This is the mounted API allowlist, not every kind mentioned in
  architecture documents or other validators. `calendar_event` is not the wire
  kind; CalendarEvent uses `event`.
- The separate `app.sync.validation.SYNCABLE_RESOURCE_KINDS`/`parse_batch`
  validation path has a broader, different set: additionally `file`, `mail`,
  `ai_chat`, `repository`, `agent_session_index`, and no `ai_message`. The mounted
  Pydantic `Operation` calls only its recursive `validate_patch`, not
  `parse_batch`/`parse_operation`; this broader set does not enable mounted
  push kinds. Shared sync DTOs type `resource_kind` as `string`; the general
  resource-link `ResourceKind` union is a separate contract.
- Mounted pull/bootstrap require a device-bound credential and read
  owner-scoped `SyncChange`. Pull orders by `seq`, returning `next_cursor`;
  bootstrap reads the latest change per `(resource_kind, resource_id)` at a
  fixed snapshot and returns tombstones plus a pull cursor and opaque page
  boundary. Neither enumerates domain tables or `SyncRecord` directly.
  Baseline push separately maintained `SyncRecord` and `SyncChange`; domain
  REST/capture wrote domain tables without this log. PostgreSQL push used
  `pg_advisory_xact_lock(hashtext('sync-owner:' + owner_id))` to serialize an
  owner's allocation/commit order; all new writers must use the same lock.
- REST Project creation is mounted in `app.core.api`, while Project
  update/delete and Task/Note/CalendarEvent CRUD are in `app.domains.api`.
  Task/Note capture is also used by the AI registry and verified Telegram
  personal commands; a shared transactional writer must cover those entry
  points rather than adding client-specific logs.

### Behavioural red evidence before implementation

New `backend/tests/test_domain_sync_log.py` owns an independent disposable
SQLite fixture, real owner bootstrap/device enrollment and ASGI requests. It
imports no fixture from an unregistered test module.

Initial command from the worktree:
`.venv/bin/python -m pytest backend/tests/test_domain_sync_log.py -q`
returned **2 failed in 0.81s**, exit 1. REST task creation returned HTTP 200;
pull returned `changes: []` and bootstrap returned `resources: []`. Both failures
were the explicit missing-resource assertion, not auth/setup/import errors.

To isolate this from concurrent imports in Terra's edits, repeated against
`git archive baa5496 backend` extracted into a temporary directory, copying
only the new regression test into that export. Used the worktree `.venv` Python
with `PYTHONPATH=<export>/backend`, pytest `-o pythonpath=<export>/backend`,
`--rootdir <export>/backend`, and the exported test path. Result: **2 failed in
1.10s**, exit 1, at the same missing-resource assertions after successful HTTP
200 creation and sync reads. Temporary export was removed after the run;
concurrent production files and Git index were untouched.


### Focused contract coverage and post-wiring validation

`backend/tests/test_domain_sync_log.py` now contains 11 cases:

- Two explicit REST-task regressions for pull and bootstrap.
- Parameterized Task, Note, CalendarEvent (`event`) and Project CRUD sequences:
  create/update/delete each reach pull and bootstrap, incremental cursors return
  one matching change per transition, bootstrap exposes the latest tombstone,
  and the domain row, SyncRecord and ordered SyncChange versions agree.
- Task and Note capture rollback checks: require a flushed log row before
  rollback, then verify the domain row, projection and change all disappear
  from a new session and both sync read endpoints remain empty.
- Stale push after a REST server edit returns VERSION_CONFLICT with the actual
  domain version and leaves the server edit and its two log entries intact.
- Telegram `/task` through the real poller/verified-owner ingestion, mocking
  only Telegram transport. The transport checks committed receipt/domain/log
  state from another session before confirmation; replay creates no extra
  task/change. The result appears in both sync read endpoints.
- AI task creation through real provider registration/secret storage,
  conversation, run and events endpoints, with only the provider transport
  mocked. It completes a real authorized create_task call and exposes the
  committed task through pull and bootstrap.

Expanded suite against the same clean `baa5496` export (same isolation command,
with `--tb=short`): **11 failed in 2.45s**, exit 1. Failures established missing
changes for domain/AI/Telegram creation, missing flushed changes before
rollback, and stale push reporting version 0 after a REST edit reached version
2. This extends, rather than replaces, the two initial assertion-only red
reproductions above.

A run while Terra's imports preceded creation of `app.sync.change_log` stopped
at collection with ModuleNotFoundError (exit 2); it is not counted as behavioral
regression evidence. Once the parent provided the writer and capture/core
Project wiring, reran:

`.venv/bin/python -m pytest backend/tests/test_domain_sync_log.py -q --tb=short`

Result: **11 passed in 1.83s**, exit 0. Existing pytest-asyncio warning:
`asyncio_default_fixture_loop_scope` is unset. These are disposable SQLite
integration tests; the parent owns separate PostgreSQL commit-order validation
and full stage acceptance.

`.venv/bin/ruff check backend/tests/test_domain_sync_log.py`: passed after fixing
one import-formatting finding in this new file. No production code, other tests,
Git index or commits were changed by this test/audit sidecar.


## Stage 1 implementation and acceptance

One writer `sync/change_log.py` updates SyncRecord + SyncChange flush-only;
REST uses it before commit in core/api (Project create), domains/api (four-domain
mutations) and capture (Task/Note create, including Telegram/AI/automation).
`sync/domain.py` reuses mounted schemas/reference validation to apply device
patches to real domain rows. One change per version, including note revisions,
restore and delete tombstones. Shared request/response shapes are unchanged.

Pre-upgrade REST rows are indexed before pull/bootstrap through this same writer.
Legacy mirror-only partial updates preserve other fields when materializing the
domain. Equal-version divergence, deletion-state mismatch and newer mirror data
return SYNC_RECONCILIATION_REQUIRED before mutation; no silent overwrite. Legacy
mirror-only deletes preserve tombstones. Stale create cannot resurrect a deletion.
Other allowed kinds keep their existing mirror behavior; they were not promoted.

Regressions written before corresponding fixes: 11 missing-domain-log cases on
clean baa5496; PG missing SyncChange after capture; legacy partial update/reset
and stale create (3 failed); mirror-only delete (1 failed); existing REST row
absent from pull (1 failed). Review by Terra caught pre-mutation divergence and
same-version tombstone mismatch; dedicated regressions cover both. Luna expanded
real HTTP push/REST roundtrips, partial patches, version conflicts/retries,
revision retention, duplicate receipts, exact log counts and foreign references.

Targeted final suite: **52 passed** — 39 domain log contracts, 11 legacy/upgrade
contracts and 2 PostgreSQL concurrency tests. PostgreSQL tests observe ungranted
advisory locks via pg_locks (pg_stat_activity snapshots are cached in observer
transactions), hold one transaction open and verify commit order plus subsequent
cursor pull. One test mixes actual HTTP push with server capture.

Gates already passed for Stage 1: Ruff; mypy 74 files; Bandit; compile; pip-audit;
SQLite and PostgreSQL alembic check; regenerated exact OpenAPI unchanged;
shared typecheck/36 tests; web typecheck/410 tests/build. Native/platform code
unchanged since all Stage 0 gates. Separate PG sync contracts: 2 passed on clean
migrated DB (reusing their previous DB caused test login fallback failure, so a
fresh isolated DB was used rather than altering authentication).
Full backend gate is repeated after final compatibility refinements; earlier
passing counts 369 and 372 are intermediate, not final stage evidence.


Final Stage 1 full command:
`AELYS_TEST_AI_POSTGRES_ADMIN_URL=<loopback-admin> AELYS_TEST_POSTGRES_MIGRATION_URL=<fresh-db> make test`
→ **375 passed, 2 skipped**, 1 existing Starlette warning, 55.01s. The two skips
are separately covered by test_postgres_integration (2 passed). Final Ruff,
mypy, Bandit, compile, OpenAPI and diff checks passed. No migration is needed
for Stage 1; schema head remains 0028. Stage 1 accepted locally; next Stage 2.


## Stage 2 — reminders and digest

Added /remind clock/explicit-date/relative formats (owner timezone) with examples
on invalid/past input. A command creates a Task plus Telegram TaskReminder using
capture + policy checks and receipt transaction. Replayed updates create neither
extra tasks nor schedules. DST gaps skip to next real clock occurrence; folds
choose the next real instant. Future dated nonexistent wall times are rejected.

The existing sequential connector calls `deliver_telegram_reminders`; no new
scheduler. Opt-in deadline_reminders defaults false; stable keys represent due_at
and the 5h/10m offsets. Completed/deleted or rescheduled tasks cancel stale
schedules; other owners and in_app channels are excluded. In-app Task reminders
also deliver via the existing foreground notifications dispatcher; its Calendar
path now explicitly filters in_app so it cannot consume Telegram schedules.

Claims, Calendar next occurrence and content-free fallback Notification commit
before transport. Delivery timeout/crash loses at most a DM and never retries;
Notification survives. Quiet windows apply to urgent reminders and digest,
including same-day/cross-midnight/fold/gap boundaries. Quiet-delayed digest keeps
pending day/time durably through restart; this explicit postponement is distinct
from catching up an offline missed digest window. Its Notification also contains
only generic wording. /today remains unchanged; digest adds tomorrow's tasks/events.

Migration 0029 adds opt-in/quiet fields and pending_digest_on/at; existing settings,
cursor and version survive upgrade. Model false default is a SQL Boolean false,
not a text literal. Settings use existing English controls/shared types.

Test-first: parent command/digest tests **9 failed**; quiet-digest test failed due
to unwanted immediate send; in_app Task test failed due to absent delivery.
Luna UI test-first **4 failed, 14 passed**, then **18 passed**. Terra wrote delivery
suite before module: **22 passed** after implementation. Parent added real
PostgreSQL concurrent delivery proof: one claim/Notification/send, visible from
another DB connection before send. Combined delivery+digest tests **30 passed**.
Other parent command/settings/migration/foreground group **49 passed**.

Stage 2 verification so far: full backend **418 passed, 2 skipped**, one existing
Starlette warning; separately PostgreSQL contracts **2 passed** on a fresh
migrated DB. Web **414 passed** (53 files), shared **36 passed**, typechecks/build
passed. Ruff, mypy 75 files, Bandit/compile, pip-audit, SQLite + PostgreSQL Alembic
upgrade/check passed. OpenAPI regenerated and equals app.openapi(). Merge and
Telegram migrations: **8 passed**. Final backend repeated after explicit REST
reminder Policy Engine checks. No later stage started.

Real Chromium via Playwright CLI on separate loopback 5182/8012 and separate
SQLite DB: logged in a disposable owner, disabled synthetic connector only.
Changed Europe/Berlin, digest 20:30, deadline_reminders true, quiet_start 22:00,
quiet_end 08:00; saved through actual PATCH, reloaded and asserted all values.
Used keyboard Space for the styled checkbox (native input's click target is
covered by its decorative icon); no mocked API/DOM or real Telegram token.
This establishes browser persistence, not live Telegram delivery.


Stage 2 final repeat after REST policy checks: **418 passed, 2 skipped**, one
existing warning, 62.60s. Explicit digest scheduling authorization was then
checked with all **7 briefing tests passed**; no behavior/schema changes.
Stage 2 accepted locally. Commit includes actual worker/policies, migration,
contracts, settings, regression and browser evidence. Next Stage 3 only.

## Stage 3 — personal owner text dialogue

Implemented in `telegram_personal_queue.py`, `telegram_personal_dialogue.py`,
`telegram_models.py`, `telegram_service.py`, `telegram_personal.py`,
`ai/turn.py`, `ai/personal_tools.py` and migration 0030. The API tool branch uses
the common turn function, retaining its existing one-completion behavior.
Provider usage is distinct per completion and accumulated into one AIRun;
monthly accounting includes observed running/failed checkpoints. Rotation covers
encrypted queue text/quotes; export explicitly excludes internal queue rows.

- Enqueue verifies private owner identity again and commits encrypted text/quote
  with receipt/cursor. No model call in polling. Foreign IDs and forwards stay
  silent. Conversations are pinned at enqueue; `/new` rotates the persistent
  owner conversation. Context is bounded to 20 owner/assistant messages, with
  time/timezone supplied by the server.
- One supervised, bounded turn per integration, at most one started each
  connector iteration. Timeout 90 seconds, at most eight provider completions.
  Model/provider waits and recovery notices do not block polling/reminders.
  Startup fails running jobs and their matching owner AIRun; successful tools
  are never repeated. Interrupted-notice claims commit before transport, with a
  content-free Notification and no delivery retry.
- Registry extends existing creation tools with bounded task list/search,
  exact-version task update/complete, note/calendar reads, validated event and
  reminder creation. No delete. Policy Engine authorizes every mutation and
  external effect; owner references and shared domain/sync writer are reused.
  A reminder created with an event also checks reminder-write policy.
- Current affirmative owner request determines direct action scopes. Quotes,
  code, blockquotes, negation and referenced topics cannot grant writes. This
  deterministic grammar is deliberately conservative: an ambiguous/unsupported
  phrasing does not receive write permission; commands remain available.
  Retrieved/quoted content is UntrustedData. Secretary does not receive this
  registry/conversation. Reply segments are <=4096 with no parse_mode.

Test-first evidence: missing shared turn (2 failures), missing dialogue runtime
(3 failures), queue/registry tests before new modules, unrotated queue ciphertext,
real UsageTracker completion dedup, quoted/negated and referenced-domain scope
escalation, multiline quote, and stalled recovery transport were reproduced
before fixes. Terra's two P1 findings and later P2 were fixed and re-reviewed;
final review found no remaining confirmed blocker. Luna and Terra used medium
reasoning and disjoint files; parent alone owns Git/index.

Acceptance commands/results:

- Full `make test`, with disposable PostgreSQL AI/queue/concurrency and migration
  URLs: **552 passed, 2 skipped in 84.01s** on the final implementation, including
  the stalled recovery-notice path. The two global PG integration cases were
  separately run against a fresh migrated database: **2 passed**.
- New queue suite: **82 passed** across SQLite/PostgreSQL. Personal tools:
  **37 passed**. Shared turn/real monthly checkpoints: **5 passed** across
  available backends. Final owner dialogue including real polling during model
  wait, reminder delivery, interrupted committed tool, timeout, quote rejection,
  long replies, `/new`, and stalled recovery DM: **9 passed**.
- Ruff, mypy (**79 source files**), Bandit, compileall, pip-audit passed.
  SQLite and PostgreSQL upgrade/check: no drift. One Alembic head:
  `0030_telegram_personal_queue`. Fresh + both historical branches upgrade tests
  passed. A standalone `alembic heads` initially omitted required secret env;
  rerun with the synthetic local validation key passed.
- OpenAPI equals the committed schema; no new HTTP envelope. Shared typecheck
  and **36 tests** passed; web typecheck, **414 tests**, production build passed.
  Existing Stage 2 settings browser check remains valid; no UI changed here.
- No real Telegram token, provider completion or billing integration was used.
  Transport/model fakes exercise real queue, policy, domains, sync, run/event
  storage and worker paths. Live Telegram/model checks remain owner work.

Stage 4 has not started. No MySDU code/data, main, deployment, push or PR changed.


## Stage 4 — ephemeral personal media

Implemented metadata-only encrypted queue additions in migration 0031;
`telegram_media.py`, bounded `telegram_transport.py` file I/O,
`telegram_transcription.py`, common dialogue integration, immutable media types
and Claude/OpenRouter payloads. Existing provider API, shared types and settings
form support separate transcription and explicit images/documents/tool capabilities.
Chat/secretary provider choices exclude transcription. Rotation includes encrypted
media metadata. No file bytes, attachments endpoint, new scheduler or Business
media path was added.

Policy-checked limits: voice/audio 20 MiB, photo 10 MiB, PDF 20 MiB; text at most
20k UTF-8 characters / 80k transferred bytes. Known oversize and selected-model
capability mismatch refuse before file bytes. Unknown sizes are bounded while
streaming; compressed responses, redirects and unsafe paths refuse. File token
URLs are excluded from HTTP diagnostics including traceback/stack messages.
Quoted/file input is UntrustedData and has no tool grants, even with an imperative
caption. A subsequent owner text may create a task. Voice yields an owner-text
transcript only; missing transcription configuration returns a Russian explanation.
Raw text-file body is not stored in conversation or events; only generic marker
and answer. Bytes live in memory until the turn ends.

Audio budget uses a separate AIRun reservation before network I/O, tied to the
job until the subsequent chat run. The configurable request estimate (default
0.10 USD) counts toward monthly limit, including interrupted/failed attempts;
actual provider billing is not asserted. Values are Decimal and rounded upward
to Numeric(20,8), with sub-precision/non-finite values rejected. This fixed a
reviewed spending bypass and a later precision bypass. Selected-model preflight
also fixed the reviewed case where another model's vision capability allowed an
unnecessary download. Both agents closed review with no confirmed blocker.

Validation:

- `make test` with fresh disposable PostgreSQL migration/AI/queue URLs:
  **731 passed, 2 skipped in 94.19s**. Separate fresh PostgreSQL HTTP contracts:
  **2 passed in 1.06s**. Full run includes migration upgrades across historical
  branches, routing/adapters, queue dedup, voice creates once, PDF injection,
  UTF-8 transient context, foreign/forwarded media and no-vision refusal.
- Transcription focused suite **13 passed**, including multipart/key isolation,
  fixed errors, pre-I/O reservation observed from another session, budget
  exhaustion and numeric validation. Media/transport suite with existing
  regressions **120 passed**. Adapter + adjacent contracts **67 passed**.
- Ruff, mypy (**81 source files**), Bandit, compileall, script mypy and pip-audit
  passed. SQLite/PostgreSQL Alembic upgrade/check report no drift; one head
  `0031_telegram_ephemeral_media`. OpenAPI regenerated and equality checked.
- Shared typecheck/**36 tests**; web typecheck/**416 tests**/build passed.
  After visual inspection, the capabilities group uses existing controls without
  a native fieldset border; focused **3 form tests** and web typecheck passed.
  Provider form tests cover separate voice key, key clearing, preserving model
  costs/context/other models and capabilities while enabling media/tools.
- Actual browser at own loopback frontend 5182/backend 8012 (backend restarted
  after migration): chat provider saved with streaming/tool_calling/images/
  documents; separate transcription model saved with monthly budget 2 and
  request estimate 0.05. Reload + edit confirmed all values and empty key fields.
  Initial key-clear observation preceded the form's finally block; waiting for
  save completion confirmed clearing. Screenshot after launch animation visually
  inspected. All keys were synthetic, Telegram integration disabled, no probe or
  real outbound provider/Telegram request performed. One expired foreground
  reminder-dispatch request returned 401 during session refresh; settings reads
  and saves succeeded through the owner session.

Primary protocol documentation: official Telegram getFile, Claude images/PDF,
OpenRouter images/PDF, OpenAI transcription (linked in AI_HARNESS.md). Approved
transcription origin currently api.openai.com; arbitrary compatible custom
origins are not enabled by this feature. No real vision, transcription, Telegram
or billing result is claimed. Stage 5 has not started. MySDU and main untouched.


## Stage 5 — explicit encrypted lexical memory

Implemented `ai/memory_models.py`, `memory.py`, `memory_api.py`,
`personal_memory_tools.py`, migration 0032; mounted owner router, personal
commands/registry/runtime, existing Settings navigation and new MemorySettings,
shared types/client, encrypted export/restore and key rotation. No extractor,
embeddings, RAG, MCP or new sync resource kind. MySDU unchanged.

Facts have encrypted text, kind, server-assigned source/message reference, optional
expiry, exact version, deleted_at and owner-specific NFKC/case/whitespace digest.
Remember deduplicates or explicitly revives. All writes serialize by owner;
API updates/deletes use CAS. Only explicit current owner text/voice grants
remember or forget, separately. Files, quotes, facts and history grant neither.
Lexical read scans active owner facts in batches of 200 and keeps global best 10.
Settings use fresh owner-only requests with no plaintext IndexedDB cache or
unconfirmed forget replay. API validation errors do not echo memory text.

Forget/expiry/edit excludes memory data and derived conversation context through
(id,version) provenance. The shared tool turn preserves provenance on intermediate
answers and aggregates every used reference; inherited history keeps it through
repeated answers. Refresh validates versions before every provider completion,
so same-turn forget cannot resend the injected fact. Existing visible history
is retained, with revoked-memory-derived messages omitted from subsequent model
context. Full owner text/transcript remains; only the retrieval query is bounded.

Test-first/review fixes: missing UI/service, fact injection, next-turn fact-bearing
answer, intermediate answer with forget in the same completion, inherited repeated
answer, long text exceeding selector query limit, and physical SQLite savepoint
commit were reproduced. The command handler now starts a physical outer SQLite
transaction before its nested savepoint when needed; facts/domain writes remain
atomic with receipt/cursor and caller rollback. Restore checks memory-write policy
before insertion and recalculates destination-owner hashes without overwriting
collisions. Both agents closed review with no remaining confirmed blocker.

Validation:

- Final `make test` with fresh disposable PostgreSQL AI/memory/queue/migration
  URLs: **823 passed, 2 skipped in 120.89s**. The two global PostgreSQL contracts
  were separately run on a fresh migrated DB: **2 passed in 0.94s**.
- Memory service **64 passed** across SQLite and migration-backed PostgreSQL,
  including encrypted raw columns, dedup/CAS concurrency, expiry, owner isolation,
  active provenance versions and global lexical best-10 batching. Initial API /
  portability focused **21 passed**, with later restore-policy denial + existing
  export **6 passed**. Integrated context/secretary tests are included in full run.
- Ruff, mypy (**85 source files**), Bandit, compileall, rotation-script mypy,
  pip-audit and diff checks passed. SQLite/PostgreSQL upgrades and Alembic check
  have no drift; one head `0032_owner_memory`. OpenAPI regenerated and equality
  checked. Shared typecheck/**37 tests**, web typecheck/**418 tests**/build passed.
- Actual browser on own 5182/8012 stand: create memory POST **200/version 1**,
  reload, edit PATCH **200/version 2**, reload confirmed text, forget DELETE
  **200**, row immediately absent. Direct read of the disposable SQLite column
  confirmed ciphertext. Screenshot after launch overlay detached was visually
  inspected. One initial browser selector timed out during launch; role-based
  retry and explicit overlay-detached wait completed the actual flow. No real
  provider or Telegram call was used or claimed.

Stage 5 is locally accepted. Stage 6 task matrix/time and Stage 7 read-only Google
Calendar remain unimplemented. Attachment storage remains OPEN. No push, PR,
main modification, MySDU modification or deployment occurred.
