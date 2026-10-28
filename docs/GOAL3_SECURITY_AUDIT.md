# Goal 3 Security / MVP Audit

**Date:** 2026-10-28
**Scope:** current checkout at /Users/tileuzhan/vsCode/aelys; backend, runtime, desktop, mobile, web, shared client, tests, migrations/OpenAPI, and the repository documentation pack.
**Change made:** this document only. Existing CLAUDE.md, .claude/, and all production code were preserved.

## Executive assessment

Goal 3 is **not release ready**. The repository has useful fail-closed foundations and meaningful unit/integration coverage for device credential rejection, sync privacy validation, BYOK ciphertext handling, runtime metadata allowlisting, lease/idempotency state, and sandbox attestation plumbing.

The release gate remains open because:

- logout does not revoke the authenticated session, and access tokens are not checked against a revocable session record;
- agent metadata and live-search routes do not enforce project grants;
- the mounted automation API has only a bounded task/notification action set and
  still lacks durable rate limits and failure retry audit;
- the web/native clients do not yet provide end-to-end durable local entity storage and crash/restart sync recovery;
- authenticated vendor execution, packaged macOS isolation evidence, helper lifecycle, signing/provenance deployment, Android APK validation, Gmail OAuth, and Telegram delivery are absent or intentionally blocked.

No successful vendor execution, macOS signing, Android build, Gmail integration, or Telegram integration is claimed by this audit.

Status meanings: **Verified** means current source plus a focused repository test or explicit fail-closed behavior supports the claim. **Unverified** means partial implementation or test evidence exists but the approved end-to-end scenario is not proven. **Blocked** means the capability is intentionally unavailable, missing, or an unresolved decision prevents acceptance.

The prioritized findings below preserve the original audit evidence. The lead's
remediation status at the end of this document is authoritative for the current
checkout.

## Prioritized findings

### G3-01 — High: logout is a no-op and access-token revocation is incomplete

**Evidence**

- backend/app/core/api.py:42-44 returns logged_out without loading or revoking AuthSession.
- backend/app/core/security.py:55-68 validates bearer signature, expiry, owner, and optional device revocation, but does not look up a session identifier or revoked access-token record.
- backend/app/core/security.py:25-32 creates access tokens without a session identifier.
- backend/app/core/api.py:20-24 creates a login access token and a refresh session separately; line 22 does not bind that login session to a device.
- backend/app/core/models.py:28-36 has revocable refresh-session rows, but no access-session binding or access-token revocation field.
- backend/tests/test_core.py:24-40 proves device revocation and refresh rotation, but does not prove logout invalidates the current access or refresh session.

**Impact**

A bearer access token remains usable until expiry after logout. A refresh token remains usable until rotation/revocation by another path. This fails the approved authentication/session revocation requirement.

**Remediation**

Add an opaque session identifier to access and refresh claims, persist the active session/device binding, check active/revoked state in current_principal, and make logout revoke the current session atomically. Add negative tests for access, refresh, WebSocket, sync, SSE, and agent routes after logout/revocation.

### G3-02 — High: project grants are not enforced for agent metadata or live search

**Evidence**

- backend/app/agents/api.py:211-220 lists/searches AgentSessionIndex by owner and optional project_id; it does not require an active project grant, device scope, or data-egress policy.
- backend/app/agents/api.py:126-151 accepts metadata from an authenticated runtime device and checks project ownership, but does not check an active ProjectGrant. accepted.append(item) occurs before project validation, so the acknowledgement count can include rejected items.
- backend/app/agents/api.py:223-227 correctly requires a validated project grant for run creation, showing that the stronger gate exists for runs but is absent for metadata/search.
- docs/AGENT_RUNTIME.md requires server verification of owner, Mac device, project, and tool scope for remote search.

**Impact**

An authenticated owner token can enumerate metadata for any owner project, and a connected Mac device can publish metadata for an owner project without the grant boundary used by remote execution.

**Remediation**

Centralize an authorization helper requiring owner, non-revoked device, project grant, permitted operation, and egress policy. Apply it to metadata ingestion, session listing, search, snippets, run creation, credential leases, and WebSocket messages. Add negative tests for missing, revoked, mismatched-device, and mismatched-project grants.

### G3-03 — High: mounted automation durability is incomplete

**Evidence**

- backend/app/automation/api.py registers typed `create_task` and
  `create_notification` handlers through `ToolRegistry` and
  `ServerPolicyEngine`, with owner/project validation and a unique event claim.
