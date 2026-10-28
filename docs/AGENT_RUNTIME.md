# Aelys — Local Agent Runtime & Remote Execution v0.2

## 1. Scope

Aelys supports **Claude Code** and **Codex CLI** on macOS. Two independent features:
1. `Session Reader`: discover, parse, locally index and search agent session history.
2. `Agent Runner`: start/cancel/monitor agent commands remotely with **project-scoped autonomous execution**.

Full session transcripts, source snippets, raw logs and local FTS index remain on Mac. Backend holds sanitized metadata and command status only. Backend is not remote shell with unrestricted command execution.

## 2. Runtime packaging

- Tauri desktop app controls configuration, onboarding and status.
- Background macOS helper required if reading/indexing must continue while UI window is closed. Install/start only after explicit opt-in; clear stop/uninstall path.
- Rust or supervised local service for filesystem watching/CLI process lifecycle; no requirement to use same language for every adapter.
- A helper holds device-bound credentials, makes an **outbound authenticated** connection to backend (proposed WebSocket), uses heartbeat/lease/reconnect.
- The same device channel can request a backend-signed credential lease; the lease is bound to the run, device, project, grant, provider, expiry, and nonce, and contains no provider secret.

## 3. Session Reader adapters

`ClaudeCodeReader` / `CodexCLIReader` each implement:

```text
probe_support() -> AdapterCapabilities
list_sessions(authorized_paths, since_cursor) -> SessionMetadata[]
read_session(local_session_ref) -> messages/events
index_incrementally(session_ref, source_revision) -> LocalIndexResult
search(query, allowed_project_ids, limit) -> LocalHits
```

Requirements:
- Never presume vendor storage format or fixed paths indefinitely; version/probe adapters; documented compatibility matrix.
- Never scan all `$HOME` or unrelated directories by default. User chooses allowed agent storage paths and project bindings.
- Incremental indexing with rate/size limits, file change handling and deleted-session tombstones.
- Local record includes normalized `adapter`, native session ID, project binding, timestamps, events; external cloud ID should be opaque and unlinkable where feasible.
- **Cloud index ALLOWLIST**: `session_index_id, device_id, project_id, adapter, timestamps, state, optional message_count`. Exclude titles/prompts, file paths, commands, summaries, embeddings.

## 4. Remote search from Web/Android

```text
Aelys user query (Android)
   -> server verifies owner, Mac device, project/tool scope
   -> sends request with query, max results, time budget
   -> Mac searches local FTS within authorized project scope
   -> temporary snippets/source refs returned via protected channel
   -> AI Harness may use snippets iff owner policy allows forwarding to model provider
   -> server does not store raw snippets in logs/chat/transcripts by default
```

Source reference returned should be stable, opaque, tied to local device/session/message span; unavailable if Mac offline. If user explicitly stores derived note, this becomes an ordinary synced note **only after an intentional action**.

## 5. Agent Runner lifecycle

States: `queued -> starting -> running -> completed|failed|cancelled|expired`, optional `waiting_approval` only if operation exceeds preauthorized bounds.

```text
POST /agents/runs (project ID, adapter, task, policy ID, idempotency)
   -> backend validates identity + project grant
   -> durable queued record with TTL
   -> Mac claims job via device-auth channel with lease
   -> Mac revalidates canonical allowed project, sandbox and policy
   -> spawn CLI via adapter with controlled cwd/env, process supervision
   -> send structured events, throttled redacted logs, heartbeats
   -> persist final status and cancellation semantics
```

Do not allow caller to specify arbitrary path or raw shell command through backend. Task text is agent instruction scoped to project, NOT direct shell execution. CLI adapter must validate supported flags and version.

## 6. Project autonomy policy

One-time owner grant per project permits agent read/write/execute **inside a truly isolated, permitted workspace** without approval per step. It does **not** automatically authorize:
- access to other directories, `$HOME`, credential stores, SSH keys;
- Docker socket, process injection, privileged operations;
- network exfiltration or arbitrary external API actions;
- `git push`, production deployment, billing changes, sending email;
- bypassing CLI/vendor-level sandbox or approval mechanisms with flags without reviewing actual security model.

Provider credentials are a separate capability. A runtime may read a fixed
Keychain entry only after receiving a backend-signed, single-use lease bound to
the run, device, project, grant, provider, expiry, and nonce. A project grant
alone never authorizes credential access.

A `cwd` path restriction alone is insufficient. Candidate enforcement: isolated copy/worktree, dedicated OS account or sandbox profile/container/VM (platform suitability requires spike), read-only mounts by default except selected project, controlled network, scrubbed environment, resource/time limits. The selected isolation must be **tested** against symlinks, `..`, subprocesses and credential paths. If robust isolation not achievable, mark autonomous remote mode unsafe/not available rather than pretend protected.

### Proposed policy structure (concept, not executable)

```yaml
project_id: <uuid>
allowed_repo: <user_selected_path>
agent_kinds: [claude_code, codex_cli]
autonomy: within_sandbox
files: {read: true, write: true}
commands: {within_sandbox: true}
network: deny_by_default
external_side_effects: {git_push: false, deployments: false}
time_limit_minutes: 30
concurrent_runs: 1
```

## 7. Agent adapters

```python
class AgentAdapter(Protocol):
    async def detect_capabilities(self) -> Capabilities: ...
    async def start(self, request: RunRequest) -> LocalHandle: ...
    async def cancel(self, handle: LocalHandle) -> None: ...
    async def events(self, handle: LocalHandle) -> AsyncIterator[RunEvent]: ...
```

`resume_session` is **optional per adapter/version**, not assumed supported. Claude Code and Codex CLI terms/licensing/CLI invocation should be confirmed from actual installed versions during spike; do not invent CLI flags or treat usage under API keys as equivalent to CLI authentication.

## 8. Reliability & observability

- Deterministic mapping `run_id ↔ local handle`; leases make duplicate delivery harmless (don't start second process).
- Cleanup orphan processes after crash/reboot, restart reconciliation. The runtime persists redacted run records in local SQLite and marks nonterminal records failed with cleared leases when the helper reopens; process output and transcripts remain local to their supervised process/store paths.
- `cancel` sends signal to process group; status changes only when confirmed/timeout.
- Audit actor, project, adapter, policy ID, result. Never log raw transcript/code/secrets to cloud.
- Max concurrent runs, CPU/RAM/time, disk and output volume limits.
- If Mac offline, queue with expiry; no false «started».

## 9. Tests / acceptance

- Remote read when Mac online; explicit offline failure when disconnected.
- Verifiable absence of session bodies in PostgreSQL/logging/telemetry.
- Out-of-project filesystem read/write blocked in autonomous mode.
- Idempotent job submission and reconnect after dropped WebSocket.
- Cancel kills process and blocks new subprocesses after cancellation.
- Local adapter feature-probe handles unsupported CLI versions clearly.
