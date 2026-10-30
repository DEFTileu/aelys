# Aelys optimization report — current evidence (goal active)

Date: 2026-10-30, Asia/Almaty. The goal is active; cross-platform completion is
not claimed. This report will record commands and evidence as they finish.

## Current baseline and environment

- Current UI slice: 117 web tests, typecheck and production build passed before
  optimization. This is historical starting evidence, not all-platform acceptance.
- Mac arm64; Node v26.5.0; pnpm 11.18.0; Rust 1.99.1; Java21 (Android Studio JBR).
- Docker daemon available (29.6.2); PostgreSQL16 images already local.
- macOS has CommandLineTools active; full Xcode absent. Actual build will decide
  which gates require full Xcode, rather than declaring all macOS blocked.
- Android SDK command-line tools 23.0 and NDK 30.0.16248370 are now installed by
  the owner. Actual arm64 debug/release APK builds pass; a Samsung SM-S721B/API 36 phone is
  now connected and the locally signed release launches. See the authoritative
  Android gate below.
- Existing current frontend single JS ~446kB/~130kB gzip; measured artifact details
  and before/after chunk records are being collected by the frontend worker.
- scripts/benchmark_backend.py uses fresh synthetic SQLite by default and refuses
  to seed a nonempty database. Optional PostgreSQL URL must be a disposable DB.
  Records: 2000 per tasks/notes/mail; synthetic bodies, 10% tasks in a project;
  one first request + 15 warm repetitions and separate tracemalloc search peak.
  Includes real auth SQL via ASGITransport; no network/proxy latency or worker
  lifespan, so this is not a production capacity claim.

## Touch ID and current frontend size

The owner-requested macOS session-unlock switch is implemented in native Rust
and Settings, with explicit unlock/password fallback and cancellation preserving
credentials. See [behavior, tests and acceptance limits](docs/optimization/macos-touch-id.md).
The actual macOS LocalAuthentication availability probe returned true. Fingerprint
approval and signed-in restart remain owner-interaction gates.

Current initial frontend JS with the new feature is 312,775 bytes / 95,809
Python gzip bytes, versus the recorded baseline 445,970 / 127,999: 29.87% fewer
raw bytes and 25.15% fewer compressed bytes. This supersedes the historical
28.5% gzip improvement for the earlier, smaller feature set; it is payload
size, not a measured startup latency improvement. Exact artifact/method:
`docs/optimization/web-current.json`. The frontend is also the packaged Tauri
UI; retaining it does not require publishing a separate browser deployment.
No previously approved platform is removed by the owner's exploratory question.

## Components consistency follow-up

The owner requested a component gallery after reviewing the Touch ID switch.
`/components` now exposes local interactive samples independently of owner
auth/backend calls, and the reusable Switch resets native button chrome in
Touch ID and Home settings. Browser light/dark/narrow-view checks, 180 web tests
and production build pass. See [scope and evidence](docs/COMPONENTS.md).

## Current authoritative status

The overall goal is **not complete**: Android now builds real APKs, but native
auth/Keystore/transport, backend login/CRUD and device lifecycle acceptance are
  still incomplete; macOS
authenticated Keychain restart remains unverified. Current authoritative checks:

| Area | Status | Evidence and limitation |
|---|---|---|
| Backend API / SQLite | PASS | Current full suite with PostgreSQL AI opt-in: 197 passed, 3 skipped; full Ruff, mypy and Bandit pass; Decimal/ownership/version rules preserved. |
| PostgreSQL | PASS for tested synthetic gates | Disposable migrations, existing API/sync contracts and four AI cancellation/revocation/SSE transaction cases pass; personal DB untouched. Historical live-schema downgrade/repair remains separately limited. |
| Shared sync/cache | PASS for tested slice | 36 shared tests; canonical query cache keys, confirmed-write invalidation, origin/owner partitioning, no unsafe legacy POST replay. Cross-tab failed-invalidation recovery remains documented. |
| React Web | PASS for tested slice | 169 web tests, typecheck/build pass; isolated production QA verifies saved-note reload, offline in-view draft preservation and newer edits during a real delayed save without false success. |
| macOS bundle | PARTIAL | Unsigned arm64 `.app` exists at the documented path and launches to native login/health flow; typed IPC covers Me/Projects/Tasks lifecycle, Home reads, Notes, Calendar, Finance, Focus, local Mail drafts, Notifications and AI conversation/run lifecycle. Keychain restart, sleep/wake and credentialed execution remain unverified. |
| Android APK | PARTIAL: build and device process launch pass | Owner installed NDK/cmdline tools; integrated arm64 debug APK (192.66 MiB) and release APK (30.89 MiB unsigned) pass manifest/signature/alignment checks. A locally debug-signed release (30.94 MiB) installed and relaunched on Samsung SM-S721B/API 36; the server-unavailable screen rendered and no fatal log errors appeared. The latest APK also survives force-stop/relaunch while the device is locked, but its foreground UI is not reverified. Shared typed transport and Keystore/noBackupFilesDir session-store compile into the APK, but HTTPS backend login/CRUD and Keystore persistence remain unverified. ADR-006 remains PROPOSED. |

