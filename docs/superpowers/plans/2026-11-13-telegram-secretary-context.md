# Telegram secretary context repair

**Goal:** Fix the reported Business conversation where the assistant addressed the owner and requested an already supplied screenshot.

**Scope:** IMPLEMENTATION_PLAN Phase 3, task 5. Reference: TELEGRAM_BUSINESS.md and the owner's request to reuse MySDU behavior/prompts. No new personal tools, private memory, UI, or changes to MySDU.

**Architecture:** Preserve the existing policy-checked Business worker, decision schema, concurrency claims, and usage accounting. Capture owner identity only from verified Telegram binding/connection data. Adapt MySDU's prompt and output audience guard. Keep conversation roles explicit and process bounded photos transiently through the existing BYOK adapters with image capability checks.

## Tasks and ownership

- [x] Identity worker: encrypted nullable `TelegramIntegration.owner_name`, migration 0052 after 0051, verified binding/connection capture, foreign identity rejection, migration/ingestion tests. Own models/service/migration and new identity tests only. Preserve API response shape.
- [x] Prompt worker: new `telegram_secretary.py` with `build_system_prompt(instructions: str, owner_name: str | None) -> str` and `validate_reply_audience(text: str | None, owner_name: str | None) -> None` (raises ValueError). Adapt MySDU first-person, author/addressed distinction, old bot errors, no invented promises, images/context and JSON action rules; no MySDU tools. Own helper and new helper tests only.
- [x] Integrator: connect helper/identity to `telegram_ai.py`; label human versus previous automatic turns, preserve media markers and reply references, transiently attach at most two recent photos, capability/size/permission checks and manual handoff when needed. Add failing regression tests before production edits. Preserve untrusted flags, 30k text budget and no AIMessage persistence.
- [x] Validation: targeted tests, migration upgrade/check/downgrade, Telegram suite and required lint; independent review; copy only verified task files into original checkout, preserving existing unrelated work.

## Assumptions and open matters

User approved fixing current Business behavior and reusing MySDU prompts. `gpt-6-luna` is the available Luna model; no `luna 6.1` override exists. Telegram's verified profile name is author identity data, never instructions. Existing records have no name until the next fresh verified connection fetch. Persistent attachment storage remains OPEN; image bytes stay transient. Live acceptance requires a real permitted chat; no unsolicited messages or LLM calls against private production conversations.

## Review focus

Foreign connection names must never overwrite owner identity; names must not become instructions. A photo followed by text/name must remain visible to the model. Unsupported image models must not silently answer without the screenshot. Prior automated mistakes must not become trusted owner commitments. Invalid replies must preserve incurred usage and never reach Telegram.

## Validation record

Implemented with four gpt-6-luna subagents (identity, prompt, web eligibility, independent review). No actionable findings in the independent review; final identity purge cleanup was additionally regression-tested. All 15 task files were copied into the original checkout after checking each destination against the base revision; unrelated work preserved. Validation details: ../../optimization/telegram-secretary-context.md.

Final targeted backend: 91 passed in the original checkout. Full backend snapshot: 1358 passed, 118 skipped, 1 pre-existing PDF upload failure, independently reproduced at base 266e76c. Full web rerun with bounded workers: 923 passed. Ruff, mypy (124 source files), Bandit, compileall, web typecheck and diff whitespace checks passed. The final prompt wording-only clarification was followed by 18 passing helper tests. No commits, deployment, production migration, real provider calls or external messages.
