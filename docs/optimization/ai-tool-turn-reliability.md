# AI tool turn reliability

Scope is Phase 4, task 2 in the [implementation plan](../IMPLEMENTATION_PLAN.md).
The starting point is the existing [15-tool inventory](../AI_TOOL_INVENTORY.md).
The request concerns the built-in Aelys assistant. Existing provider, tool scope
and approval decisions apply. No OPEN decision is resolved here.

## Findings and changes

- The app and Telegram checked whether any configured model supported tools,
  even when a different model was selected manually. The shared capability
  check considers the selected model, whether it is enabled, and whether it
  may process personal data. The router still validates the actual completion
  against its capability, privacy, context and budget requirements. A text-only
  app turn can answer generally. Telegram requests that require personal tools
  return the existing model-unavailable error when the selected model lacks them.
- The tool loop could stop with no final model answer after exhausting its steps
  or receiving only repeated call IDs. App chat now shows and stores a partial
  answer notice. Companion voice also speaks the notice. Telegram uses its
  existing partial reply handling. The server still suppresses repeated call IDs
  and keeps pending approvals attached to the answer.
- The prompt asks the model to consult each relevant enabled source, reuse
  successful tool results, and label whether task dates are deadlines, creation
  dates, or recorded completion dates. Regression tests cover a tasks-plus-calendar
  request with the actual tool schemas, database handlers and provider serialization.

## Research and evaluation

Sending the allowed schemas upfront keeps tool use to one provider step when the
model can immediately select a tool. On-demand discovery can save context as a
catalogue grows, at the cost of a discovery step. With 15 total tools shared
across channels and a concrete reliability problem, this change retains upfront
scope filtering. Compare real tool-selection accuracy, input tokens and
end-to-end latency before changing discovery. See
[Anthropic on tool search](https://www.anthropic.com/research/advanced-tool-use)
and [tool evaluation](https://www.anthropic.com/research/writing-tools-for-agents).
The follow-up adds [on-demand tool discovery](ai-tool-discovery.md).

The regression cases reproduce wrong-model routing and an empty answer at the
step limit before the fix. The test adapters exercise the protocol and use
scripted model responses. Live model selection quality, latency and token
savings have not been measured. The next evaluation would compare actual
provider choices for everyday requests against the expected tools and outcomes.

## Validation

- Final pytest selection covered `backend/tests/ai_automation`, trusted time,
  personal tools, Telegram Guest, personal dialogue, media, memory and Companion
  voice. Result: 525 passed, 121 skipped in 35.75 seconds. The runs used
  `python -m pytest -q -p no:cacheprovider` with a task-specific basetemp.
- `ruff check --no-cache backend/app backend/tests` passed.
- `mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`
  passed for 156 files.
- `git diff --check` passed.