Android artifacts, SHA-256 and exact commands:
[build evidence](docs/optimization/android-apk-build.md). A reproduced incremental
debug packaging defect inflated the same content to 288,729,096 bytes; fresh
packaging now produces 147,989,304 bytes (48.7% smaller), preserving the prior APK
as `.apk.previous`. The current integration artifacts and physical-device smoke
check are recorded in the linked evidence. This size reduction is separate from
debug/release differences.
The unused Mac runtime dependency was removed from mobile (54 packages pruned,
no remaining version upgrades). Packaged cleartext stays disabled in both variants.

Notes save-notice regression and production-browser evidence:
[verification](docs/optimization/note-save-notices.md). Existing draft/version
behavior, conflict handling, auth and offline replay policy are unchanged.

Latest macOS artifact: 27.61 MiB unsigned arm64 executable SHA-256
`a3abde656b3673a39a69e861a255080ab16255b5126bd6d24b36455ac69e414f`.
The `.app` was rebuilt with the current web dist using the documented
`tauri build --ci --no-sign --bundles app` override. The owner reported Touch ID
followed by a separate Keychain permission password. Status now uses metadata
only, and all Mac Keychain reads/writes/deletes suppress implicit password UI
with fail-closed errors; the existing session is preserved on denied reads.
Thirty-two native transport and 201 web tests pass (plus a final 11-test entry regression run), with native Clippy/typecheck/build
and Android-target check passing. Read-only signing audit found no valid signing
identity and a cdhash designated requirement. The remaining trust/Keychain
permission issue and real fingerprint/restart acceptance are **open**; removing
repeated prompts is not claimed as successful session restore. See
[follow-up scope and limits](docs/optimization/macos-touch-id.md).

Current native evidence: shared native transport has 25 Rust tests passing and
the Android session-store crate has 1 origin-contract test passing. Three HTTP regressions
reproduced valid Projects/Notes create responses and Focus start being rejected
as `MUTATION_OUTCOME_UNKNOWN`; singular response handlers and Focus list/object
selection are now corrected. Create/PATCH/list and Focus start/stop/list pass
nine loopback HTTP round trips. See
[contracts and limits](docs/optimization/native-domain-response-contracts.md).

A delayed loopback
HTTP regression reproduced the session mutex blocking AI cancellation; the fix
releases that lock before network I/O and rejects previous-session late results.
See [method and limits](docs/optimization/native-ai-cancellation.md). The fetch
adapter now uses incremental Tauri Channel events with exact-subscription
cancellation before/after HTTP headers. Five Rust and six web regressions cover
delivery before EOF, framing, abort races, error handling and session cleanup;
see [streaming evidence](docs/optimization/native-ai-streaming.md). This tests
the HTTP decoder and JS adapter separately; credentialed packaged-WebView/provider
integration is not claimed. The rebuilt artifact is verified on disk; an
authenticated launch of this revision has not been performed.

## Latest local runtime state

Current backend PID **50639** serves `http://127.0.0.1:8000` with its original
environment and existing database. Main web `http://127.0.0.1:5173` and the
additional Vite server on `5174` proxy healthy backend responses. The local
launcher reuses matching servers and supervises only processes it creates;
see [launcher lifecycle evidence](docs/optimization/local-launcher-lifecycle.md).

