# Local main integration checkpoint — 2026-10-30

Selected task: IMPLEMENTATION_PLAN Phase 8, validate and commit the current
cross-platform development snapshot. The owner explicitly requested choosing
the best existing branch, committing the changes and merging it into main.
This authorizes local commits/merge, not push, deployment or release publication.

## Branch selection and preservation

`codex/desktop-design-integration` contains all local `main` commits plus 14
existing integration commits and the current working implementation. The
`design/prototype` and `claude/init-42cabc` refs point at the initial commit.
`worktree-desktop-design` contains an earlier reference UI; its layout/assets
were integrated into the current connected implementation in prior work.
The selected branch therefore preserves the working backend and platform
adapters together with the latest owner-requested UI.

Local main is an ancestor of this branch, so the intended integration is a
fast-forward without rewriting history. `origin/main` was fetched and remains
a separate divergent history (the earlier design PR merge); it is not reset,
rebased or pushed by this local operation. Other worktrees/branches are kept.

Only reviewed application sources, assets, lockfiles, tests, scripts and project
docs are included. Personal `.env`/databases, local agent settings/skills,
validation screenshots, APKs, build caches and generated Android `.tauri`
SDK sources are excluded. Existing unrelated `CLAUDE.md` modifications remain
local and uncommitted, as required by the contribution policy. No owner data,
Keychain entry, provider secret or external account is modified by validation.

## Corrections found during integration

- Runtime timeout/lease expiry attempted an invalid `Running -> Expired`
  transition. The transition is now accepted with coordinator regressions.
  The first parallel runtime run also had two process-tree startup failures;
  both passed individually and in the final full suite without changing their
  safety assertions/deadlines. Contention is possible but not established.
- Native sign-out previously used browser logout. It now completes native IPC
  logout before clearing frontend state. Keychain refusal preserves the current
  session; local-only logout is distinguished from a confirmed server revoke.
  Explicit sign-out prevents automatic restoration and a successful subsequent
  password login clears that local intent.
- Native 401 responses previously surfaced as 502 while an expired access
  credential remained in memory. The exact rejected session is now cleared,
  its saved refresh record is retained, and the UI returns to explicit Touch ID
  or password entry. Late results cannot invalidate a newer login. No domain
  mutation is automatically replayed. Native event streams share this handling.
- Added shared/native regression gates to frontend CI. No hooks were bypassed.

## Executed validation

| Check | Result |
| --- | --- |
| Backend + local launcher pytest | 212 passed, 7 opt-in cases skipped; one upstream Starlette/httpx deprecation warning |
| Disposable PostgreSQL migrations, API and AI contracts | 12 passed; two task-created databases removed afterwards, AI fixture databases cleaned by fixtures |
| Shared TypeScript and Vitest | passed; 36 tests |
| Web TypeScript and Vitest | passed; 208 tests in 31 files |
| Final native-auth/client targeted web suite | 40 passed after final sign-out guard correction |
| Android packaging script tests | 4 passed |
| Native transport Rust | 33 passed, two owner/hardware probes ignored by default |
| Android session-store Rust contract | 1 passed |
| Full Mac runtime Rust | 45 passed, including the uncredentialed CLI version/help probe |
| Rust fmt/Clippy | runtime/native transport passed; host fmt passed |
| macOS and mobile host cargo check | passed with locked dependencies |
| Android arm64 target cargo check | passed with installed NDK compiler/linker/archiver |
| Web production and unsigned macOS .app build | passed; latest .app 27.61 MiB |
| Backend Ruff, mypy, Bandit | passed; 66 backend modules plus launcher typecheck |
| Dependency checks | uv lock check, frozen pnpm install passed; pip-audit found no known vulnerabilities (local package excluded from advisory lookup) |
| SQLite Alembic upgrade + schema drift check | passed on a newly created disposable DB |
| Generated OpenAPI parity | current source equals docs/openapi.json |
| Git hygiene | explicit path staging, staged credential-pattern and artifact checks, diff --check passed |

Latest macOS executable SHA-256:
`a3abde656b3673a39a69e861a255080ab16255b5126bd6d24b36455ac69e414f`.
The app was rebuilt, not automatically restarted or granted new OS trust.

## Remaining development gates

This checkpoint is not an all-platform release/completion claim. Real owner
Keychain/Touch ID restart acceptance, certificate signing/notarization, Android
HTTPS login/CRUD and Keystore lifecycle, credentialed Gmail/Telegram/provider
acceptance, and approved Mac runner isolation remain open where noted in the
platform reports. No OPEN decision is promoted by this merge.

Calendar/Focus/Finance writes remain explicitly online-only pending durable,
idempotent domain replay. The former generic outbox did not establish a safe
end-to-end workflow: replay was not connected to the app lifecycle, and several
creates lacked replay-safe contracts. Legacy unscoped `aelys-shared` IndexedDB
is left untouched and never silently attributed or replayed to a different
owner/server. If old queued requests exist, they require a separately scoped
recovery flow; this validation did not inspect personal browser stores.

## Clean committed-source check

A temporary directory inside ignored validation output was populated only with
`git archive` of the committed application sources, not by copying the working
tree. Offline frozen pnpm install, production web build, 36 shared tests and
212 backend/launcher tests passed there (the same seven opt-in skips). Locked,
offline Cargo metadata for both hosts and both native packages also resolved.
The temporary checkout contained no personal .env or database, and was removed
by the validation script. This confirms source packaging for these checks;
it does not claim a fresh device install or a fully offline native runtime.
