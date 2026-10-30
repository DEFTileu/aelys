# UX_02 Tasks — implementation and validation

Scope: IMPLEMENTATION_PLAN Phase 2 task 3, Tasks CRUD UI. Owner explicitly
requested the redesign. Existing unrelated working-tree changes are preserved;
no other UX goal, database reset or external integration is part of this slice.

## Assumptions / OPEN boundaries

- TaskIn/TaskPatch/TaskOut and project lists are the mounted typed contracts.
  PATCH replaces fields, so every edit/toggle sends the complete existing
  parent/recurrence/description metadata plus the expected version.
- Existing legacy POST /tasks does not provide a demonstrated operation-receipt
  deduplication guarantee. This workspace uses online-only writes and no automatic
  outbox replay. An ambiguous create requires checking the list and explicitly
  allowing another attempt. Full offline sync remains a separate Phase 2 task.
- Client dates are displayed/edited in the browser IANA zone and sent as UTC
  instants; an unchanged due instant preserves its original timezone and seconds.
  A date without a time means 23:59 local. Invalid/DST-gap times are rejected.
  Due dates are instants in the existing contract, not a new all-day type.
- No team assignees, new recurrence semantics, drag ordering, new database
  schema or new SDK are introduced. Existing parent and recurrence fields are
  preserved. Those OPEN/product decisions remain unchanged.
- Closing a panel/Escape keeps its draft while Tasks is mounted. Drafts are
  session UI state and the UI explains that leaving Tasks ends that protection;
  the page warns before reload with unsaved work. This is not durable offline sync.

## Design plan and critique

Keep Aelys wallpaper/sidebar and its current Inter/system type. Base tokens:
canvas #F5F0EB, surface #FFFFFF, ink #1C1B22, muted #625D69, accent #6A4CF2.
Use theme tokens for the actual fields, lists and panels so dark mode works.
A continuous work list replaces competing stats cards; hierarchy is encoded by
views, date groups and row metadata. A single New task action and one quiet
quick-add form keep capture fast; detailed editing opens a 440px side panel.
No new dashboard decoration or fabricated sample tasks. A mobile icon rail keeps
the existing navigation usable with the Tasks workspace at 390px.

```text
[ Capture sentence                              New task Q ]
[ Inbox | Today | Upcoming | All tasks                      ]
[ Search tasks                Project       Status  Refresh ]
[ High priority | Overdue                 matching count     ]
[ Date group                                               ]
[ check   Task / notes / project       due     flag  details ]
                                            [ Task editor   ]
```

Skills applied: icon-system, ui-ux-pro-max, frontend-design. Targeted local skill
lookups for forms/validation and modal focus were verified in UX_RESEARCH.md.
References: Todoist quick add / Linear views, linked in that research. This
existing workspace retains its visual identity; no global design regeneration.

## Verification

Final command results and requirement evidence are recorded below.

## Corrections found during integration

- Real browser/SQLite round-trip exposed missing UTC in task responses: 14:35
  Asia/Almaty became 09:35 on reload. TaskIn now normalizes incoming offsets;
  TaskOut inherits restoration of UTC after SQLite drops tzinfo. Existing schema
  and OpenAPI do not change. Naive legacy values follow the calendar UTC policy.
- Shared `RequestOptions.allowCacheFallback=false` proves a live read while still
  populating the normal durable cache. The workspace explicitly falls back to
  read-only cached data. Authorization failures never fall back.
- A toggle conflict consults the parked-draft map; comparisons retain the draft's
  exact original due instant/zone even when the latest timestamp differs only in
  seconds. Parent/recurrence use the latest server values after explicit rebase.
- Pending requests retain modal focus, errors receive focus, Escape respects
  composition/native controls, and successful capture returns focus to New task.

## Acceptance evidence (final)