- backend/tests/test_automation_api.py covers strict action rejection, policy
  denial, project scope and concurrent duplicate dispatch.
- durable windowed rate-limit receipts and failed execution audit are now
  enforced by the route; the mounted handlers still write through the current
  route transaction rather than a separate durable domain service, and retry
  worker orchestration remains absent.

**Impact**

The remaining release risk is durability and operational audit: a configured
rate limit is not enforced across processes and a failed transaction does not
leave a durable retry record. The authorization boundary itself is now present
for the bounded mounted action set.

**Remediation**

Keep the registered typed ToolRegistry/policy path, then add durable rate-limit
records, failure/retry audit and full domain-service dispatch. Preserve the
database uniqueness claim and route-level scope tests.

### G3-04 — High: offline-first durability and write idempotency are not proven end to end

**Evidence**

- packages/shared/src/api-client.ts:125-138 adds an Idempotency-Key header and :151-160 queues failed mutations.
- packages/shared/src/offline.ts now provides `setEntityAndEnqueue`, which stores the entity and sanitized request in one IndexedDB transaction; the focused shared tests cover the primitive.
- apps/web/src/views/ModuleView.tsx now supplies an optimistic entity key/value for project, note and task creates; the API client selects the atomic capability when available.
- backend/app/domains/api.py:49-60, :65-71, and :84-86 use plain dictionaries or do not consume the header.
- apps/mobile/src-tauri/src/lib.rs:10-16 explicitly describes native SQLite as a follow-up spike.

**Impact**

A full cross-device workflow can still fail to meet the acceptance gate because
kill/restart, native SQLite storage, conflict recovery and server-side
idempotency receipts for every CRUD route remain unverified.

**Remediation**

Exercise the implemented durable per-client entity store through kill/restart,
push, pull and acknowledgement tests; implement native stores where required.
Enforce one server idempotency contract for every state-changing route,
including payload binding and owner/device scope.

### G3-05 — High: production HTTP hardening is not visible

**Evidence**

- backend/app/main.py:14-35 creates the FastAPI app and mounts routers without global security dependency, trusted-host middleware, CORS policy, request-size policy, or production exception/logging configuration.
- backend/app/core/security.py now uses the reusable `HTTPBearer` dependency and
  docs/openapi.json exposes the bearer scheme; route-level security requirements
  are still inferred rather than applied globally.
- backend/app/core/api.py:46-52 exposes public bootstrap, hidden from schema but not disabled or protected after initialization.

**Impact**

Generated clients and operators cannot reliably distinguish public and protected endpoints. Bootstrap behavior relies on an operational assumption rather than a release control.

**Remediation**

Use a reusable bearer security dependency in protected routers and regenerate OpenAPI with explicit security requirements. Add deployment-controlled trusted hosts, strict CORS only where needed, request/body limits, rate limits for login/bootstrap/refresh and expensive routes, and a deliberate one-time bootstrap lock.

### G3-06 — High: remote vendor execution and sandbox provenance remain blocked

**Evidence**

- apps/runtime/src/adapter.rs:102-124 keeps can_discover_sessions, can_resume_sessions, and can_run false even when version/help flags are detected.
- apps/runtime/src/isolation.rs:27-34 defaults the gate to unavailable; :75-84 always returns unavailable pending the macOS validation spike.
- apps/runtime/src/process.rs:99-105 refuses execution unless the adapter capability probe permits it.
- backend/app/core/api.py:88-97 creates grants with isolation_validated=False; backend/app/agents/api.py:226-227 rejects runs until it is true.
- apps/desktop/src-tauri/src/lib.rs:11-39 exposes status/capability probes only and hard-codes vendor_execution_enabled false.
- apps/desktop/src-tauri/tauri.conf.json:28-31 disables bundling; helper installation, signing, notarization, and uninstall are absent.

**Impact**

The run acceptance path is correctly fail-closed, but the approved remote-run scenario is unavailable. Enabling it before packaged macOS evidence, trusted release-manifest deployment, and helper provenance would violate the security gate.

**Remediation**

Keep execution disabled. Complete a supported macOS spike covering packaged helper identity, signed release-manifest/trust-root deployment, Seatbelt behavior, symlink/../subprocess/credential/network escapes, resource limits, process-tree cleanup, and revocation during an active channel.

### G3-07 — High: BYOK encryption exists, but production secret-store isolation and rotation are unverified

**Evidence**

