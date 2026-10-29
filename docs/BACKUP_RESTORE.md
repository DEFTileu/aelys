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
Run a clean restore drill before treating a backup as recoverable. Mac-only
session indexes and transcripts require a separate explicit local Mac backup
decision; this workflow does not copy them off Mac.
