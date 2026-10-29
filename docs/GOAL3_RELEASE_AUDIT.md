# Goal 3 release reproducibility and platform audit

**Audit date:** 2026-10-28
**Repository:** `/Users/tileuzhan/vsCode/aelys`
**Scope:** release reproducibility, CI/toolchain coverage, backend/runtime/web/desktop/mobile build evidence, installation/self-hosting documentation, signing, and release artifacts.
**Change scope:** this audit file only. Existing `CLAUDE.md` and `.claude/` changes were preserved.

## Release decision

Goal 3 is **not release-ready**. The web, shared package, backend test suite, runtime crate, and desktop Rust/Tauri compilation have reproducible local evidence. A distributable desktop release, Android APK, PostgreSQL migration/integration validation, signed artifacts, installer/uninstaller flow, and complete self-hosting/install path do not have sufficient evidence.

The strongest blockers are:

1. The Tauri desktop configuration has bundling and updater artifacts disabled, so the successful desktop command produced a release binary only.
2. Android initialization failed because the Android command-line tools setup is incomplete; the Android project directory and APK build are absent.
3. No macOS signing identities are installed, Xcode is unavailable beyond Command Line Tools, and no notarization/release workflow exists.
4. PostgreSQL was not running locally; the two PostgreSQL integration tests failed with connection refused.
5. The repository has no release workflow or artifact publication, and the install/self-host documentation is incomplete.

### Current checkout update

The original audit above is retained as historical evidence from its audit
date. Subsequent verified work changed the current release evidence:

- `make openapi` now writes through a temporary file and current generation
  produces 66 paths, including finance transfers, with an HTTP bearer scheme.
- A fresh temporary Docker PostgreSQL database on `127.0.0.1:55434` passed
  Alembic upgrade/check through `0015` and both PostgreSQL integration tests.
- The current finance transfer contract verifies atomic balanced Decimal
  postings, owner and currency binding, float rejection, and idempotent replay;
  timer pause/sleep semantics remain unverified.
- `backend/.env.example`, `docs/SELF_HOSTING.md`, and
  `docs/BACKUP_RESTORE.md` provide the local SQLite/PostgreSQL setup,
  encrypted owner export/restore, and a PostgreSQL backup/restore drill.
- The current checked-in frontend manifests use exact versions and frozen
  pnpm install passes. Desktop Tauri release binary compilation also passes;
  bundle/signing/notarization remain separate blockers.

The release decision remains **not release-ready** because platform signing,
Android APK generation, vendor execution trust, external integrations, and
full cross-device/native offline recovery are still unverified or blocked.

## Repository and reproducibility inputs

| Area | Evidence | Result |
|---|---|---|
| JavaScript workspace | `package.json`, `pnpm-workspace.yaml`, checked-in `pnpm-lock.yaml`, `packageManager: pnpm@11.18.0` | **PASS with risk**: `pnpm install --frozen-lockfile` passed. Several web dependencies use `latest`, so a fresh lockfile regeneration is not stable even though the current frozen install is reproducible. |
| Python backend | `backend/pyproject.toml`, checked-in `backend/uv.lock` | **PARTIAL**: lockfile exists and local `.venv` checks ran. No documented locked backend installation command or CI use of `uv.lock` was found; CI installs editable extras with pip. |
| Rust crates | `apps/runtime/Cargo.lock`, desktop/mobile `Cargo.lock` | **PASS for host builds**: locked runtime tests, runtime Clippy, desktop check/build, and mobile host check completed. Android target/toolchain was not validated. |
| Makefile | `make test`, `make compile`, `make migrate`, `make openapi` | **PARTIAL/FAIL**: compile passed; `make openapi` returned zero but wrote an empty `docs/openapi.json` in this audit invocation; the tracked file was restored and direct generation was validated separately. Migration commands failed before database work when `AELYS_SECRET_KEY` was not available to Alembic. |
| CI | `.github/workflows/ci.yml`, `.github/workflows/frontend.yml` | **PARTIAL**: backend and runtime CI coverage exists; web checks exist; desktop CI only runs Rust `cargo check`; no desktop bundled release, Android, signing, notarization, artifact upload, or release workflow exists. |

