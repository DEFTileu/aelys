# AGENTS.md — Instructions for AI coding agents in Aelys repository

## Mission

Build **Aelys**: an entirely open-source, single-user, offline-first Personal OS (Web, macOS, Android) using React/TypeScript, macOS Tauri 2/Rust, FastAPI/Python and PostgreSQL. Preserve the architecture and decision status described in docs; do not invent scope or design.

## Read before touching code

1. `README.md`, `PROJECT_CONTEXT.md`, `DECISIONS.md`, `OPEN_QUESTIONS.md`
2. `PRD.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`
3. Domain doc relevant to current task: `DATA_MODEL`, `API_CONTRACTS`, `SYNC_PROTOCOL`, `AGENT_RUNTIME`, `AI_HARNESS`, `SECURITY`.

If docs live under `/docs`, adjust paths accordingly.

## Hard constraints

- No UI design or VPS provider selection without explicit instruction.
- Full CLI session transcripts + embeddings stay on Mac, never in cloud DB, logs, telemetry, attachments or client sync.
- Coding agents on Mac have access only to approved project sandbox. Do not disable CLI/sandbox security or allow arbitrary host filesystem as a shortcut.
- Automation always passes through Policy Engine; agent instructions or retrieved text never grant permissions.
- Offline first: client mutations durable in local store before sync; server writes versioned/idempotent.
- BYOK: encrypted secret store, never expose keys to frontend/logs or send to LLM as tool content.
- Finance numeric correctness: decimal, no float.
- Single-user product, but don't omit identity/device permissions.
- Any decision marked OPEN or PROPOSED remains so until owner approval / evidence-based spike.

## Work method

1. Select exactly one milestone/task from `IMPLEMENTATION_PLAN.md`.
2. Inspect existing project, file tree, git status and tests; preserve prior work.
3. State assumptions and unresolved OPEN questions in task notes.
4. Implement the smallest end-to-end vertical slice with typed contracts, migrations and tests.
5. Run relevant unit/integration/type/lint tests, report exact results.
6. Update docs/decision register only for actual approved decisions.
7. Give concise completion report: files changed, commands run, passing/failing tests, risks, next task.

## Language and conventions

- Code/symbols in English. Specs originally in Russian; project README can later be bilingual.
- Python: type hints, Pydantic, Alembic migrations, pytest.
- TS: strict typing, generated API types where available.
- Rust: explicit permission checks and process supervision for macOS helper.
- API URLs `/api/v1` and typed error codes, stable idempotency keys.
- Don't introduce unnecessary microservices, queues/vendors, or additional SDKs without technical justification.

## Wiring a new API route or native feature

The Mac and Android apps send every API call through the native transport, not
straight to the server. A route that is not wired there passes backend and web
tests (they mock the client) and then fails on the device without any server log.

- `packages/native-transport/src/transport.rs`: add the method and path (under
  `/api/v1`, `*` is exactly one id segment) to `API_ALLOWLIST`. Add it to
  `SLOW_API` too if the server may take longer than 15 s (model calls). Extend
  the allowlist tests next to `generic_api_route_is_allowlisted`. Query keys may
  only be lowercase letters and `_`. Auth, device, sync and credential routes
  stay out of the list on purpose.
- `packages/shared/src/api-client.ts`: `mutationFamilies` maps a path prefix to
  cache families, so a new route under an existing prefix (for example
  `/api/v1/focus`, which is the Pomodoro timer) invalidates that family; pass a
  `cacheKey` only when a stale read is harmless.
- Native plugin commands: list them in the plugin's `build.rs` and
  `permissions/default.toml`, and grant the plugin in the app's
  `capabilities/default.json`.
- A feature that needs Android permissions, an accessibility service or the
  native transport is not complete until it ran on a real device. Say "not
  verified on device" in the completion report instead of relying on mocked tests.
- Before publishing an APK, scan it for local paths and personal data (Rust
  panic messages embed the home directory; build with
  `RUSTFLAGS="--remap-path-prefix=$HOME=/home/build"`).

## Completion gate

Do not claim a module is complete if any essential requirement is mocked, tests are absent, security isolation is unverified, or app isn't functionally accessible. Mark spikes/prototypes clearly.

## Git workflow

Follow [docs/GIT_WORKFLOW.md](docs/GIT_WORKFLOW.md) for Conventional Commits,
atomic commits, explicit staging, validation before commits, multi-agent Git
coordination, repository hygiene, and pull request standards. Do not stage or
commit unrelated agent work, and do not bypass hooks or security checks.
