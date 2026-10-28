# Aelys backend

Run locally with `../.venv/bin/uvicorn app.main:app --reload` from `backend/`. Copy `.env.example` to `.env` and set a random `AELYS_SECRET_KEY`; startup fails when it is missing. The default test database is SQLite; PostgreSQL is supported through `AELYS_DATABASE_URL=postgresql+asyncpg://...`. Apply the schema with `alembic upgrade head`.

Gmail OAuth, Telegram delivery, and unattended macOS CLI execution remain disabled until their open decisions and security gates are resolved. Agent session content is absent from cloud models and sync payloads.

For a release build, generate the operator-pinned runtime trust values with
`PYTHONPATH=. ../.venv/bin/python scripts/generate_runtime_manifest.py
--runtime <runtime-binary> --probe <isolation-probe>`. The command prints only
the public key and signed manifest; keep `AELYS_RUNTIME_TRUST_PRIVATE_KEY` (if
provided) outside the repository.