### Dependency and version observations

- Node `v26.5.0`, pnpm `11.18.0`, Rust `1.99.1`, Cargo `1.99.1`, Python `3.14.6`, Java `21.0.11`, and local Tauri CLI `2.12.4` were available.
- The repository requires Python `>=3.12`; the audit ran on Python 3.14. A supported-version matrix was not present.
- The frontend manifests originally contained `latest` ranges; the lead later pinned the checked versions and regenerated the workspace lockfile. Clean-machine reproducibility still depends on the checked-in lockfile and registry availability.
- Desktop and mobile Tauri packages specify `^2.5.0`; the installed CLI resolved to `2.12.4` through the lockfile.

## Checks executed

### Backend

| Command/check | Evidence | Result |
|---|---|---|
| `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests` | `40 passed, 2 skipped, 1 warning` | **PASS** |
| `make compile` | `compileall` completed with result 0 | **PASS** |
| Ruff | `.venv/bin/ruff check --select E9,F backend/app backend/tests` → `All checks passed!` | **PASS** |
| Mypy | `no issues found in 51 source files` | **PASS** |
| Bandit | no findings at configured level | **PASS** |
| Pip audit | `No known vulnerabilities found`; local package was not auditable because `aelys-backend` is not on PyPI | **PASS with limitation** |
| OpenAPI direct generation | `openapi 3.1.0`, `65` paths, generated JSON exactly matched `docs/openapi.json` | **PASS** |
| `make openapi` | command returned 0 but produced an empty tracked file during audit; tracked snapshot was restored | **FAIL** |
| `alembic upgrade head` / `alembic check` | both stopped in settings validation because `secret_key` was missing before database work | **FAIL / configuration blocker** |
| PostgreSQL integration | `backend/tests/test_postgres_integration.py` → `2 failed`; connection to `127.0.0.1:5432` was refused | **BLOCKED** |

The default backend test suite uses SQLite. PostgreSQL is the documented deployment database, but no running PostgreSQL service was available for migration or integration evidence. No database or source changes were made by the audit.

### Web and shared package

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | **PASS** — already up to date using pnpm 11.18.0 |
| `pnpm --filter @aelys/web typecheck` | **PASS** |
| `pnpm --filter @aelys/web test` | **PASS** — 3 files, 6 tests |
| `pnpm --filter @aelys/web build` | **PASS** — Vite production build completed; emitted `apps/web/dist` assets |
| `pnpm --filter @aelys/shared typecheck` | **PASS** |
| `pnpm --filter @aelys/shared test` | **PASS** — 1 file, 6 tests |

These results validate the current checked-out web/shared build. They do not validate deployment configuration, backend connectivity, browser installation, or cross-device offline behavior.

### Runtime

| Command | Result |
|---|---|
| `cargo fmt --manifest-path apps/runtime/Cargo.toml -- --check` | **PASS** |
| `cargo test --manifest-path apps/runtime/Cargo.toml --locked` | **PASS** — 30 unit tests, 14 runtime contract tests, 0 failures |
| `cargo clippy --manifest-path apps/runtime/Cargo.toml --all-targets --locked -- -D warnings` | **PASS** |

This is host/library evidence. The runtime README still describes the crate as a headless library for future Tauri/helper embedding, and production macOS isolation/provenance validation remains explicitly unavailable.

### Desktop Tauri/macOS