- backend/app/ai/api.py:114-123 encrypts the submitted key and returns only the last four characters.
- backend/app/ai/crypto.py:6-14 derives the AES-GCM key directly from AELYS_SECRET_KEY; backend/app/core/config.py:5-13 has one application secret and a key_version column exists at backend/app/core/models.py:156-162.
- backend/app/ai/api.py:95-105 reconstructs an in-memory SecretStore for each provider call.
- backend/app/ai/secrets.py:22-27 calls the portable cipher a development/self-hosted implementation and recommends an injected KMS/keychain for production.
- Ciphertext/no-plaintext tests exist in backend/tests/ai_automation/test_execution.py:42-45 and backend/tests/ai_automation/test_ai_harness.py:44-53.

**Impact**

Authenticated encryption and response redaction are demonstrated, but production key custody, rotation, multi-process access control, deletion, and provider-specific egress isolation are not proven. A compromise of the application master secret exposes all stored provider credentials.

The current checkout now provides authenticated owner-scoped secret deletion,
a separate `AELYS_PROVIDER_ENCRYPTION_KEY` path, and an operator rotation
script that re-encrypts envelopes and increments `key_version`; KMS custody and
provider egress isolation remain release gates.

**Remediation**

Define and implement the approved secret-store boundary before release: external KMS/OS keychain or documented self-hosted equivalent, key-version rotation and re-encryption, ownership checks, deletion/revocation, redacted error/log tests, and provider egress policy tests.

### G3-08 — Medium/High: AI tool authorization and privacy egress are library-level, not a complete API capability

**Evidence**

- backend/app/ai/policy.py:22-32 and backend/app/ai/tools.py:53-63 provide a policy-aware typed tool boundary.
- backend/app/ai/api.py now stores a conversation-scoped tool policy, rejects per-run scope escalation, and binds each run to its prompt/provider identity.
- The mounted path now executes only the server-registered task/note tool subset through typed validation and `ServerPolicyEngine`; it still does not provide the full retrieval/local-session egress tool surface.
- Prompt-injection/redaction tests exist in backend/tests/ai_automation/test_ai_harness.py:69-89, but they test the library boundary, not a full email-to-tool or agent-session-to-provider route.

**Impact**

The repository now proves bounded task/note tool use and scope rejection, but does not prove note retrieval, injection-triggered external-effect rejection, or a per-project/provider local-session egress switch.

**Remaining remediation**

Expand the server-derived tool registry and owner/project policy, mark retrieved content untrusted at the API boundary, add local_only/provider-egress decisions, and add integration tests for email injection, agent snippets, external effects, and cancellation.

### G3-09 — Medium: browser token storage and Tauri CSP weaken the client boundary

**Evidence**

- apps/web/src/lib/api.ts:4-5,37-49,58-64 stores the access token in JavaScript-readable sessionStorage.
- apps/desktop/src-tauri/tauri.conf.json:24-25 and apps/mobile/src-tauri/tauri.conf.json:14-15 allow script-src 'unsafe-eval' and style-src 'unsafe-inline'.
- apps/web/index.html:1-13 has no visible CSP.
- packages/shared/src/offline.ts:59 correctly avoids putting the bearer token into the IndexedDB outbox, but this does not protect the live browser token from XSS.

**Impact**

Script execution in the web origin can read the active access token. Tauri permits eval-like execution, increasing renderer compromise impact.

**Remediation**

Prefer a server-managed session or short-lived device-bound token with a non-script refresh flow. Add strict production CSP without unsafe-eval, narrow development exceptions to dev builds, and add security-header checks.

### G3-10 — Medium: domain input contracts are inconsistent with the security model

**Evidence**

- backend/app/domains/api.py:49-60, :65-71, :76-86, and :196-207 accept untyped dictionaries for resource, project patch, link, category, and budget writes.
- backend/app/automation/api.py:21-26 accepts an untyped patch body.
- The API contract requires typed request/response models and idempotency for writes, but these routes do not consistently enforce unknown-field rejection, payload limits, or header idempotency.
- backend/app/core/models.py:129-134 stores decimal finance fields, but there is no transfer relation/integrity model; backend/app/domains/api.py:227-238 only has start/stop focus behavior.

**Impact**

Malformed or out-of-contract fields can be accepted, and transfer balancing, timer pause/restart, and all accepted CRUD idempotency/recovery behavior are not proven.

**Remediation**

Replace write dictionaries with strict Pydantic models, validate enum/range/timezone/reference constraints, bind foreign references to the authenticated owner, implement version/idempotency preconditions consistently, and add finance transfer and timer lifecycle tests.

