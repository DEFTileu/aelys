# Aelys backend and macOS runtime review

## Review result

The current implementation preserves the main security boundaries in the approved documents. Backend tests, Python compilation, PostgreSQL and SQLite Alembic migration checks, OpenAPI generation, Rust tests, and live Rust-to-FastAPI heartbeat, metadata, revocation, and signed isolation-attestation tests pass. The macOS runtime contains the required local-only data projection and a Seatbelt profile with six real escape probes.

## Required invariants

- Every authenticated request resolves an owner from a signed token; device-bound tokens are rejected after device revocation. A device ID header cannot grant authority.
- Sync operations are idempotent by operation UUID and compare the submitted base version against the owner-scoped record. Pull payloads contain domain patches only. Agent transcript, message bodies, embeddings, secrets, and command logs are rejected.
- Sync cursors represent committed ordering through opaque HMAC owner-bound cursors. PostgreSQL pushes acquire a per-resource transaction advisory lock, and concurrent create operations were verified to yield one applied result and one conflict.
- Provider secrets are represented by opaque references and tested encrypted secret-store adapters. A production deployment still needs an OS keychain/KMS-backed store and persistent usage/audit storage.
- Email, notes, code, and agent output remain untrusted data. Tool authorization is server-side and the agent cannot create a grant from prompt content.
- Full agent sessions, local FTS, snippets, and embeddings remain in the runtime's SQLite store. The cloud projection is an allowlist of neutral metadata.
- Remote run submission requires an explicit project/device grant with `isolation_validated=true`. The Rust runtime independently requires adapter capability and a validated isolation report.

## Release blockers

1. Exercise the full runtime run lifecycle against the backend with a real supported CLI, including leases, replay rejection, reconnect, cancellation, process-tree cleanup, and MAC_OFFLINE behavior.
2. Add persistent usage/audit storage and provider egress policy controls for deployed AI execution; the current provider transport and encrypted envelope are tested but execution remains injectable/configuration-driven.
3. Confirm PostgreSQL tombstone compaction/reset and production migration rollback policy.

On the current macOS host, `/usr/bin/sandbox-exec` is present but documented
as deprecated. The runtime uses an imported system profile with explicit
project allow rules and real probes for outside reads, credentials, symlinks,
subprocesses, network, and project writes. The signed report was accepted by
the backend and enabled a project grant; vendor process execution remains a
separate compatibility/authentication gate.

## Deferred decisions preserved

Gmail/Telegram scope, Android wrapper, Mac-session backup, exact AI SDK, and final public license remain OPEN or PROPOSED. The implementation does not claim those features are complete.
