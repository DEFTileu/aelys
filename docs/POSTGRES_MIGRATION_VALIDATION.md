# PostgreSQL migration validation

Additional AI-specific evidence is now available in
[PostgreSQL AI contracts](optimization/postgres-ai-contracts.md): four fresh
migrated databases validate cancellation, active revocation and committed SSE
delivery. That test fixture uses a separate explicit admin opt-in and does not
reuse the database URLs described below.

Task: milestone 0 database migration and auth/device scaffolding, focused on clean installs and the existing Alembic upgrade chain. Assumptions: tests run against a disposable, empty database; current model metadata and the checked-out revision chain are the intended schema. Existing architecture and OPEN/PROPOSED decisions remain unchanged; no new product or infrastructure decision is made here.

Revision 0001 historically creates tables from live application metadata, excluding tables created by later migrations. Gmail OAuth state references `auth_sessions`, which revision 0005 creates; revision 0001 now leaves that table to revision 0016. Other tables are not deferred just because they are new: revisions 0014, 0016, 0017 and 0022 tolerate their earlier presence, and the current dependency graph was checked against tables omitted from 0001. This is a targeted repair, not a frozen historical schema. Future model changes can still alter old revisions: revisions 0001, 0016 and 0017 use live model tables, and additions must be checked against the full upgrade chain on PostgreSQL as well as SQLite.

Revision 0013 now checks for equivalent AI run foreign keys before adding them on PostgreSQL: live metadata may already have created them. It still adds missing constraints on older schemas. Databases already past 0013 are unchanged, including any duplicate constraints previously created; removing those would need a separate forward migration. `alembic check` reports model drift, but does not detect duplicate equivalent foreign keys, so the regression test inspects them explicitly.

From `backend/`, with dependencies installed, run SQLite and PostgreSQL migration regression tests against a **new empty disposable database** (the test refuses databases with existing tables or views and does not drop anything):

```sh
export AELYS_TEST_POSTGRES_MIGRATION_URL='postgresql+asyncpg://USER:PASSWORD@HOST:PORT/EMPTY_TEST_DATABASE'
../.venv/bin/python -m pytest -q tests/test_clean_migrations.py tests/test_sqlite_upgrade_repair.py tests/test_telegram_models.py
```

Without `AELYS_TEST_POSTGRES_MIGRATION_URL`, the PostgreSQL case skips and SQLite still runs. The test advances through 0001, 0005, 0013, 0016 and head, preserves an inserted user, verifies the Gmail session reference and both AI foreign keys, and runs `alembic check`. For a separate empty database, direct validation is:

```sh
export AELYS_DATABASE_URL='postgresql+asyncpg://USER:PASSWORD@HOST:PORT/EMPTY_TEST_DATABASE'
../.venv/bin/python -m alembic upgrade head
../.venv/bin/python -m alembic check
```

Use an equivalent `sqlite+aiosqlite:////absolute/path/to/new.db` URL for SQLite. Configure `AELYS_SECRET_KEY` as required by the backend environment. Do not use an existing personal database for clean-install tests. The regression does not emulate every historical production schema or verify downgrade of data-bearing databases; SQLite revision 0019 intentionally refuses downgrade to avoid losing money precision.
