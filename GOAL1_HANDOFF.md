# Goal 1 Handoff: Backend and macOS Runtime

Updated: 2026-10-28

Goal 1 delivers a tested FastAPI/PostgreSQL backend and a fail-closed headless macOS runtime foundation. The current OpenAPI artifact is [docs/openapi.json](docs/openapi.json); it contains 65 paths under `/api/v1`.

## Implemented modules

| Module | Status | Current coverage |
|---|---|---|
| Authentication and devices | Implemented | Owner bootstrap/login/refresh/logout, device enrollment, device-bound access tokens, revocation, refresh-token rotation, ownership checks. |
| Projects and resources | Implemented/partial | Project CRUD, project/device grants, resource relationships, backlinks through resource links. Irreversible-operation confirmation is not a separate finalized workflow. |
| Notes and knowledge | Implemented/partial | Markdown notes, project/parent references, revisions, restore, search, sync conflict branches. Attachments, tags/folders, internal-link indexing, and OCR are not implemented. |
| Tasks and calendar | Implemented/partial | Tasks, parent tasks, priority/status/due dates/recurrence, reminders, timezone-aware events, all-day events, task links, sync conflicts. Dashboard aggregations and full notification delivery are not implemented. |
| Finance | Implemented/partial | Accounts, categories, budgets, Decimal transactions, idempotency, summaries. Transfer balancing, exchange-rate sources, and bank integrations are not implemented. |
| Focus/timer | Implemented/partial | Focus sessions, stop operation, elapsed-time calculation, active-session protection. Full pause/resume/stopwatch and cross-device timer conflict UX remain for Goal 2. |
| Mail | Model implemented | Local mail accounts/messages/drafts and ownership checks. Gmail OAuth, provider senders, live receive/send, and extracted-task workflows remain OPEN/deferred. |
| AI harness | Implemented/partial | Claude/OpenRouter adapters, encrypted BYOK storage, routing, privacy/budget policy, typed tools, Decimal usage/cost tracking, SSE, durable cancellation, conversations and runs. A full product-level source-citation and tool workflow remains client integration work. |
| Automation | Implemented | Rule CRUD, enable/disable, dispatch, deduplication, dry-run, execution records, policy references and audit metadata. |
| Sync | Implemented | Versioned operations, idempotent receipts, conflicts and note branches, ordered pull, snapshot-bound bootstrap, retained tombstones, stale-cursor reset, device acknowledgements, private-agent-content rejection. |
| Mac session reader | Implemented/partial | Explicit-root discovery, incremental revisions, Claude/Codex JSONL parsers, local SQLite/FTS, cloud-safe metadata projection. Native vendor format compatibility remains version-gated. |
| Mac runtime channel | Implemented foundation | Authenticated outbound WebSocket, heartbeat, run leases/events, revocation handling, metadata allowlist, credential-lease exchange, reconnect behavior. |
| Mac run lifecycle | Implemented foundation | Idempotency, leases, cancellation, process-tree cleanup, SQLite restart reconciliation, executable identity binding, Keychain lease broker. |
| Isolation and provenance | Implemented fail-closed foundation | Seatbelt profile/probe path, six escape checks, canonical root/profile/runtime/probe digests, signed device attestation, signed release-manifest verification. Actual release signing/notarization remains Goal 3. |
| Search/history/notifications | Implemented/partial | Authorized server search, activity/history/notification APIs and read state. Mac content search is correctly unavailable when the Mac is offline; frontend relay/citation UX remains Goal 2. |

Telegram, Android, React/Tauri UI, Gmail connectivity, production deployment, backups, release signing, and notarization are not Goal 1 deliverables.

## API readiness

The generated contract is available at [docs/openapi.json](docs/openapi.json). The API is versioned under `/api/v1` and includes:

- Auth, devices, projects, grants, resources, notes, revisions, tasks, reminders, calendar, finance, focus, mail, search, history, activity, and notifications.
- Sync push/pull/status/ack/bootstrap with opaque owner-bound cursors.
- AI providers, encrypted secret storage, conversations, messages, runs, SSE events, and cancellation.
- Agent devices, cloud-safe session metadata, offline Mac search response, runs, SSE events, cancellation, and signed credential leases.
- Automation rules, executions, dry-run, and dispatch.

The two SSE routes are `/api/v1/ai/runs/{run_id}/events` and `/api/v1/agents/runs/{run_id}/events`; both advertise `text/event-stream`. The authenticated Mac channel is the WebSocket `/api/v1/agents/channel`, which is not represented as a normal OpenAPI path.

For Goal 2, generate TypeScript clients from `docs/openapi.json`; do not hand-copy response shapes. The frontend must keep durable local state and an outbox, use `operation_id` for sync idempotency, acknowledge applied pull/bootstrap cursors through `/api/v1/sync/ack`, and treat `409 SYNC_RESET_REQUIRED` as a bootstrap request. Use a normal owner access token for owner APIs and the device access token returned by enrollment for device-bound sync/runtime calls.

The first-owner `/api/v1/auth/bootstrap` route is intentionally excluded from the public OpenAPI schema and must be disabled or protected after initial enrollment. Provider secrets are write-only API inputs; they must never be displayed or placed in frontend state.

## Exact skipped tests

The current default test command is:

