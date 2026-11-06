# Runtime progress

## Implemented

- Device-bound Ed25519 signed outbound request envelope with expiry and key binding.
- Explicit online/offline channel status and `MAC_OFFLINE` error path.
- Local SQLite schema for complete sessions, messages, FTS5, tombstones, and metadata outbox.
- Cloud metadata allowlist with tests excluding transcript and path fields.
- Authorized root traversal policy rejecting `..` and symlink components.
- Cursor/extension/size-limited incremental file discovery.
- Conservative Claude/Codex adapter probes and safe parser/startup stubs, with installed `--version`/`--help` compatibility checks.
- Idempotent run submission, leases, lease-bound cancellation, process-group cleanup, and terminal state transitions.
- Isolation gate that stays unavailable until all OS-level validation evidence is present; challenge-bound attestation now carries local root/profile/runtime/probe digests, while trusted helper/code-signing provenance remains a separate gate.

## Earlier verification status

The earlier checkpoint recorded passing `cargo fmt -- --check`, `cargo check`,
`cargo clippy --all-targets -- -D warnings`, and `cargo test` with 27 unit tests
and 13 integration tests. See the integration notes below for the current slice.

## Integration prerequisites

### Goal 2: backend integration

- Backend device enrollment must register the runtime public key and enforce device revocation, expiry, nonce replay protection, and TLS on the outbound channel.
- Backend agent-session APIs must accept only `CloudSessionMetadata` fields and never log or persist search snippets, transcript bodies, paths, commands, or embeddings.
- Backend run queue integration maps durable run/task/lease records to `RunManager` idempotency keys, lease-bound heartbeats, cancellation acknowledgements, terminal state transitions, and process cleanup tests.

### Goal 3: client/helper integration

- The Tauri/helper layer must opt in to installation, store the signing key in the macOS keychain, and provide a visible stop/uninstall path.
- A macOS isolation spike must implement and exploit-test the OS-level sandbox before `IsolationGate` can receive validated evidence.
- Installed Claude Code and Codex CLI formats and supported invocation flags are probed without provider auth; signed single-use credential leases are verified locally, while credentialed execution remains disabled pending backend lease issuance, vendor compatibility, and trusted provenance gates.

## Reviewed runtime slice integration (2026-11-06)

Selected roadmap task: Phase 5 / task 2, local SQLite/FTS indexing, including
the discovery and parser support needed to feed bounded snapshots.

Base: integration HEAD and remote main were both
`678e3e7f2f8508019758879fa23c3788fbb1db37` when checked. Compared with source
HEAD `4cbb748`, main changed only runtime contract test startup allowances;
those changes were preserved. Thirteen explicitly selected runtime source,
manifest/lock and test files were transferred, then formatted. No desktop,
frontend, backend or shared transport changes are part of this slice.
During final verification the shared integration branch and remote main advanced
externally to `c6a8f155f08cef4d58e7e871d02dec0519e5e408`. The intervening
notification fix changes no files under `apps/runtime`, so the runtime base
and the test evidence below remain applicable. No branch/index/commit/push
operation was performed by this task.

The slice provides descriptor-relative paginated discovery, bounded reads,
Claude main-conversation text projection, conservative Codex turn replay,
bounded single-frame zstd decoding, and atomic metadata/message/FTS snapshot
replacement. Scoped local reads/search use content-generation-bound cursors;
the local schema migration adds that generation to existing stores.

Assumptions and OPEN prerequisites:

- The caller supplies an owner-authorized root/project/adapter binding and
  enforces active grants; these library APIs do not create permissions.
- The desktop reader remains unregistered and vendor discovery/resume/run
  capabilities remain false. No background scan or autonomous vendor run is
  enabled. Existing isolation, credential and cloud metadata gates are preserved.
- Tests use synthetic session data. Installed CLI compatibility, packaged
  consent/lifecycle and production isolation acceptance remain OPEN.
- Discovery continuation is in memory; indexing uses full-file snapshots.
  Persistent offsets, watchers, deletion reconciliation and a scheduler are
  deferred. Concurrent edits and same-device mounts are not an atomic snapshot
  or a complete OS isolation boundary.
- Transcript bodies and FTS stay local; indexing writes no cloud outbox entries.
  Backup and provider-egress decisions remain OPEN.

Validation from the integration root, executed sequentially:

- `cargo test --manifest-path apps/runtime/Cargo.toml --locked --lib -- --test-threads=1`
  initially passed 74/75; the existing sandbox provenance test failed because
  the standalone probe binary had not yet been built in this fresh worktree.
- `cargo build --manifest-path apps/runtime/Cargo.toml --locked --bin aelys-isolation-probe`
  passed, without changing any isolation check.
- `cargo test --manifest-path apps/runtime/Cargo.toml --locked -- --test-threads=1`
  passed: 75 unit tests, 15 runtime contracts, 15 compression tests, 10 discovery
  tests and 28 indexing tests (143 total; zero failures or ignored tests).
- `cargo fmt --manifest-path apps/runtime/Cargo.toml` and its subsequent
  `-- --check` passed.
- `cargo clippy --manifest-path apps/runtime/Cargo.toml --locked --all-targets -- -D warnings`
  passed.

Next task: an explicitly authorized installed-version compatibility and source
grant/lifecycle acceptance pass before considering reader activation.

### Review follow-up: legacy discovery compatibility

Within the same Phase 5 / task 2 slice, comparison with the API at `4cbb748`
confirmed that oversized files were filtered and max_files bounded the selected
traversal prefix, sorted only after selection. The legacy wrapper now preserves
that behavior, including a no-I/O empty result for max_files=0 and stopping
before later roots once the cap is reached. One-candidate walker pages avoid
prefetch past the accepted cap after cursor filtering. This remains a lossy
listing, not a completeness/watermark or deletion contract.

Only size omissions are accepted by the wrapper. Depth/path/unavailable/
cross-device omissions, root errors, invalid nonzero request bounds and the
65,536-unit work budget remain fail-closed. `discovery_walk.rs` is unchanged
(SHA-256 `ab7df7c7987c5e22d5fc1f42781ff66b5e194aab5ab5275a6416991971eae289`).
No prototype activation or permission change was made; OPEN prerequisites above
remain unchanged.

Four regressions cover oversized/exact-size filtering and sorting, cursor
filtering with a global cross-root cap, early stop/zero cap/root errors, and
rejection of non-size omissions. Before the fix, the targeted legacy run failed
three tests and passed the security omission test. After the fix:

- `cargo test --manifest-path apps/runtime/Cargo.toml --locked --test session_discovery -- --test-threads=1`
  passed all 14 discovery tests.
- `cargo test --manifest-path apps/runtime/Cargo.toml --locked --quiet -- --test-threads=1`
  passed all 147 tests sequentially: 75 unit, 15 contracts, 15 compression,
  14 discovery and 28 indexing; zero failures or ignored tests.
- `cargo fmt --manifest-path apps/runtime/Cargo.toml`, its `-- --check`,
  `cargo clippy --manifest-path apps/runtime/Cargo.toml --locked --all-targets -- -D warnings`
  and `git --no-optional-locks diff --check -- apps/runtime` passed.

This follow-up changes only `src/discovery.rs`, `tests/session_discovery.rs`
and this runtime progress record. Git index remained unchanged during the
follow-up; no staging, commit or push was performed.