The full backend quality gate is now clean: unfiltered Ruff for app/tests,
mypy (66 files), Bandit and compile checks pass. Ruff 0.17.3 and the Python 3.12
target are explicit; CI runs the full lint command. Resource-link storage
outages no longer become false duplicate-link errors. See
[quality gate evidence](docs/optimization/backend-quality-gate.md).

The backend environment also had a reproducibility defect: `python-dateutil` was
declared by the project but absent from the checked lockfile and local synced
environment, so collection failed before tests ran. `uv lock` plus
`uv sync --all-extras --reinstall` repaired the lock and environment. The fresh
unfiltered run is **193 passed, 7 skipped**; `uv lock --check` passes. This is a
dependency/tooling correction, not a product behavior change.

Provider cancellation covers headers, completion bodies and SSE reads;
intermediate SSE writes release SQLite locks, and terminal events commit with
run state before delivery. Four migration-backed PostgreSQL 16.15 AI cases pass
as well. See [provider I/O](docs/optimization/provider-io-cancellation.md) and
[PostgreSQL contracts](docs/optimization/postgres-ai-contracts.md). Their earlier
reports retain the test counts and process identities from those slices.

Earlier native GUI checking required manual Mac unlock. The owner is now awake
and installed Android prerequisites through the opened SDK Manager. Keychain
restart/sleep-wake and Android secure transport/device acceptance remain open;
the integrated native spike is compiled but not device-verified. Backend quality
and successful APK builds do not close those gates.

## Full suite refresh

Latest configured backend run: **197 passed, 3 skipped** with PostgreSQL AI
contracts enabled. Full Ruff, mypy and Bandit pass. The existing Starlette/httpx
deprecation warning remains. Shared **36 passed** and Web **165 passed**, with
typecheck/build, retain their preceding evidence because their sources did not
change in this backend slice. Platform acceptance remains separately scoped.

## Current synthetic benchmark refresh

Fresh 2026-10-30 runs used the existing benchmark method, 2,000 records per
domain, 15 warm repetitions and isolated databases. Results are stored in
`docs/optimization/sqlite-current.json` and `docs/optimization/postgres-current.json`.

| Dialect | Scenario | Warm p50 / p95 | Response bytes | Queries |
|---|---|---:|---:|---:|
| SQLite | task list | 13.099 / 36.308 ms | 1,777,691 | 3 |
| SQLite | project tasks | 2.649 / 2.841 ms | 183,890 | 3 |
| SQLite | notes | 23.491 / 48.278 ms | 17,092,891 | 3 |
| SQLite | search | 25.754 / 26.806 ms | 566,683 | 5 |
| PostgreSQL | task list | 20.626 / 47.512 ms | 1,777,691 | 3 |
| PostgreSQL | project tasks | 3.782 / 6.416 ms | 183,890 | 3 |
| PostgreSQL | notes | 80.326 / 106.920 ms | 17,092,891 | 3 |
| PostgreSQL | search | 25.100 / 49.236 ms | 566,683 | 5 |

The current search peak Python allocation was 4,469,003 bytes on SQLite and
4,414,192 bytes on PostgreSQL; query counts stayed stable across all repeats.

These are ASGITransport synthetic measurements without network or worker
lifespan latency; they are current evidence, not a production capacity claim.

## Local dev proxy correction

The Vite proxy now reads `AELYS_BACKEND_ORIGIN` while retaining
`http://127.0.0.1:8000` as the default. With the unrelated Juz40 process using
8000, the active Aelys dev server was started on `http://127.0.0.1:5174` with
`AELYS_BACKEND_ORIGIN=http://127.0.0.1:8001`: `/healthz` returns 200 and an
unauthenticated `/api/v1/me` returns the expected 401. Web typecheck and 158
tests pass.

The repository helper `scripts/start_local.sh` was syntax-checked and exercised
against the active `8001 → 5174` services; it correctly reused the healthy Aelys
process without touching the unrelated listener on `8000`.

## Current local launcher validation

The helper was then run without overrides. It detected that the IPv4 loopback
port was available despite the unrelated IPv6 listener, started Aelys on
`127.0.0.1:8000`, and kept the existing Vite server on `127.0.0.1:5173`.
Both `/healthz` checks returned 200. Only Aelys/Vite processes created during
the fallback probe were terminated; the unrelated Java process was left running.

