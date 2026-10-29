# Aelys — Goal prompt for Codex / Claude Code

This prompt can be pasted into the coding agent. **If your agent environment supports a `/goal` command, use it there.** Availability, semantics and syntax depend on the installed CLI/version; this document does not assume a particular slash command exists.

## Initial goal — review and start foundation

```text
You are the principal engineer for Aelys, an open-source Personal OS.

Read EVERY Markdown file in this repository's Aelys documentation pack.
Use PROJECT_CONTEXT.md and DECISIONS.md as the source of truth.
Distinguish DECIDED, PROPOSED and OPEN requirements; do not silently resolve OPEN questions.

Task:
1. Audit the docs for internal inconsistencies, security concerns, blockers and missing tests.
2. Write a concise architecture review and prioritized execution backlog (do not overwrite the existing docs silently).
3. For unblocked areas, implement ONLY Phase 1: Foundation from IMPLEMENTATION_PLAN.md.
4. Create a React+TypeScript web skeleton, Tauri 2 macOS skeleton, FastAPI backend, PostgreSQL migrations for core entities, typed auth/device/project/resource APIs and tests. If repository content exists, adapt rather than destructively replacing it.
5. Keep Android as a feasibility spike until its wrapper is validated. Do not build UI design, deploy infrastructure, or integrate external Gmail/Telegram providers speculatively.
6. Enforce local-session privacy, explicit authorization and idempotency in all contracts.
7. Before completion run tests, report evidence, changed files and remaining blockers.

Do not start Phases 2-8 yet. Ask for explicit user decisions when a blocker would make an irreversible architectural choice necessary.
```

## Subsequent goal template

```text
Read the Aelys docs and existing code. Implement Phase <N>, task <T> only.
Acceptance criteria: <copy exact checked items from ACCEPTANCE_TESTS.md>.
Preserve architecture constraints and unknown decisions.
Create tests, run them, document changes, and stop at this milestone boundary.
```

## Recommendation

Provide the agent with this full pack, not a short name-only prompt. Engineering milestones should be reviewed one at a time, even when an autonomous goal feature is available.
