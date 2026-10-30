# Reproducible full backend lint gate

2026-10-30. Task: IMPLEMENTATION_PLAN Phase 8, quality/release hardening. Preserve
the existing owner/device, Decimal, sandbox, redaction and API contracts.

## Result

Unfiltered `ruff check backend/app backend/tests` now passes. The application
previously reported **497** findings; CI previously selected only `E9,F`.
The CI command now runs the full check. `backend[quality]` and the root Ruff
configuration agree on **0.17.3**, and Python **3.12** is the explicit target.
Ruff rule defaults are therefore stable between the checked local setup and CI.

The B008 findings included **307 `Depends`** declarations and one `File`
declaration. FastAPI inspects these route metadata objects; the configuration
marks only those two fully qualified constructors. A stdin probe verifies an
ordinary `build()` factory used as a default still raises B008, while the two
FastAPI declarations are accepted. No lint rule was disabled globally.

Safe import/UTC/type/Decimal cleanups span **79 existing Python files**. Model
registration imports remain explicit. Enum behavior and API shapes are retained.
The remaining manual changes include direct `min` selection with the existing
tie-break key, direct ISO-Z parsing supported by Python 3.12, `Self` for the
Telegram context manager and explicit cryptography/Pydantic exception assertions.

Broad catches remain only where external provider/tool/runner/channel failures
must be rejected or redacted; reviewed local annotations state those boundaries.
Money validators retain `ValueError` so Pydantic returns structured validation
errors, rather than leaking a TypeError as a server error. These exceptions are
documented at the statements rather than hidden by whole-module exclusions.

## Functional error found

Resource-link creation caught every commit exception as `DUPLICATE`. A new
test reproduced a simulated storage outage incorrectly becoming HTTP 409.
The handler now catches `IntegrityError` for duplicate links, rolls it back and
returns the existing typed 409; an `OperationalError` reaches normal server
failure handling instead of claiming the user created a duplicate. The two-case
test initially had one pass / one failure, and now both pass. Metadata channel
validation also catches its concrete Pydantic `ValidationError`.

## Checks

- `.venv/bin/ruff check backend/app backend/tests`: passed, unfiltered.
- `.venv/bin/ruff check scripts/start_local.py scripts/tests`: passed.
- `.venv/bin/mypy --explicit-package-bases backend/app --ignore-missing-imports --check-untyped-defs`:
  passed, 66 application source files.
- `.venv/bin/bandit -q -r backend/app -ll`: passed.
- `.venv/bin/python -m compileall -q backend/app`: passed.
- Python AST parsing of backend app/tests with `feature_version=(3, 12)`: passed.
- Full backend run with the existing PostgreSQL AI opt-in:
  **197 passed, 3 skipped**, one existing Starlette/httpx deprecation warning.
  JUnit: `/tmp/aelys-quality-gate-20261030.xml`. PostgreSQL migration-backed
  cancellation/revocation/SSE cases remain included; zero temporary AI test
  databases remain. No personal database was a test target.
- Current generated OpenAPI dictionary exactly equals `docs/openapi.json`.
- B008 constructor/factory probe: exactly the ordinary factory is flagged.
- `git diff --check`: passed.

## Lockfile refresh

The first unfiltered run in this checkout stopped during collection because the
existing `backend/.venv` did not contain the declared `python-dateutil` runtime
dependency. `python-dateutil>=2.9,<3` was already declared in `pyproject.toml`,
but the lockfile did not include it. `uv lock` regenerated the dependency graph,
and `uv sync --all-extras --reinstall` restored the environment from that
lockfile. The reproducible post-refresh run is **193 passed, 7 skipped** with
the existing Starlette/httpx deprecation warning; no application test failed.
`uv lock --check`, Ruff, mypy and Bandit pass after the refresh.

The task-created backend was gracefully restarted with its original environment
and existing `backend/aelys.db`, retaining secrets without printing/rotating them.
Old PID 17334 completed shutdown; current PID **50639**, cwd `backend`, listener
`127.0.0.1:8000`. Direct health and Vite proxies **5173/5174** returned OK.
No unrelated process, frontend/native source, deployment, staging or commit.

Native GUI acceptance was attempted before this slice: the computer-use tool
reported the Mac locked and required manual owner unlock. Keychain restart and
sleep/wake therefore remain unverified; no lock bypass or prompt acceptance was
attempted. Android SDK/license/device/APK gates also remain open. Passing the
backend quality gate does not complete the cross-platform goal.
