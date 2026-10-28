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