```sh
AELYS_SECRET_KEY='test-only-aelys-secret-key-0123456789' \
  PYTHONPATH=backend .venv/bin/pytest -q -rs backend/tests
```

It currently reports **40 passed, 2 skipped**. Both skipped tests are in `backend/tests/test_postgres_integration.py`:

1. `test_mounted_sync_route_uses_postgres_and_is_device_bound` at line 18: skipped because `AELYS_DATABASE_URL` is not configured.
2. `test_mounted_postgres_bootstrap_page_is_snapshot_bound_and_pull_reset_is_documented` at line 44: skipped because `AELYS_DATABASE_URL` is not configured.

When PostgreSQL is configured, both pass. The local validation command used for this handoff is:

```sh
pgpw=$(docker exec restored-postgres cat /run/secrets/postgres_password)
export PGPASSWORD="$pgpw"
export AELYS_DATABASE_URL='postgresql+asyncpg://postgres@127.0.0.1:55432/aelys_goal_pg2'
export AELYS_SECRET_KEY='test-only-aelys-secret-key-0123456789'
cd backend
PYTHONPATH=. ../.venv/bin/alembic check
PYTHONPATH=. ../.venv/bin/pytest -q tests/test_postgres_integration.py
```

## Local vendor validation procedure

The installed binaries currently report Claude Code `2.1.311` and Codex CLI `0.163.0`. Their required non-interactive help flags are present:

```sh
claude --version
claude --help | rg -- '--print|--output-format|stream-json'
codex --version
codex exec --help | rg -- '(^|[[:space:]])--json|--ephemeral|(^|[[:space:]])exec'
```

That is compatibility evidence only. It does not authenticate, execute a task, or prove sandbox safety.

To perform the real local validation on a disposable approved project:

1. Run on a supported macOS host with the exact installed binaries. Do not read or copy `~/.codex/auth.json`, Claude session files, or any raw credential into the repository, logs, HTTP payloads, or test fixtures.
2. Store the provider credential in the fixed macOS Keychain service/account expected by the runtime. The runtime accepts only the Aelys provider namespaces and `default` account.
3. Configure the backend runtime signing key and generate the release trust values from the exact runtime and isolation-probe bytes:

   ```sh
   AELYS_RUNTIME_TRUST_PRIVATE_KEY='<base64url key held outside the repo>' \
     PYTHONPATH=. ../.venv/bin/python scripts/generate_runtime_manifest.py \
       --runtime <runtime-binary> \
       --probe <aelys-isolation-probe> \
       --manifest-id <release-id>
   ```

   Set the emitted public key and manifest as `AELYS_RUNTIME_TRUST_PUBLIC_KEY` and `AELYS_RUNTIME_TRUST_MANIFEST`. Keep the manifest signing private key outside the repository.
4. Enroll the Mac device, create the project grant, and keep the grant unvalidated until the probe completes. Run the local isolation probe with `cargo run --example sandbox_validate`; for a real grant, use `cargo run --example attest` with the documented `AELYS_*` variables and the exact approved project/outside/symlink/credential probe paths.
5. Confirm the backend acknowledges the signed attestation and that the trust manifest matches the runtime and probe digests. A missing or invalid trust root must return `POLICY_DENIED`.
6. Create a run through `POST /api/v1/agents/runs`, let the helper claim it over `/api/v1/agents/channel`, request a signed credential lease over HTTP or the WebSocket channel, and verify that the runtime validates scope, expiry, signature, and replay before any Keychain read.
7. Only after all of those checks pass may a release-specific compatibility branch enable a real authenticated vendor invocation. Record stdout/stderr as redacted status evidence only; never store transcripts or provider secrets.

The current repository deliberately stops before step 7: `VendorAdapter::probe_support()` keeps `can_run=false`, and `IsolationGate::validate()` remains unavailable until the supported macOS isolation/signing release process is established. No authenticated vendor execution is claimed to have passed.

## Outstanding external blockers

- Authenticated Claude Code and Codex CLI execution on the installed versions, including provider-specific login behavior and JSONL/session compatibility.
- A supported macOS helper release identity, code signing, notarization, installer/uninstaller, and independent signing-chain evidence. These are deferred to Goal 3.
- Provisioning of the signed runtime/probe trust manifest in the deployment environment.
- Final macOS Seatbelt validation evidence across supported macOS versions.
- Goal 2 frontend durable stores, generated TypeScript clients, sync UX, local Mac search relay/citations, and device/grant UX.

## Goal 2 integration instructions

Start from `docs/openapi.json` and the API readiness section above. Build the frontend around a durable local store and outbox. Implement login/device enrollment, project/grant screens, notes/tasks/calendar/finance/mail/AI views, sync retry/conflict/reset UX, SSE consumption, and Mac-online/offline states. Treat agent session bodies, prompts, commands, paths, snippets, and embeddings as Mac-local data; only render cloud allowlisted metadata received from the backend. Use the backend’s typed error codes, especially `VERSION_CONFLICT`, `SYNC_RESET_REQUIRED`, `MAC_OFFLINE`, `POLICY_DENIED`, `DEVICE_REVOKED`, and `LEASE_UNAVAILABLE`.

Goal 3 owns production PostgreSQL deployment/backups, macOS helper packaging, signing/notarization, installer lifecycle, final supported-version sandbox evidence, and release license confirmation.
