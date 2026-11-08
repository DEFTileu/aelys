# Aelys desktop shell

This directory is the Tauri 2 macOS shell for the shared React application.
The Rust commands expose only runtime status and bounded adapter capability
probes. They do not start Claude Code or Codex CLI. The existing runtime keeps
vendor execution fail-closed until authenticated compatibility and trusted
macOS isolation provenance are validated.

The desktop shell uses the local `aelys-runtime` crate as a path dependency.
Run `pnpm install`, then `pnpm --filter @aelys/desktop tauri:dev` after
installing the Tauri CLI and the supported macOS toolchain. `cargo check` can
validate the Rust boundary without opening a window.

Signing, notarization and distributable installers are Goal 3 work.


## Debug local session reader prototype

The Developer screen exposes an opt-in debug-only Mac reader prototype. It
uses explicitly selected roots, a temporary grant bound to the current
owner/device session and an existing owner project, native confirmation for
each indexing and metadata page, and fresh online identity/ownership checks.
Release builds reject reader IPC before identity checks, dialogs, or local work.
No paths are sent to or returned from the WebView.

Each grant has a separate in-memory SQLite/FTS index. Transcript open and local
search commands always return `READER_CONTENT_UNAVAILABLE`, including in debug
builds; they do not read or publish transcript content. Local index and
metadata results are never synced, uploaded, logged, or sent to providers.
Revocation cannot recall a metadata/index response already handed to Tauri, and
process memory/swap are not securely erased. This is an incomplete prototype,
not an OS-isolation or complete-history claim.
