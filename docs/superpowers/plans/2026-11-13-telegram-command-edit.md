# Telegram command edit implementation plan

Goal: implement the owner's explicit request to append an answer below their
original `/ask` or `/search` in the same Telegram message. IMPLEMENTATION_PLAN
Phase 3 task 5. Existing isolated one-shot queries remain unchanged.

Design: use Business `editMessageText` through the existing policy/permission,
source-version and durable receipt boundary. Keep the full original command,
append two newlines and the bounded answer/sources. Never edit the contact's
quoted message. An edit denial/unknown delivery is terminal with a private
notice; never silently fall back to a separate customer-facing message. The
48-hour edit limit supplements the existing inbound-24-hour permission check.
Original command + answer must fit 4096 characters without truncating the
owner's text. An edited generated message retains automatic provenance.

Alternatives: separate answer is existing behavior, explicitly replaced by the
owner's request; deleting/reposting would lose message identity and is excluded.
No new conversation/session storage is requested. Each command is still a fresh
run with no chat history, personal tools or memory. Prompt wording must not
invite conversational continuation; ambiguity can be stated as a short assumption.
No schema or dependencies change. Previously OPEN product decisions remain OPEN.

- [x] RED/GREEN transport tests and minimal editMessageText method (Luna worker).
- [x] RED/GREEN queue-to-edit, quote target, stale source, size, unknown outcome,
      permissions, provenance and receipt tests; change delivery and prompt.
- [x] Run full backend pytest plus Ruff, mypy, Bandit and diff check; independent
      review. Update Business contract/report with exact results.
- [x] Explicitly stage only owned files, commit, push and verify deployment,
      migrations/startup and health. No real test messages from the owner account.

Validation: full backend 1467 passed/118 skipped; Ruff, mypy126, Bandit, diff check passed.
Independent review CAS finding reproduced RED then fixed with conditional UPDATE RETURNING; final suite green.
Release commit/push/deployment verification proceeds after this record.