| Command/check | Result |
|---|---|
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check` | **PASS** |
| `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked` | **PASS** |
| `pnpm --filter @aelys/desktop tauri:check` | **PASS** — host Rust check |
| `pnpm --filter @aelys/desktop tauri:build` | **PASS only as binary compilation** — built `apps/desktop/src-tauri/target/release/aelys-desktop` |

The Tauri config has `bundle.active: false` and `createUpdaterArtifacts: false`. Consequently, this is not evidence of a `.app`, DMG, PKG, signed bundle, installer, updater, or user-facing install/uninstall flow. The desktop README explicitly leaves signing, notarization, and distributable installers to Goal 3.

macOS release prerequisites were not satisfied:

- `xcodebuild -version` failed because the active developer directory is Command Line Tools, not a full Xcode installation.
- `security find-identity -v -p codesigning` reported `0 valid identities found`.
- `codesign`, `productbuild`, and `pkgbuild` binaries exist, but no signing identity or release configuration is present.
- No entitlements, notarization workflow, Apple team configuration, installer package, or update feed was found.

### Mobile/Android

| Command/check | Result |
|---|---|
| `cargo fmt --manifest-path apps/mobile/src-tauri/Cargo.toml -- --check` | **PASS** |
| `cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml --locked` | **PASS only for host target** |
| `pnpm --filter @aelys/mobile exec tauri android init` | **FAIL/BLOCKED** — Tauri located `/Users/tileuzhan/Library/Android/sdk` but failed Android environment setup because command-line tools installation/setup is incomplete |
| `pnpm --filter @aelys/mobile tauri:android:build` | **FAIL/BLOCKED** — `src-tauri/gen/android` does not exist; Tauri requested `tauri android init` first |

Available Java (`21.0.11`) does not compensate for missing Android command-line tools, `adb`, `sdkmanager`, Gradle, configured `ANDROID_HOME`/`ANDROID_SDK_ROOT`, and generated Android project. No APK/AAB was produced. Android remains the `PROPOSED / SPIKE` decision under ADR-006; background sync, notifications, secure storage, offline persistence, and device validation remain unverified.

## CI and release pipeline audit

The current workflows provide useful validation but do not define a release pipeline.

- Backend CI installs `backend[test,quality]` with pip, runs compile, Ruff, mypy, Bandit, pip-audit, SQLite tests, Alembic checks, PostgreSQL integration, and OpenAPI drift.
- Runtime CI runs format, locked tests, and Clippy on macOS.
- Frontend CI runs frozen pnpm install and web typecheck/test/build.
- Tauri CI runs only desktop Rust format/check. It does not run `tauri build`, bundle validation, signing, notarization, or artifact upload.
- There is no workflow for Android initialization/build, APK/AAB artifact retention, macOS bundle signing/notarization, checksums, release tags, GitHub Releases, or update metadata.
- No CI cache or artifact policy establishes which build outputs are retained or how a release can be reproduced from a tag.

## Installation and self-hosting documentation

The documentation is not sufficient for a clean self-hosted release install.

Present:

- `backend/README.md` describes a local virtual environment, SQLite default, PostgreSQL URL, Alembic command, and required secret.
- `apps/desktop/README.md` describes `pnpm install`, development, and host `cargo check`.
- `apps/mobile/README.md` lists intended Tauri Android commands and explicitly says they are not evidence of an APK.
- `CONTRIBUTING.md` and `docs/GIT_WORKFLOW.md` describe contribution validation.

Missing or incomplete:

- No root quickstart that brings up the web, backend, PostgreSQL, and required environment in a clean checkout.
- No `.env.example` was found at the repository paths referenced by the backend README, and no complete sample deployment configuration was audited.
- No Dockerfile, Compose file, database bootstrap service, health checks, or production process manager configuration exists in the repository.
- No documented PostgreSQL creation/role/migration/recovery procedure is provided for a self-hosted operator.
- No documented web production serving/reverse proxy/TLS procedure exists.
- No desktop installer, uninstaller, helper install/stop/remove procedure, or upgrade procedure is documented.
- No Android APK installation, signing, update, or device validation instructions exist.
- No release checklist explains versioning, tagging, checksums, SBOM/dependency evidence, provenance, or artifact publication.

The project documentation correctly labels several platform capabilities as incomplete, but that honesty also means the current repository cannot be presented as a self-hostable release package.

## License and release metadata

- `LICENSE` contains the Apache License 2.0 text.
- The license text still contains the standard placeholder copyright fields (`[yyyy] [name of copyright owner]`).
- `docs/OPEN_QUESTIONS.md` and `README.md` keep the final open-source license decision unresolved/proposed. Public-release licensing should not be treated as finalized until the owner confirms it.
- No `NOTICE`, third-party attribution bundle, release versioning policy, or generated dependency/license report was found.

## Release artifact inventory

Artifact evidence from this audit:

| Artifact | Evidence | Status |
|---|---|---|
| Web production assets | `apps/web/dist` generated by Vite | **Produced locally**; no deployment archive or publication |
| Desktop Rust release binary | `apps/desktop/src-tauri/target/release/aelys-desktop` | **Produced locally**; unbundled and unsigned |
| macOS `.app`/DMG/PKG | No artifact produced or found | **Missing** |
| Android APK/AAB | No artifact produced or found | **Blocked** |
| Runtime distribution | Cargo test/build outputs only | **Missing release packaging** |
| Backend distribution | Source plus Python lockfile only | **Missing deployable package/image** |
| Checksums/SBOM/provenance | None found | **Missing** |
| Update artifacts/feed | Disabled in Tauri config; none found | **Missing** |

Build directories and generated local outputs are not release artifacts unless they are intentionally packaged, signed, and published by a release process.

## Findings and required closure

| ID | Severity | Finding | Closure evidence required |
|---|---|---|---|
| G3-001 | P0 | No distributable macOS release path; Tauri bundling and updater artifacts disabled | Enable and validate the intended bundle configuration, produce a clean `.app`/DMG or PKG, sign it with a documented identity, verify it, and exercise install/update/uninstall. |
| G3-002 | P0 | Android build is blocked before project generation | Install/configure Android command-line tools, Rust Android targets, Gradle/SDK prerequisites; run `tauri android init` and build a signed APK/AAB; validate install and required offline/notification/background behavior. |
| G3-003 | P0 | No macOS signing/notarization evidence | Full Xcode, Apple signing identity, entitlements, notarization credentials stored in CI, staple/verification evidence, and documented operator process. |
| G3-004 | P1 | PostgreSQL release path not locally reproducible | Run CI-equivalent PostgreSQL service, apply Alembic migrations from a clean database, run integration tests, and fix the secret/configuration ergonomics so the documented migration commands work. |
| G3-005 | P1 | `make openapi` is unsafe as a reproducibility check | Fix the target’s environment handling and add a check that rejects an empty/generated-invalid snapshot; current direct generation matched the checked-in snapshot. |
| G3-006 | P1 | No release workflow or retained artifacts | Add tag-driven CI for all intended platforms, artifact upload, checksums, provenance/SBOM as required, and a release checklist. |
| G3-007 | P1 | Clean self-host/install path is incomplete | Add a tested quickstart, sample environment, PostgreSQL/bootstrap procedure, production web/backend serving path, and recovery/upgrade notes. |
| G3-008 | P1 | Dependency declarations weakened clean-build reproducibility | **Remediated locally:** frontend/shared/Tauri manifests now use exact checked versions and `pnpm install --frozen-lockfile` plus web/shared checks pass. Continue reviewing updates through controlled lockfile changes. |
| G3-009 | P1 | License/release metadata is not finalized | Confirm the Apache-2.0 decision, replace placeholder ownership metadata, and add required third-party notices/attributions. |

## Final status

The repository can reproduce several development and host-target checks, but it cannot currently reproduce or publish a complete Aelys release for macOS and Android. Goal 3 should remain open until the P0 findings are closed and PostgreSQL, clean-install, release-workflow, and artifact evidence are captured from a clean checkout.

## Post-audit remediation recorded by the lead

After the audit, the repository added `backend/.env.example`,
`docs/SELF_HOSTING.md`, `docs/BACKUP_RESTORE.md`, an atomic `make openapi`
target, and encrypted single-owner export/restore scripts. These improve local
reproducibility and recovery but do not close the platform, PostgreSQL,
signing, Android, or release-artifact gates above.
