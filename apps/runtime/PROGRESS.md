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

## Verification status

`cargo fmt -- --check`, `cargo check`, `cargo clippy --all-targets -- -D warnings`,
and `cargo test` pass. The suite contains 27 unit tests and 13 integration tests.

## Integration prerequisites

### Goal 2: backend integration

- Backend device enrollment must register the runtime public key and enforce device revocation, expiry, nonce replay protection, and TLS on the outbound channel.
- Backend agent-session APIs must accept only `CloudSessionMetadata` fields and never log or persist search snippets, transcript bodies, paths, commands, or embeddings.
- Backend run queue integration maps durable run/task/lease records to `RunManager` idempotency keys, lease-bound heartbeats, cancellation acknowledgements, terminal state transitions, and process cleanup tests.

### Goal 3: client/helper integration

- The Tauri/helper layer must opt in to installation, store the signing key in the macOS keychain, and provide a visible stop/uninstall path.
- A macOS isolation spike must implement and exploit-test the OS-level sandbox before `IsolationGate` can receive validated evidence.
- Installed Claude Code and Codex CLI formats and supported invocation flags are probed without provider auth; signed single-use credential leases are verified locally, while credentialed execution remains disabled pending backend lease issuance, vendor compatibility, and trusted provenance gates.