## Browser runtime smoke check

After the launcher restored the standard ports, the existing Aelys browser tab
was reloaded at `http://127.0.0.1:5173/tasks`. The DOM showed the real Tasks
navigation, task filters, empty-state action and the owner-scoped `Goal 2
integration` project option; no connection error was present. This verifies the
current web shell against the running backend without entering credentials or
changing user data.

## Historical Android wrapper re-audit

The following earlier audit predates the owner-installed toolchain and native
transport spike. Its `runtime_policy`-only/NDK-missing result is retained as
baseline evidence; current Android status is in the table above and
`docs/optimization/android-apk-build.md`. Device connectivity and lifecycle
evidence remain open, and ADR-006 remains proposed.

## AI, Mail and Calendar re-audit

The current backend routes are real owner-scoped handlers: AI provider/secret
management and runs, Gmail OAuth/read/draft import, local EML import/drafts,
and Calendar recurrence/reminder operations are registered in the running app;
no mock or placeholder implementation was found in these paths. Targeted
integration coverage passed: 13 tests across AI API/security, Gmail connection,
calendar recurrence and versioned note/domain behavior. Live Gmail and provider
execution still require configured owner credentials, so those external calls
are not claimed from fixture tests.
The app bundle was relaunched. The current Aelys validation server is on
`http://127.0.0.1:8000` and the web server is on `http://127.0.0.1:5173`;
both health checks return `{"status":"ok"}`. A separate Java process owns the
IPv6 wildcard listener on `:8000`; the Aelys process uses the IPv4 loopback and
was not modified.

## Autonomy

The owner authorized continuing improvements after the current goal. Hourly
heartbeat `aelys` is active on this chat, quiet unless a meaningful result/failure
or required action occurs. Other unrelated automations were not changed.

## First verified changes

- Route lazy loading: initial JS 445,970 → 297,063 bytes; deterministic Python
  gzip 127,999 → 91,579 bytes (−28.5%). All route chunks together cost 142,479
  gzip bytes, so total-all-routes increases; this is startup payload improvement,
  not a claimed page-load time improvement. Web tests after change: 118 passed.
- Search now selects only id/title instead of full ORM/body rows and excludes
  soft-deleted records. A new API/SQL-shape regression initially reproduced the
  deleted-record leak (6 results instead of 3), then passed with the fix.
- Synthetic search peak Python allocation: SQLite 28,179,876 → 4,338,982 bytes;
  PostgreSQL 28,800,021 → 4,398,678 bytes (~85% lower). Result bytes and query
  counts are unchanged (566,683 bytes; five including auth). Observed median
  search latency SQLite 349.719 → 71.988ms, PG 451.570 → 55.434ms; multiple other
  measurements fluctuated substantially under concurrent native builds, so these
  speed numbers are provisional, not controlled regression thresholds. Repeat
  under quiet conditions before drawing a broad performance conclusion.
- Rust runtime: fmt check, locked tests (30 unit + 14 contract), Clippy passed;
  native process cancellation/privacy checks remain intact.

## Newly reproduced release defect

Clean PostgreSQL Alembic upgrade failed in 0001: gmail_oauth_states references
missing auth_sessions because the initial migration builds current live metadata
in dependency-incompatible order. Existing-table benchmark succeeds but is not
migration acceptance. A dedicated migration worker is fixing this using only
fresh disposable databases; personal database is untouched.

## Android external prerequisite

Host cargo check/fmt pass after adding the missing Tauri mobile entry point.
Actual Android initialization is blocked by absent NDK; current SDK packages
require a license not already accepted in the installed SDK. No agreement was
accepted, no Android project/APK was generated and no emulator/device exists.
Owner action is recorded in docs/ANDROID_OPTIMIZATION_STATUS.md. This does not
block independent backend/web/macOS work and does not satisfy the overall goal.

## Current quality/platform evidence

- Backend full suite with search fix: 153 passed, 2 skipped (PostgreSQL tests
  require their configured URL), one existing Starlette/httpx warning. Separate
  disposable PostgreSQL API/sync contract run: 2 passed. Ruff passed; mypy caught
  an untyped result accumulator in the new search code, now explicitly typed and
  being rechecked. No full-goal completion claim.