### G3-11 — Medium: deployment, backup, deletion, and retention evidence is missing

**Evidence**

- docs/OPEN_QUESTIONS.md keeps Mac-session backup policy and provider-key placement open.
- docs/SECURITY.md requires encrypted/restorable PostgreSQL backups but leaves Mac-only session backup open.
- No production deployment, encrypted backup, restore drill, account deletion/export, or local wipe implementation appears in the current file tree.
- apps/desktop/src-tauri/tauri.conf.json:28-31 disables distributable bundling/updater artifacts.

**Impact**

Cloud persistence and recovery boundaries are not release-verifiable. Restore, deletion, retention, and helper uninstall behavior cannot be claimed.

**Remediation**

Resolve the open decisions, implement a self-hostable deployment/backup topology, add encrypted backup/restore drills for synced data, keep Mac-only sessions off cloud backup by default, and add retention/deletion/export and helper/local-store wipe tests.

## Approved MVP acceptance audit

The following matrix audits every checkbox in docs/ACCEPTANCE_TESTS.md.

| ID | Acceptance item | Status | Current evidence |
|---|---|---|---|
| A1 | Enroll Mac and Android; revoke Android and prove credential fails | Unverified / Blocked | Backend enrollment/revocation exists (backend/app/core/api.py:64-78; backend/tests/test_core.py:24-34). Android APK/device evidence is absent (apps/mobile/README.md; apps/mobile/src-tauri/src/lib.rs:10-16). |
| A2 | Create project; link task, note, calendar event; backlinks resolve | Unverified | Project/resource/link endpoints exist (backend/app/domains/api.py:45-89), but no end-to-end backlink evidence. |
| A3 | Markdown notes persist across relaunch; revisions restore | Unverified | Revisions are written (backend/app/domains/api.py:94-121), but relaunch durability and user-selected revision restore are not proven. |
| A4 | Task subtasks, priority, recurrence, due date and filters | Unverified | Fields exist (backend/app/domains/api.py:17-18; backend/app/core/models.py:99-109), but hierarchy constraints and required filters are not demonstrated. |
| A5 | Offline changes survive kill/restart and reach another device | Unverified / Blocked | IndexedDB entity-plus-outbox transaction and web create wiring are implemented and unit-tested; kill/restart, native stores and cross-device recovery remain unverified. |
| B1 | Repeated identical sync batch applies exactly once | Verified for backend sync boundary | Receipt replay handling is in backend/app/sync/service.py:53-100; focused sync tests are present. Client CRUD E2E remains unverified. |
| B2 | Concurrent Markdown edits preserve both branches | Verified for sync engine / Unverified end to end | Sync tests cover conflict behavior; no full cross-device recovery path is shown. |
| B3 | Commit-order pagination/bootstrap never skips writes | Verified | Fresh temporary PostgreSQL migration and integration run passed; repository sync concurrency/bootstrap tests remain recorded. |
| B4 | Tombstone and stale-device reset | Verified for repository-recorded backend evidence | Reset/compaction code and sync tests exist; native-client reset recovery is not shown. |
| B5 | 100-operation offline stress test | Partial / Unverified | Shared IndexedDB entity-plus-outbox test reopens after 100 operations; Web/macOS/Android kill/restart and cross-device stress evidence is still absent. |
| B6 | Private Mac session contents excluded from sync/cloud DB | Verified for boundary | Raw agent_session is rejected and index fields are allowlisted (backend/app/sync/validation.py:128-155; apps/runtime/src/metadata.rs:5-20). Full deployed log/telemetry inspection remains unverified. |
| C1 | Exact decimal finance and balanced transfers | Unverified / Blocked | Decimal columns/arithmetic exist, but transfer integrity is not implemented (backend/app/core/models.py:129-134). |
| C2 | Duplicate offline transaction is one posting | Unverified | Transaction idempotency is optional in the body (backend/app/domains/api.py:21-22,214-222); no client crash/retry or uniform server receipt. |
| C3 | Timer pause/restart/sleep and conflict handling | Unverified | Start/stop and one-active check exist (backend/app/domains/api.py:227-238); pause, sleep recovery, and cross-device semantics are absent. |
| C4 | Imported EML searchable/draftable; Gmail not claimed without OAuth | Partial / Unverified | Local mail/import/draft entities exist (backend/app/domains/api.py:239-258); Gmail OAuth is absent and correctly unclaimed. |
| C5 | Telegram linking and unknown-chat rejection | Blocked | No Telegram implementation or route exists; docs/INTEGRATIONS.md keeps live Bot API scope open. |
| C6 | Telegram webhook redelivery deduplication | Blocked | No Telegram webhook handler exists. |
| D1 | BYOK encrypted at rest, absent from API reads/logs | Partial / Unverified | AES-GCM storage and last-four response are implemented/tested; production key custody/rotation/log inspection are not proven. |
| D2 | Routing respects capabilities, budget, privacy, manual override | Partial / Unverified | Router/model tests exist; mounted AI route uses a fixed request budget and does not derive scope from authorized policy. |
| D3 | AI finds note and writes task through typed permissioned tool | Partial / Unverified | Mounted API now executes the bounded server-registered task/note tools through validation and policy; retrieval, broader tools and prompt-injection E2E remain unverified. |
| D4 | Email prompt injection cannot trigger send/shell | Partial / Unverified | Untrusted-data/policy unit tests exist; no complete email-to-tool integration, and live send/shell actions are absent. |
| D5 | Streaming cancellation/timeout has stable final state | Verified for backend lifecycle evidence | Durable cancellation and compare-and-set completion exist (backend/app/ai/api.py:167-213); focused tests are present. |
| E1 | Claude/Codex compatibility detectable | Verified as conservative probe only | Version/help probes exist; adapters remain can_run=false (apps/runtime/src/adapter.rs:102-124). This is not successful vendor execution. |
| E2 | Selected history indexed locally; unrelated directories excluded | Partial / Unverified | Authorized-root and symlink checks exist (apps/runtime/src/paths.rs:11-48; apps/runtime/src/discovery.rs:39-125); packaged evidence is absent. |
| E3 | Remote mobile query returns local citations when Mac online | Blocked | backend/app/agents/api.py:216-220 always returns MAC_OFFLINE with metadata-only results; live relay/search is not implemented. |
| E4 | Mac offline returns explicit MAC_OFFLINE | Verified | Current search route returns that explicit status (backend/app/agents/api.py:216-220). |
| E5 | No transcripts/snippets/embeddings in Postgres, logs, telemetry, sync | Partial / Unverified | Schema/allowlist boundaries are tested; deployed logging, telemetry, and full request-path inspection are not evidenced. |
| E6 | Provider egress disabled keeps excerpts local | Unverified | Architecture specifies the policy, but mounted AI has no complete local-session egress enforcement. |
| F1 | Authenticated owner run reaches queued/running/completed | Blocked | Backend requires validated isolation (backend/app/agents/api.py:221-227); runtime adapter/gate stay unavailable. |
| F2 | Replayed job cannot launch duplicate process | Verified for state/idempotency evidence | Backend/runtime idempotency and lease tests exist; vendor execution remains disabled. |
| F3 | In-sandbox file modification/tests without per-command approval | Blocked | No authenticated vendor run is enabled; only test adapters/process primitives exist. |
| F4 | Outside-project access blocked/logged via symlink/subprocess | Partial / Unverified | Seatbelt profile/probe and runtime tests exist (apps/runtime/src/sandbox.rs:55-74,184-209), but supported packaged evidence and audit-log proof are absent. |
| F5 | Network/git push/deploy unavailable without separate grant | Partial / Unverified | Network policy is represented, but the complete vendor/action policy path is not active. |
| F6 | Cancel kills process tree; restart leaves no orphan | Verified for runtime primitives / Unverified release E2E | Process cleanup and restart reconciliation tests exist; helper/vendor release lifecycle is absent. |
| F7 | Revoking project grant prevents new runs | Verified for backend gate | Run creation requires a non-revoked, isolation-validated matching grant (backend/app/agents/api.py:223-227). |
| G1 | Duplicate event executes one rule once | Partial / Unverified | In-memory engine and database uniqueness are present; mounted dispatch lacks a race-safe policy service transaction. |
| G2 | Out-of-scope tool attempt denied regardless of model content | Verified for policy library / Unverified mounted path | Policy tests prove the primitive; API tool execution is incomplete. |
| G3 | Dry run, audit, rate limit, disable stop execution | Partial / Unverified | Mounted policy, duplicate claims, durable windowed rate limits and failed execution audit are covered; complete dry-run durability and retry worker orchestration remain open. |
| H1 | New developer starts with sample config and no private secrets | Verified for documented local setup | READMEs and CLAUDE.md provide local commands and secret requirements; no clean-machine reproduction here. |
| H2 | CI runs unit/integration/type/lint/security checks | Verified for recorded CI evidence | .github/workflows/ci.yml and PROGRESS.md record Python, Rust, TypeScript, migration, OpenAPI, Bandit, and dependency checks; no fresh CI run here. |
| H3 | Final license confirmed before release | Blocked | docs/DECISIONS.md ADR-019 remains PROPOSED; docs/OPEN_QUESTIONS.md keeps license confirmation open. |
| H4 | Mac helper installer/uninstaller and opt-in removal | Blocked | Desktop bundling is disabled and no helper lifecycle exists (apps/desktop/src-tauri/tauri.conf.json:28-31). |
| H5 | Android APK with offline storage/notification tests | Blocked | apps/mobile/README.md explicitly says Android support is unclaimed; apps/mobile/src-tauri/src/lib.rs:10-16 identifies native SQLite as a follow-up spike. |

