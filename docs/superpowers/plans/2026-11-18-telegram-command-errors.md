# Telegram command error diagnostics

Scope: IMPLEMENTATION_PLAN Phase 4, AI Core, Telegram commands. Owner requested
useful failure messages instead of the generic AI/chat-settings fallback.

Implemented on `codex/telegram-command-errors`, from released part 1 (`32054d51`);
history part 2 is excluded. Known HTTP, AI and Telegram errors map to fixed
Russian explanations and next actions. Unknown failures explicitly say internal
error. Owner notices and server logs share a command ID and allowlisted code.
Exception strings, credentials, provider bodies and chat content are not emitted.
Ambiguous delivery retains its existing unknown state and no automatic retry.

Validation: 52 tests passed (command errors, chat commands, rotation); Ruff and
git diff --check passed. Integration test verifies persisted model error, owner-only
notice, matching log reference, no recipient edit and no leaked exception text.
No migrations. Production deployment and live Telegram verification pending owner
decision. No OPEN/PROPOSED architecture decisions changed.