- Historical macOS baseline: the first unsigned arm64 bundle stopped at
  “server unavailable” because the native boundary did not yet exist. That
  observation is retained for comparison only; the current bundle reaches the
  native login/health flow. Historical main-process idle samples (69–79MiB RSS,
  WebKit excluded) are not current authenticated performance evidence.
- Follow-up mypy and Ruff recheck passed after adding the typed search result
  accumulator. Backend OpenAPI fields are unchanged by projection.

## Follow-up verified reliability changes

- Clean PostgreSQL/SQLite Alembic chains now pass after deferring Gmail OAuth
  state creation until auth_sessions exists and avoiding duplicate AI run FKs.
  Targeted regression includes staged upgrades and preserving an inserted user;
  details in docs/POSTGRES_MIGRATION_VALIDATION.md. Historical live-metadata
  migrations still need a future frozen-schema strategy; no personal DB reset.
- Shared GET caches now include canonical query parameters, so project filters
  cannot cross-contaminate cached collections. Confirmed writes invalidate
  built-in collection variants without touching pending entities/outbox.
  Rejected writes retain cached data. Shared checks: 36 passed, typecheck passed.
  Guarding an older in-flight GET is per client; cross-tab races and failed-store
  invalidation across restarts remain limitations, not silently claimed solved.
- Web offline databases are now partitioned by API origin and owner-sub hint;
  legacy unscoped DB is retained but not read or blindly migrated. This is cache
  namespacing, not token authentication; server owner checks remain authoritative.
  A stale client cannot use a newly selected origin/owner credential. No token
  is included in a DB name/cache record. Legacy pending entries need explicit
  recovery in a later migration, not unsafe automatic replay.
- Notes: independent creation/per-note drafts prevent New/Cancel/selection/search
  from replacing an edited note. Online-only writes avoid the legacy unsafe
  POST queue. Backend now atomically validates ?version and only then appends a
  A stale save returns 409 while preserving server body/revision list.
  Drafts remain in memory while mounted, not durable page-reload storage.
- Health checks now have a bounded single flight and keep ready during background
  checking, avoiding full-module reload cascades on ordinary focus. The health
  controller is covered by the final web test suite; full native module coverage
  remains open because the adapter is not yet wired to every screen.

Sanitized measurement JSON lives in docs/optimization. These fixtures contain
only synthetic dimensions, response sizes and timings; no personal contents,
credentials or URLs. sqlite/postgres before/after are separate fresh DB runs;
concurrent native builds affected timing variance, so memory/payload changes
are stronger evidence than provisional p95 comparisons.

## Native and browser follow-up evidence

- A cookie-free native auth slice is live in the backend and bounded Rust host:
  device-bound native login/bootstrap, stable-session refresh rotation with
  replay rejection, exact-session logout, origin/window checks, OS Keychain
  record format, no redirects, bounded responses and fixed Me/Projects/Tasks
  routes. Rust unit tests: 7 passed; backend native contract tests: 11 passed.
  The endpoint rejects browser Origin/Fetch-Metadata headers and returns no
  cookies. It is a pilot: frontend wiring to AuthGate and all modules, actual
  Keychain restart, and Android implementation remain open.
- Current macOS app was rebuilt after native changes: unsigned arm64
  `apps/desktop/src-tauri/target/release/bundle/macos/Aelys.app`, Tauri 25.69
  MiB; executable SHA-256 is
  `cdd64f442b25a3d034f484f8948c0de14e62e15e7d2824596328d90f57cdc994`.
  It launched as two local processes during verification. No signature,
  notarization or installer is claimed.
- Main backend was restarted on `127.0.0.1:8000` using the repository's existing
  `.env` and database (no reset). `/healthz` returns ok; native status returns
  `initialized:true`; a browser Origin on that route returns 403 as designed.
- Isolated production bundle QA ran at `http://localhost:8002` with a temporary
  SQLite database. Owner bootstrap, module requests, note creation and reload
  persistence passed. Requests included real `/api/v1/notes` POST/GET and
  `/api/v1/me`; no owner database or credentials were used. Browser console's
  only observed message was the removed ineffective meta `frame-ancestors`
  warning; HTTP server headers remain the required enforcement point.
