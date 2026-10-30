# Local launcher process lifecycle

2026-10-30. Task: IMPLEMENTATION_PLAN Phase 8, local setup/release hardening.
Scope: `scripts/start_local.*`, development-only Vite identification, regression
tests, CI and setup documentation. No product/UI/architecture decision.

## Defect and change

The previous shell script started uvicorn in the background, installed a cleanup
trap, then used `exec` for pnpm. Replacing the shell discarded the EXIT trap, so
frontend exit could leave its backend running. The trap also tracked only the
backend PID, without supervising frontend descendants or reacting to backend
failure. Service discovery accepted any response containing `"status":"ok"`.

The shell entry point now delegates to a Python standard-library supervisor.
Each newly created service has its own process group. SIGINT/SIGTERM, backend
startup/runtime failure and frontend exit all reach cleanup. The helper sends
TERM, waits up to five seconds for its child leaders, kills remaining owned
groups and reaps the leaders. Reused services are never registered as children
and are not stopped. A stop during startup is recorded without interrupting
process registration. No external process manager or dependency was added.

Discovery now checks the public health and Aelys OpenAPI title/routes. Vite
exposes `/__aelys_dev` only in development, identifying the web service and its
configured backend origin. Reuse requires an exact origin match, so a healthy
web server pointing at another database/backend is not silently selected.
These checks identify services for port discovery; owner authentication and
authorization are unchanged. Probes are bounded, do not follow redirects or
use environment proxies, and retain HTTPS certificate validation.

Defaults still allow loopback fallback ports. Explicit port settings fail on
conflicts, and an explicit backend origin must already be a healthy Aelys API.
Origins containing credentials, paths or queries are rejected without echoing
their contents. No personal database, keys, accounts or unrelated processes were
changed. SDK/license and native Keychain gates remain unresolved.

## Verification

- `.venv/bin/python -m pytest -q scripts/tests/test_start_local.py`: **19 passed**.
  Tests launch disposable HTTP/process fixtures on temporary ports, including a
  descendant that acknowledges installing a SIGTERM-ignore handler. They cover
  SIGINT/SIGTERM cleanup, startup cancellation/failure, either service failing,
  preserving reused backend/web processes, exact-backend web reuse, rejecting
  generic health services, invalid ports and secret-bearing origin validation.
  The fixtures never import the Aelys backend or open its database.
- `.venv/bin/ruff check scripts/start_local.py scripts/tests`: passed.
- `.venv/bin/mypy --ignore-missing-imports --check-untyped-defs scripts/start_local.py`:
  passed. These targeted gates are also included in the backend CI job; no
  remote CI run or repository-wide quality pass is claimed.
- `bash -n scripts/start_local.sh`: passed.
- `pnpm --filter @aelys/web typecheck`: passed.
- `pnpm --filter @aelys/web test`: **165 passed**.
- `pnpm --filter @aelys/web build`: passed; production asset hashes remain the
  same as the preceding native-streaming build. The identification middleware
  applies to the dev server only; no native artifact was rebuilt in this slice.
- `./scripts/start_local.sh`: reused the actual existing backend/web at
  `127.0.0.1:8000/5173`, exited zero and left PIDs 33756/70427 unchanged.
- Actual uvicorn + pnpm/Vite smoke: created a temporary SQLite database and
  ephemeral local keys, applied `alembic upgrade head` with an overridden
  `AELYS_DATABASE_URL`, then invoked the same launcher with fixed unused ports
  **50923/50924**. Direct and proxied health/OpenAPI passed, and proxied browser
  status reported `initialized=false`, confirming an empty test owner store.
  SIGTERM returned **143**; connection checks verified both listeners closed.
  Temporary files were removed after shutdown; the main 8000/5173 services
  remained running. This proves local start/proxy/stop, not owner CRUD or
  platform login/Keychain behavior.
- `git diff --check`: passed.

No commits, staging, deployment or publication were performed.
