# Aelys backup, restore and export

Aelys exports only the single owner's synced domain data. The encrypted export
excludes authentication sessions, device credentials, provider API keys,
project grants, and raw Claude Code/Codex sessions. Full agent sessions remain
on the Mac runtime and are not included in cloud or owner exports.

Set a separate 32-byte `AELYS_EXPORT_KEY` as hex or URL-safe base64. Keep it in
an operator secret store; it is not written to the export file.

```sh
cd backend
export AELYS_SECRET_KEY='replace-with-at-least-32-random-characters'
export AELYS_DATABASE_URL='sqlite+aiosqlite:///./aelys.db'
export AELYS_EXPORT_KEY='replace-with-64-hex-characters'

PYTHONPATH=. ../.venv/bin/python scripts/export_owner.py \
  --owner-email owner@example.com --output /secure/aelys-owner.aelys-export
```

Restore into an already initialized single-owner database. Restore never
creates credentials or devices; bootstrap the owner separately and verify the
target database before importing.

```sh
PYTHONPATH=. ../.venv/bin/python scripts/restore_owner.py \
  --owner-email owner@example.com --source /secure/aelys-owner.aelys-export
```

For PostgreSQL physical backups, use the database operator's encrypted
`pg_dump`/restore process and protect the dump with the same operational care.
The following logical backup drill keeps the restore target isolated:

```sh
# Run with AELYS_DATABASE_URL pointing at the source database.
pg_dump --format=custom --no-owner --file=/secure/aelys.dump "$AELYS_DATABASE_URL"

# Create an empty restore database through the normal PostgreSQL operator path.
createdb aelys_restore_check
pg_restore --clean --if-exists --no-owner --dbname=aelys_restore_check /secure/aelys.dump

# Point AELYS_DATABASE_URL at the restored database and verify schema/tests.
cd backend
PYTHONPATH=. ../.venv/bin/alembic check
AELYS_DATABASE_URL="$AELYS_DATABASE_URL" PYTHONPATH=.. ../.venv/bin/pytest \
  -q tests/test_postgres_integration.py
```

Drop `aelys_restore_check` only after the operator has inspected the restored
data. Run a clean restore drill before treating a backup as recoverable. Mac-only
session indexes and transcripts require a separate explicit local Mac backup
decision; this workflow does not copy them off Mac.

To rotate provider secret encryption, provision the new
`AELYS_PROVIDER_ENCRYPTION_KEY`, temporarily provide the old key as
`AELYS_PROVIDER_ENCRYPTION_KEY_OLD`, and run:

```sh
cd backend
PYTHONPATH=. ../.venv/bin/python scripts/rotate_provider_secrets.py
```

The script re-encrypts envelopes in memory, increments `key_version`, and
prints only the number of rotated records. Remove the old key from the
environment immediately after the operation. KMS/OS-keychain custody remains
an operator deployment decision.