| Requirement | Evidence |
| --- | --- |
| Inbox/Today/Upcoming/All and date groups | TasksView filtered/grouped real TaskOut lists; browser verified Today (Oct 30, 23:59), All and undated Inbox; workspace tests separately verify Upcoming and local midnight boundaries |
| Quick title + optional date/time/priority/project | Real browser Q → title → Escape → Q restored draft → Enter created an undated task; second task created with date, Medium priority and actual project |
| Full editor and row/priority/details actions | Workspace tests for all three triggers; browser edited description, due date/time, High priority, project and status through actual API |
| Local dates and aware instants | Browser saved 14:35 Asia/Almaty, reloaded to the same 14:35; backend SQLite round-trip tests include offset +05:00 and versioned updates; helper suite run in UTC and America/New_York |
| Preserve description/parent/recurrence/version | Full-input helpers and API/React regression tests; browser complete/reopen retained fields; stored metadata remains owner-bound |
| Search/filters | Browser searched project name and combined Completed + High priority; React tests cover description/project matching and project/status/priority combinations |
| 409 retains draft and no false success | Browser concurrent update through a separate API client produced 409, Save disabled, latest fields displayed, explicit Keep my draft → Save succeeded; parked-draft/seconds regression covered by React test |
| Network failure retains draft | Isolated backend stopped during editing: save showed an error, text remained, no success; backend restored and same draft saved |
| Honest cached reads / disabled writes | Browser refreshed online, stopped backend, reloaded page, opened All: both tasks and latest description remained from IndexedDB, checkboxes and Save were disabled; cached project names retained after fallback |
| Keyboard / accessibility | Q ignored in inputs by tests; browser Enter capture and Escape draft recovery; Tab/Shift+Tab wrapped inside editor and Escape returned focus; pending/error focus handled explicitly |
| Responsive / themes | Browser inspected 390×844, 768×1024, 1440×1000; mobile editor includes all fields and visible Save; light/dark Tasks reviewed; temporary viewport override reset |
| Local availability | Main backend restarted using existing settings and same database; `/healthz` returns ok and Vite serves `/tasks` on port 5173; owner authentication remains required |

Commands actually executed after integration:

- `pnpm --filter @aelys/web typecheck` — passed.
- `pnpm --filter @aelys/web test` — 17 files, 111 tests passed.
- `pnpm --filter @aelys/web build` — passed, 66 modules.
- `pnpm --filter @aelys/shared typecheck` — passed.
- `pnpm --filter @aelys/shared test` — 2 files, 23 tests passed.
- `TZ=America/New_York pnpm --filter @aelys/web exec vitest run src/tests/task-model.test.ts` — 16 helper tests passed, including the DST gap case.
- `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests` — 152 passed, 2 skipped (PostgreSQL URL not configured), one existing Starlette/httpx deprecation warning.
- `.venv/bin/ruff check --select E9,F backend/app backend/tests` — passed.
- `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs` — passed, 64 source files.
- `.venv/bin/bandit -q -r backend/app -ll` — exit 0, no medium/high findings.
- Generated OpenAPI compared structurally to `docs/openapi.json` — identical; no schema migration needed.
- `git diff --check` — passed.

Browser screenshots are local QA artifacts: `aelys-tasks-desktop.png`,
`aelys-tasks-mobile.png`, `aelys-tasks-tablet.png`, `aelys-tasks-dark.png`.
They show isolated fixture data, not the owner's personal database. The final
response links the rendered proof. Test servers are stopped after validation;
main web/backend remain running. No commits/staging were created because the
checkout also contains earlier unrelated work.

Session note: the primary browser currently shows the existing owner's sign-in
screen. The QA instance used another port on the same loopback host, which can
replace the shared host cookie; a normal sign-in restores the main session.
The owner's account/password/database were not reset. Future browser isolation
must use a distinct host or browser context as well as a separate database.

Remaining boundary: durable offline writes/sync are explicitly outside UX_02;
editor drafts are retained while Tasks is mounted. PostgreSQL-specific runtime
validation is not claimed. Next proposed goal is UX_03 Calendar; it was not
started automatically.

The isolated browser database was created using the current Alembic `upgrade head` before the QA server started. No personal database migration or data reset was performed.

## Files belonging to UX_02

- `apps/web/src/views/TasksView.tsx` — workspace, capture, filters, mutations,
  cache/source states and conflict workflow.
- `apps/web/src/views/desktop/tasks.css` — list layout, scoped mobile shell and
  scoped dark Tasks surface.
- `apps/web/src/views/tasks/TaskEditor.tsx`, `task-editor.css`, `taskModel.ts` —
  accessible panel, form fields and typed date/full-payload helpers.
- `apps/web/src/components/AppShell.tsx` — explicit navigation accessible names
  remain available when mobile labels are visually hidden.
- `packages/shared/src/api-client.ts` — optional strict live read flag;
  defaults preserve existing consumers.
- `backend/app/domains/api.py` — only Tasks UTC normalization added by this goal;
  pre-existing edits for other domains are preserved.
- `apps/web/src/tests/task-model.test.ts`, `tasks-workspace.test.tsx`,
  `packages/shared/tests/api-client.test.ts`,
  `backend/tests/test_tasks_ux_contract.py` — regression/contract coverage.
- `docs/API_CONTRACTS.md`, `TASKS_UX_VALIDATION.md`, `UX_GOALS.md`,
  `UX_RESEARCH.md` — actual boundary and completion evidence.

No unrelated modules were implemented, staged, committed, pushed or deployed.
