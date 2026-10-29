# Runtime implementation plan

1. Define device-bound outbound protocol and explicit offline signaling.
2. Store complete local agent sessions in SQLite with FTS and cloud-safe metadata projection.
3. Discover only within owner-authorized roots with incremental cursors and symlink/traversal checks.
4. Probe Claude Code/Codex CLI conservatively without assuming native formats or flags.
5. Add lease/idempotency/cancellation state transitions.
6. Keep autonomous execution unavailable until macOS OS-level isolation validation passes.
7. Run Rust formatting, unit tests, integration tests, and compilation.

Open prerequisite: a macOS security spike must establish and test the actual
process isolation mechanism before any adapter receives `can_run = true`.