## Safe remediation order

1. Close the identity boundary: session-bound access tokens, real logout revocation, refresh/session rotation, and negative tests across REST, sync, SSE, and WebSocket.
2. Centralize authorization: explicit OpenAPI security, typed request models, owner-scoped references, project-grant checks for all agent paths, and device-platform restrictions.
3. Make every write replay-safe: durable local entity-plus-outbox transactions, then server idempotency and version preconditions for every state-changing route.
4. Restore Policy Engine as the only action boundary: remove direct automation writes, integrate typed AI tools, enforce privacy/egress policy, and add route-level injection tests.
5. Finish the release security spike: packaged macOS helper identity/signing/trust-root deployment and OS-level isolation on supported macOS versions. Keep vendor execution disabled until all evidence passes.
6. Close secret and recovery decisions: production BYOK key custody/rotation, encrypted backup/restore for synced data, deletion/export/wipe semantics, and the open Mac-session backup decision.
7. Treat external/platform features as explicit gates: complete Android APK/background-storage tests and approved Telegram/Gmail scopes before changing their status.

## Evidence and limitations

The repository records a prior validation summary in PROGRESS.md, including 40 Python tests and 44 Rust tests at the time of that note, and focused source tests are present under backend/tests/, apps/runtime/tests/, apps/web/src/tests/, and packages/shared/tests/. This audit did not rerun broad commands after the user requested completion; those recorded results are repository evidence, not a new independent green build.

