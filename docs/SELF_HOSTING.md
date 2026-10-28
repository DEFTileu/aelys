# Local development and self-hosting

Aelys is a single-owner instance. The bootstrap endpoint initializes the one
owner; device enrollment identifies that owner's Web, Mac and Android devices.
It is not a public registration or team-account flow.

## Web + SQLite quickstart

From a clean checkout:

```sh
cp backend/.env.example backend/.env
# Edit backend/.env and replace AELYS_SECRET_KEY.

python3 -m venv .venv
.venv/bin/python -m pip install -e 'backend[test,quality]'
cd backend
PYTHONPATH=. ../.venv/bin/alembic upgrade head
PYTHONPATH=. ../.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In a second terminal:

```sh
pnpm install --frozen-lockfile
VITE_API_BASE_URL=/api/v1 pnpm --filter @aelys/web dev -- --host 127.0.0.1 --port 5173
```

The Vite development server proxies `/api` to `http://127.0.0.1:8000`.
Open the printed Web URL, go to Settings, and open the owner session. The Web
client enrolls a device credential for this browser after login.

## PostgreSQL

Set `AELYS_DATABASE_URL` to a PostgreSQL async URL, for example:

```text
postgresql+asyncpg://aelys:change-me@127.0.0.1:5432/aelys
```

Create the database and role using the PostgreSQL operator's normal secure
procedure, then run:

```sh
cd backend
PYTHONPATH=. ../.venv/bin/alembic upgrade head
```

Run the PostgreSQL integration tests with `AELYS_DATABASE_URL` set. Production
TLS, role hardening, backup retention and process supervision remain operator
responsibilities and are release prerequisites.

## Containerized backend + PostgreSQL

The repository includes `compose.self-hosted.yaml` for a reproducible local
operator setup. It starts only the backend and PostgreSQL; serve the built web
client through the operator's chosen web server and configure its API base URL.
Secrets are supplied through the shell and are never committed:

```sh
export AELYS_SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export POSTGRES_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
docker compose -f compose.self-hosted.yaml up --build
```

The backend is then available at `http://127.0.0.1:8000`; verify `/healthz`
and open `/docs` for the API contract. Stop it with:

```sh
docker compose -f compose.self-hosted.yaml down
```

The named PostgreSQL volume is retained by `down`; use the documented backup
and restore drill in [BACKUP_RESTORE.md](BACKUP_RESTORE.md) before removing it.
This Compose file is a local/self-hosting development path. TLS, reverse proxy,
operator role hardening, backups, monitoring and production process policy are
deliberate deployment responsibilities.

## Checks

```sh
make compile
make test
AELYS_SECRET_KEY="$AELYS_SECRET_KEY" make openapi
pnpm --filter @aelys/shared typecheck
pnpm --filter @aelys/shared test
pnpm --filter @aelys/web typecheck
pnpm --filter @aelys/web test
pnpm --filter @aelys/web build
cargo test --manifest-path apps/runtime/Cargo.toml --locked
```

Use [BACKUP_RESTORE.md](BACKUP_RESTORE.md) for encrypted single-owner export
and restore. Raw Mac agent sessions are intentionally outside that workflow.

The macOS and Android wrappers have separate platform prerequisites and are not
claimed as packaged releases until their platform gates pass. Vendor execution
also remains fail-closed until the signed helper/isolation evidence is present.
