# PostgreSQL AI cancellation and SSE contract validation

2026-10-30. Task: IMPLEMENTATION_PLAN Phase 4 task 5, cancellation, extending
the preceding SQLite/API evidence to PostgreSQL. No production source, API,
migration, permission, dependency or product decision changed.

## Coverage added

The existing cancellation/revocation and SSE delivery tests now use the
`ai_test_engine` fixture, parametrized for SQLite and PostgreSQL. PostgreSQL
requires the separate opt-in `AELYS_TEST_AI_POSTGRES_ADMIN_URL`; it never falls
back to the application's `AELYS_DATABASE_URL`. Only an asyncpg URL to the
loopback `postgres` administration database is accepted.

For each PostgreSQL case the fixture creates its own UUID-named
`aelys_ai_test_*` database and runs the real `alembic upgrade head` chain. The
migration child receives test-only encryption/signing configuration. API
requests use asyncpg against that migrated database, not model `create_all`.
Teardown disposes the engine and drops only the name successfully created by
that fixture. It does not use `DROP ... FORCE`; leaked application connections
would fail cleanup. Existing application databases and the personal SQLite
database are not migration/reset targets.

Four PostgreSQL scenarios now pass:

1. Streaming cancellation, queued cancellation and active session revocation,
   retaining the cancelled state and withholding completed/failed events.
2. The same lifecycle for non-streaming tool-completion mode, without executing
   a cancelled tool.
3. Successful terminal SSE delivery observes both completed run state and its
   persisted event through a separate database connection before ASGI send.
4. Failed terminal delivery observes committed failed state and its event at
   the same boundary.

Provider responses are injected; PostgreSQL, migrations, API authorization,
transactions and observation connections are real. This is not credentialed
provider or native-platform acceptance, nor a PostgreSQL performance benchmark.

## Commands and results

The existing task-owned container `aelys-optimization-pg` was verified running
on `127.0.0.1:55436`, PostgreSQL **16.15**. No unrelated container was changed.
The first local attempt used an incorrect assumed test password and produced
4 SQLite passes / 4 PostgreSQL setup errors. Reusing the container's actual
configuration in subprocess memory, without printing credentials, resolved
the setup errors; no server password/authentication policy was changed.

With an operator-provided test role that can create temporary databases:

```sh
export AELYS_TEST_AI_POSTGRES_ADMIN_URL='postgresql+asyncpg://USER:PASSWORD@127.0.0.1:5432/postgres'
PYTHONPATH=backend .venv/bin/python -m pytest -q \
  backend/tests/ai_automation/test_ai_api.py \
  backend/tests/ai_automation/test_ai_event_commit.py
```

- Targeted configured run: **8 passed** (4 SQLite, 4 PostgreSQL).
- Full configured run, `PYTHONPATH=backend .venv/bin/python -m pytest -q backend/tests --junitxml=/tmp/aelys-postgres-ai-contracts-20261030.xml -o junit_family=xunit1`:
  **195 passed, 3 skipped**, one existing Starlette/httpx deprecation warning.
  JUnit confirms all four PostgreSQL AI cases passed. The three skips are
  separate optional gates, not passed tests.
- Without the opt-in variable, selecting `-k postgresql` on the two test files:
  **4 skipped, 4 deselected**, confirming the default suite does not attempt
  an admin connection.
- Targeted Ruff for the fixture and two test files: passed.
- Mypy with `--ignore-missing-imports --check-untyped-defs` on the fixture:
  passed. Production files are unchanged; their prior checks were not repeated.
- CI YAML parses successfully and now contains an explicit step running these
  two files against its existing PostgreSQL service. No remote CI run is claimed.
- `git diff --check`: passed.
- Post-run catalog check: **zero** `aelys_ai_test_*` databases remain.
- Main backend and Vite health at **8000/5173** returned OK. No production
  restart, personal-data mutation, commit, publication or deployment was needed.

The preceding native Keychain/restart/sleep-wake and Android SDK/device/APK
gates remain open. Earlier PostgreSQL sync/migration reports retain their own
scope; these four scenarios add AI-specific evidence rather than replacing
the rest of platform acceptance.
