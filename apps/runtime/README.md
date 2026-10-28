# Aelys headless macOS runtime

This crate is the local runtime library for session discovery/indexing and
project-scoped agent run coordination. It has no UI and is designed to be
embedded by the future Tauri/helper layer.

The local SQLite schema stores complete session messages and FTS data. The
`CloudSessionMetadata` type is the only metadata projection intended for the
backend and contains no transcript, path, prompt, command, summary, or
embedding fields.

Claude Code and Codex CLI native history formats and safe invocation flags are
not established by the repository specifications. Their adapters probe the
executable's version and bounded help output for the required non-interactive
flag shape, but still report discovery/resume/run as unavailable until
authenticated compatibility and isolation validation pass. Parsing and process
startup remain explicit compatibility-spike seams.

Unattended execution is blocked until a real macOS OS-level isolation
validation suite produces all required evidence. A current-directory check or
symlink-aware path check alone cannot authorize a run.

## Local verification

From this directory:

```sh
cargo test
cargo fmt -- --check
```

The `heartbeat` example exercises the authenticated outbound channel against a
running backend:

```sh
AELYS_CHANNEL_URL=ws://127.0.0.1:8000/api/v1/agents/channel \
AELYS_ACCESS_TOKEN='<device access token>' \
cargo run --example heartbeat
```

Loopback `ws://` is accepted only for local development. Deployed channels
must use `wss://`; the access token is sent in the Authorization header and is
never placed in the endpoint URL.

The backend rejects the connection after the device is revoked. Full agent
execution remains blocked until the macOS OS-level isolation validation report
passes; the client does not bypass that policy.

The `sandbox_validate` example runs the local Seatbelt probe and verifies
project writes, outside-path reads, credential-path reads, symlink traversal,
subprocess inheritance, and network access. The resulting report can be signed
with the enrolled device key and submitted as a project grant attestation.

`process::build_invocation` provides bounded Claude Code (`--print
--output-format stream-json`) and Codex CLI (`exec --json --ephemeral`) command
construction. `ManagedCliProcess` starts them only inside the validated
Seatbelt profile, clears inherited environment variables, and kills the
process group on cancellation or timeout. Vendor authentication and native
session format support remain adapter probes and are never guessed.

`credentials::MacOsKeychainReader` is the explicit credential path for a
future authenticated vendor run. It accepts only the fixed Aelys provider
services (`com.aelys.claude` or `com.aelys.openai`) and the `default` account,
injects only the provider variable into the scrubbed child environment, and
never serializes or logs the credential. `CredentialLease` adds a signed,
single-use lease bound to run, device, project, grant, provider, expiry, and
nonce; the backend issues it over the authenticated HTTP or WebSocket channel,
but vendor execution remains disabled until compatibility and trusted-provenance
gates pass.

The backend trust root is generated from the exact runtime and isolation-probe
bytes by `backend/scripts/generate_runtime_manifest.py`. The helper must pin
the resulting public key and manifest through its deployment configuration;
the backend rejects attestation provenance when those values are absent.

Codex’s current first-party login is stored in `~/.codex/auth.json`. The
runtime does not mount or copy that file into a coding-agent sandbox. A future
device-bound credential broker must translate it into a restricted provider
credential before unattended Codex execution is enabled.
