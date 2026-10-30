# Remaining ACTUAL UI and mobile completion

Selected task: Implementation Plan Phase 8, cross-platform UI consistency and
native packaging. Owner requested completing the previously identified old
panels and the unfinished mobile implementation. Reference: ACTUAL Desktop,
ACTUAL Mobile and launch; OLD excluded. Existing deployment/CLAUDE edits remain
unrelated. Existing decisions, Mac-only histories/embeddings, sandbox, BYOK,
Policy Engine and personal records must remain intact.

Slices: shared select controls and form integration, grouped notifications,
real search and actionable commands, provider/Telegram settings, note folders
and tags, utilities screens, and a dedicated mobile widget-customization view.
No OPEN decisions are silently approved. Utilities absent from ACTUAL reuse its
component language, with live handlers and honest unavailable states. No mock
balances, replies, unread counts or external effects will be introduced.

## Delivered

- Shared single-select picker, including portalled menus that escape clipped
  cards/dialogs, native form values, disabled states and keyboard interaction.
  Applied to Tasks/editor, Finance, Mail, widget controls, provider settings,
  Telegram and Timer.
- Grouped desktop/mobile notifications with real counts, unread filtering,
  per-record mark-read and partial-failure-safe mark-all. Offset-free SQLite
  UTC timestamps are formatted as the correct instant.
- Real search with grouped results, desktop preview and mobile results. Task,
  note and mail results open their corresponding record; create commands open
  forms, including same-route navigation. Existing drafts are kept.
- Compact provider/Telegram settings, Timer, Developer Hub and Automation
  surfaces. Existing API/policy controls remain authoritative; unsupported
  runtime execution and rule creation are not simulated.
- Notes folders/tags with migration 0023, typed API fields, normalization and
  optimistic version checks. Legacy updates preserve organization; a client
  talking to an older backend keeps its organization draft instead of claiming
  success. Hierarchy/project fields remain independent.
- Dedicated mobile Customize with Widgets/Actions/Appearance, allowed size
  presets, ordering, add/remove/reset and durable local preferences independent
  of the desktop layout. Large widgets expose additional available records.
  Home remains the only module with wallpaper. Widget editing stays gated by
  Customize; no freeform grid dimensions were added.

## Validation

- `pnpm --filter @aelys/web test`: **47 files, 275 tests passed** on final code.
- `pnpm --filter @aelys/web typecheck`: passed; final native build hooks also ran
  `tsc -b && vite build` successfully.
- `.venv/bin/python -m pytest -q backend/tests
  --ignore=backend/tests/test_postgres_integration.py`: **206 passed, 5 skipped**.
  No PostgreSQL integration acceptance is claimed. Focused Notes/migration run:
  **3 passed**, including an existing-note SQLite migration test.
- `.venv/bin/ruff check backend/app backend/tests`: passed. Migration import
  ordering was corrected; its targeted Ruff check passed.
- `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports
  --check-untyped-defs`: passed, **66 source files**.
- `pnpm --filter @aelys/mobile test`: **5 passed**.
- `PYTHONPATH=. ../.venv/bin/alembic upgrade head` in backend: passed on fresh QA
  SQLite and the verified local owner SQLite. Before the owner migration, a
  SQLite backup was saved with mode 0600. The original note IDs, owner IDs,
  titles, bodies, parent/project links, versions and tombstones were compared
  against the backup and unchanged; `PRAGMA integrity_check` returned `ok`.
- `PYTHONPATH=. ../.venv/bin/alembic check`: no new upgrade operations detected.
  Local backend restarted on 8000 and serves the new NoteOut contract.
- `docs/openapi.json` regenerated from the mounted application; diff only adds
  folder/tag properties to NoteIn/NoteOut. `git diff --check`: passed.
- Browser QA used an isolated synthetic SQLite database, not the owner records:
  search-to-task editor, mobile form picker, saved note organization, real
  start/stop focus and saved history, and notification mark-all were verified.
  Mobile Customize persisted size/order through navigation; CSS width 320 and
  tablet Notes at 900 had no document horizontal overflow. QA screenshots are
  ignored local files under `output/design-rebuild/parity/remaining-*`.

## Native installation

Final source commit: `34caed2` (after c9b2dfb, 0a00cff and 0ba1d16).

- macOS: `pnpm --filter @aelys/desktop exec tauri build --ci --no-sign
  --bundles app`: passed, **27.87 MiB** bundle. Applied the same existing local
  ad-hoc hardened-runtime signature, verified with `codesign --verify --deep
  --strict`, and installed at `~/Applications/Aelys.app`. Existing app retained
  under `~/Applications/Aelys-backups/`. Installed executable bytes match the
  source bundle; SHA-256:
  `506c26ac9636be475a8b8500eb5e5a45f314b1bf8cfcfbe9dc5ce73ddcc884a5`.
  Native launch reaches the real Touch ID entry; no biometric/password/Keychain
  authorization was supplied by the agent.
- Android: release arm64 build command from the mobile README passed with the
  installed JDK/SDK/NDK. Aligned with SDK `zipalign -P 16`, signed with the
  existing local Android Debug certificate; certificate matched the installed
  package. `apksigner verify` passed. Packaged manifest retains cleartext=false.
  `adb install -r --no-streaming` returned **Success** on Samsung SM-S721B.
  Package remains `com.aelys.mobile`; no uninstall, reset or data clearing.
  The installed base APK was pulled back and its bytes matched the built APK.
  Artifact: `output/android/aelys-arm64-remaining-ui-local-signed.apk`,
  **33,918,144 bytes (32.35 MiB)**; SHA-256:
  `020673be600199f5ac34586fd34663c575e00a6bfd2ade04f2e8eb7a2e48c72f`.

## Limits and next task

UI implementation and package installation do not establish pixel-perfect
identity, production signing/notarization, Android background behavior or live
Gmail/BYOK/Telegram acceptance. The final APK's authenticated UI was not driven
on the physical phone; responsive browser QA and installation evidence are
separate. Mac unlock remains an owner action. Cloud backend was not redeployed
or migrated in this slice; note organization on Railway requires shipping the
new backend/migration. The client preserves drafts against older servers.
Next task: owner-authenticated native smoke tests against the chosen backend,
then separately authorized server rollout if Railway is to use note organization.

Unrelated Railway/container/config/CLAUDE changes remain uncommitted and excluded.
No push, cloud deployment, external message or OPEN decision approval occurred.