- Full latest quality run: backend 155 passed, 3 skipped; shared 36 passed;
  web 141 passed; web typecheck/build passed; Rust desktop 7 tests passed;
  Android host cargo check passed. The disposable PostgreSQL migration suite
  had 7 targeted tests pass. These checks do not close Android device/SDK or
  native restart gates.

## Native web integration follow-up

### Android native transport integration (2026-10-30)

The current Android release build contains the shared bounded typed transport,
exact packaged-origin checks, normal TLS verification and a private Android
Keystore session store. The latter is a Tauri mobile plugin with no frontend
commands or ACL grants; generated ACL inspection shows the app grants only the
nine intended `native_*`/runtime commands to the `main` window and no remote
capability. The plugin's instrumentation tests compile but have not run on a
device. Shared transport tests: 22 passed; mobile release APK build passed.
This is a native integration spike, not proof of Android login, device security,
offline storage, lifecycle or background sync.

- The packaged React entry now detects the Tauri host, checks backend health via
  the official `@tauri-apps/api/core` `invoke`, and uses native status/login/
  resume without browser cookies or WebView storage. `getSharedApiClient()`
  uses a strict native fetch adapter for the Rust allowlist; it never falls
  back to browser fetch. Me, Projects and Tasks list/create/update/delete are
  routed through typed operations. Unsupported modules return
  `NATIVE_OPERATION_UNSUPPORTED` instead of pretending they are connected.
- Native integration tests cover Tauri operation routing, explicit task version
  updates, unsupported-module fail-closed behavior, transport errors and the
  no-browser-fetch invariant. Latest web suite: 156 passed; typecheck/build
  passed. The fresh rebuilt `.app` opened at `tauri://localhost` and visibly
  reached the real native login screen after the native health check.
- Current macOS executable SHA-256 after this integration:
  `3b67010d6b11b7f65991246af62d428d7f5fd9868991142f3054372da1a23d7e`.
  The bundle remains unsigned and the authenticated native restart still needs
  a real owner login/Keychain observation; no credentials were entered.

The final rebundle after origin validation produced the same unsigned arm64 app
at the documented path (25.69 MiB; current executable hash above). The process
was relaunched with `open -n` and is present while the backend/web services stay
on ports 8000/5173. A second CUA visual read after that final relaunch was
blocked by the macOS lock screen; the immediately preceding fresh bundle read
showed the native login screen, and the final source delta only preserves
unsupported-origin rejection behavior covered by tests.

## Native Home read slice

The typed Rust allowlist now also covers the read-only Home sources: notes,
calendar occurrences (bounded start/end strings), finance transactions, focus
sessions, mail messages and activity. Each response is deserialized into an
explicit Rust schema before it crosses IPC. No account credentials, Gmail
management, AI, Telegram, draft writes or generic route/body proxy were added.
The browser adapter has matching strict operation types and tests for all six
routes. Rust fmt/check/tests and the focused web tests pass.

The rebuilt unsigned macOS app is 25.89 MiB; current arm64 executable SHA-256:
`612783c4a7498d784cc22d00a08feccc6e860c730da961e45503b1ce4d48f793`.
The final bundle was relaunched with `open -n`; the owner was not asked to enter
credentials while the screen was locked, so authenticated Keychain restart is
still unverified.

Native Notes writes are now part of the bounded contract: create, delete and
versioned patch route to fixed `/notes` endpoints; stale patches remain server
409 conflicts. The latest web focused native-client test set covers those
routes; Rust fmt/check/tests remain green.

Final rebundle after Notes integration: unsigned arm64 `.app`, 25.95 MiB,
executable SHA-256
`20ed032cda9471ec07c1c659c214497c8b1cf7dac9513aaf1b03068624a3f9df`.
The process was relaunched with `open -n`; the backend health endpoint remains
OK on `127.0.0.1:8000`.

## Native Finance slice

Finance native operations now cover accounts, categories, budgets, summary and
transactions reads, plus account/category/transaction creates. Decimal amounts
remain strings across the IPC boundary; transaction validation accepts only
bounded decimal text and preserves the backend idempotency key. Finance
transfers and budget writes remain separate typed work; no generic proxy or
bank credential path was added.

