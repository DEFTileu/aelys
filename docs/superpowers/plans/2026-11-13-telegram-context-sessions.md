# Telegram contextual command sessions implementation plan

Goal: Phase3/task5 extension, persistent per-chat hour-idle command sessions with
curated agent Knowledge. Spec: ../specs/2026-11-13-telegram-context-sessions-design.md.
No UI redesign, dependency/vendor addition, personal module tools or Mac content.

- [x] RED/GREEN: add0054 fields session_id/answer(encrypted)/knowledge_refs, migration
      compatibility and rotation; legacy rows have no session history (Luna).
- [x] RED/GREEN: curated builtin Aelys + enabled exact agent-context note retrieval,
      current source validation, policy, bounds, aliases and docs (Luna).
- [x] RED/GREEN: assign session within ingestion transaction, hour boundary/restart,
      explicit/new reset and cross-chat isolation. Store answer only after edit;
      inherit valid source refs, bounded recent history and KB context, quotepriority.
      Extend wipe paths; revalidate history dependencies immediately before edit.
- [x] Full backend suite; Ruff/mypy/Bandit/migrations; independent integration review.
- [x] Document behavior/limits, explicitly commit owned files, push/update existing
      backend and verify actual deployment/health. No live test messages as owner.

Verification:1496passed/126skipped; Ruff,mypy128,Bandit,compileall,diffcheck passed.
Review findings reproduced RED/fixed GREEN. Release deployment follows this record.