The report intentionally does not claim successful vendor CLI execution, macOS helper signing/notarization, Android APK production, Gmail OAuth, or Telegram Bot API operation. Those remain blocked or open in the current repository.

## Post-audit remediation recorded by the lead

The following findings received local fixes after this audit snapshot:

- G3-01: new tokens are session-bound; `current_principal` checks the active
  session and logout revokes it; a regression test covers access and refresh
  rejection after logout, and active AI SSE streams now cancel when that
  session is revoked.
- G3-02: agent metadata ingestion/list/search now require the active owner,
  device and project grant boundary; route coverage was added to the API
  contract test.
- G3-04: shared/web now provide and exercise an IndexedDB entity-plus-outbox
  transaction for offline project, note and task creates. Full client recovery,
  native stores, cross-device conflict E2E and uniform server idempotency remain
  unverified.
- G3-03: mounted automation now uses strict typed action models, registered
  handlers, a database uniqueness claim for duplicate events, durable windowed
  rate-limit receipts and failed execution audit. Full domain-service dispatch
  and retry worker orchestration remain open.
- G3-06: mounted AI run requests now bind their prompt message and request
  fingerprint, repeated SSE readers cannot claim a queued run twice, and
  provider endpoints are restricted to approved HTTPS hosts. A bounded
  server-registered task/note tool loop now validates and authorizes provider
  calls; broader tool coverage, durable budget accounting and vendor execution
  remain open. The policy is conversation-scoped, provider identity is pinned
  to the run, provider redirects are disabled, and duplicate tool-call IDs are
  deduplicated. Redacted SSE event replay with sequence IDs and
  `Last-Event-ID` recovery is covered; DNS-level endpoint pinning remains open.
- G3-05: protected REST operations expose an HTTP bearer scheme in OpenAPI and
  the Makefile rejects empty snapshots before replacement.
- G3-11: encrypted owner export/restore is implemented and tested with an
  explicit exclusion list for credentials and raw Mac sessions.

G3-03, G3-04, G3-06, G3-07, G3-08, G3-09 and G3-10 remain partial or open as
described above; no security gate was weakened to make them pass.