Latest unsigned arm64 rebundle: 26.16 MiB, executable SHA-256
`8140bcfcfdfdeab5f35f4d1202d7bc0f94da6bcbd2f1c10eb5957e0a2569b58e`.
The app process was relaunched; backend health remains OK on port 8000.

## Native Calendar write slice

Calendar native operations now cover event listing, create, versioned update
and versioned soft-delete. Typed inputs retain UTC timestamps, IANA timezone,
RRULE, linked task/project and reminder fields; response schemas reject malformed
backend payloads. The backend's 409 conflict semantics remain authoritative.
Calendar reminders and dispatch stay separate policy-aware operations.

Latest unsigned arm64 rebundle: 26.16 MiB, executable SHA-256
`8eb96c3fe5d19f9f637a303db2ecca0eb4256cb38d909d966faf08e6cefd402f`.
The app process was relaunched and backend health remained OK.

## Native Focus lifecycle slice

Focus native operations now cover read, idempotent start and versioned stop.
The Rust transport sends the start key as `Idempotency-Key`, validates the
bounded mode/time/owner references, and sends stop `version` explicitly. No
automatic mutation retry was added.

Latest unsigned arm64 rebundle: 26.20 MiB, executable SHA-256
`dec1f0898152d52b7aa54786da705294dcfc11f37ca4db6e6201bf03806b198d`.
The app process was relaunched and backend health remained OK.

## Calendar reminder slice

Calendar native operations now include reminder listing, create with strict
`event_id`/`in_app`/idempotency validation, and versioned cancel. Reminder
server validation remains authoritative for event ownership and notify time.

Latest unsigned arm64 rebundle: 26.26 MiB, executable SHA-256
`91a730d84c67ccb8e67f45feee846acb57be660a37bb694f886c8d7805f269f6`.
The app process was relaunched and backend health remained OK. Full web suite:
152 passed; Rust clippy/test and focused native adapter tests passed.

## Finance transfer/budget slice

Finance native operations now include budget create and transfer create. Inputs
remain strict Decimal strings, currencies and ISO date fields are bounded, and
transfer output is schema-checked as balanced debit/credit transactions. The
backend idempotency key remains in the transfer body; no automatic retry was
introduced.

Latest unsigned arm64 rebundle: 26.32 MiB, executable SHA-256
`c8b51f0b05ba502590744046f10a9a832a8a6671276a77dc5d85dc7e0e55a102`.
The app process was relaunched and backend health remained OK. Full web suite:
153 passed.

## Native local mail drafts slice

Native Mail now supports local draft list/create/versioned patch/delete through
strict operations. Draft bodies and recipients stay in the owner-scoped backend;
Gmail OAuth, account connection and sending remain outside the native operation
surface and no credential is accepted by IPC.

Latest unsigned arm64 rebundle: 26.36 MiB, executable SHA-256
`916da5354cfcaa4272177ef379a6f764633e308b1ef8dbb5c8bd4e0428e4f900`.
The app process was relaunched and backend health remained OK. Full web suite:
154 passed.

## Native Mail read boundary

Native Mail now reads owner-scoped account metadata and the non-secret Gmail
configured status, so local Mail/drafts can load without exposing OAuth tokens.
Gmail connect/send remain unsupported by the native allowlist and fail closed.

Latest unsigned arm64 rebundle: 26.39 MiB, executable SHA-256
`e282993b0cc8f58abc4610542623aa42274c6148dd560d604f5e837725f8115c`.
The app process was relaunched and backend health remained OK. Full web suite:
155 passed.

## Native AI read boundary

Native AI now reads provider metadata (`has_secret` only), conversation lists
and conversation messages. Provider secret values, secret write/delete/probe,
AI runs and streaming remain outside the IPC adapter; backend AI policy and
credential handling stay authoritative.

Latest unsigned arm64 rebundle: 26.46 MiB, executable SHA-256
`12de3d3a7b8fc4b93e943fdbaed4c7dac537f85e8a99661c7b2c99fd3049fa3f`.
The app process was relaunched and backend health remained OK. Full web suite:
156 passed.

## Native AI conversation writes

Native AI now routes conversation creation and message creation through explicit
typed IPC operations. Input validation remains bounded to the operation schema;
provider secrets, model execution and streaming are still outside this bridge.
Rust `fmt`, locked check, Clippy and tests passed (7 native tests); the web
suite passed 157 tests and typecheck. Latest unsigned arm64 rebundle: 26.51
MiB, executable SHA-256
`f9b7a2fe73d0f511be902a2ba049d62a35ba5640d8e38e367c2a2749ca36f157`.
The app was relaunched and `/healthz` remained `{"status":"ok"}`.

## Backend quality re-audit

The full backend suite was rerun from the runtime environment used by the local
server (`../.venv`): 166 passed, 3 skipped, one existing Starlette deprecation
warning. Mypy passed with `--explicit-package-bases --ignore-missing-imports`
after fixing the typed calendar lookup and policy descriptor attributes. The
unfiltered repository Ruff gate still reports 496 pre-existing style findings,
recorded as open style debt. Full Bandit now passes after refactoring the
Telegram supervisor's exception isolation; the related Telegram-focused tests
pass 40 cases and no secret-bearing error is logged.
The Telegram service file itself is now Ruff-clean after safe import/UTC fixes
and explicit dictionary literals; full backend tests remain 166 passed, 3 skipped.
The backend was restarted from the current checkout and `/healthz` returned OK.

## Android init re-audit

`pnpm --filter @aelys/mobile exec tauri android init --ci` located Android
Studio Java and `the local Android SDK`, then stopped before
project generation with `Android NDK not found`. No license was accepted, no
APK was produced, and no device/emulator test was claimed.

The unrelated Juz40 Java process currently owns port 8000 on the host. The
current Aelys backend validation server is running on
`http://127.0.0.1:8001` in the active terminal session and its `/healthz`
returns `{"status":"ok"}`. The standard 8000 proxy/default was not redirected
to the unrelated service.

## Native enum mapping correction

The native Rust test caught and fixed an acronym serialization defect where
`AIProviders` would deserialize as `a_i_providers`. Explicit serde names now
match Web operations (`ai_providers`, `ai_conversations`, `ai_messages`,
`ai_conversation_create`, `ai_message_create`). Native tests: 8 passed. The
final unsigned arm64 bundle is 26.51 MiB with executable SHA-256
`0acc2f6f325a442c558cddb8301e0a9d00f1b83d0be5e7142eba00c3c73f0c7e`.

## Native Projects and Notifications follow-up

The typed native surface now includes owner-scoped project create/versioned
patch/delete, notification list/read and in-app reminder dispatch. Web tests
pass 158 and Rust native tests pass 9. Latest unsigned arm64 bundle: 26.63
MiB, executable SHA-256
`4a3bf7afdc9bf62e40b12e540c2dc112b69fa89215ea2a38d5a33e719947207e`.

## Native AI execution follow-up

Native IPC now routes AI run create/get/cancel and the event stream through
typed operations. Rust parses an allowlisted SSE event set, removes known secret
field names recursively, and returns a typed event batch to the WebView; the
provider secret and model execution remain backend-owned. Web tests: 159;
Rust native tests: 11. Latest unsigned arm64 bundle: 26.71 MiB, executable
SHA-256
`b330033d07c87b8d2a3e55d1fa8f967f8b7c7d6be05104d73ce5f2069110068f`.
The bundle was rebuilt and relaunched; backend health returned OK. The native
AI event stream uses a bounded 300-second timeout, while ordinary native API
requests remain bounded at 15 seconds.

Explicit recovery follow-up: the entry/settings permission notice now offers
«Разрешить доступ macOS». This action requests OS permission for one fixed
Aelys session/policy item and returns presence only. It never logs in, resumes,
rotates credentials or toggles biometrics. Status is rechecked afterwards;
Touch ID remains explicit. Owner permission/fingerprint acceptance is still
open; no OS prompt was approved by the agent. See
[recovery behavior and checks](docs/optimization/macos-touch-id.md).

The owner-requested entry redesign is now bundled: neutral canvas, centered
Touch ID/password form, concise Keychain recovery and secondary footer tools.
202 web tests, typecheck and build pass; real native Touch ID/password screens
and browser narrow/server-form layouts were inspected. See [design evidence](docs/optimization/auth-entry-design.md).

The local integration gate and native sign-out/session-expiry corrections are
recorded in [the integration checkpoint](docs/INTEGRATION_CHECKPOINT.md). Previous test counts above describe their dated slices.
