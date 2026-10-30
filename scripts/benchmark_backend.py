"""Synthetic, isolated API benchmark. Never defaults to the owner's database.

Run: PYTHONPATH=backend .venv/bin/python scripts/benchmark_backend.py --output /tmp/aelys-before.json
A PostgreSQL URL may be supplied only for an explicitly disposable empty database.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import statistics
import tempfile
import time
import tracemalloc
from uuid import uuid4
from datetime import datetime, timedelta, timezone

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--database-url", help="Explicit empty disposable PostgreSQL database; never use personal data")
parser.add_argument("--records", type=int, default=2000)
parser.add_argument("--repeats", type=int, default=15)
args = parser.parse_args()
if args.records < 1 or args.repeats < 3:
    parser.error("records must be positive and repeats >= 3")
work = tempfile.TemporaryDirectory(prefix="aelys-api-benchmark-")
os.environ["AELYS_DATABASE_URL"] = args.database_url or f"sqlite+aiosqlite:///{work.name}/synthetic.db"
os.environ["AELYS_SECRET_KEY"] = "synthetic-benchmark-only-secret-0123456789"

from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import event, select, func  # noqa: E402
from app.core import db  # noqa: E402
from app.core.models import User, AuthSession, Project, Task, Note, MailMessage  # noqa: E402
from app.core.security import create_token  # noqa: E402
from app.main import app  # noqa: E402


async def main() -> None:
    async with db.engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    async with db.SessionLocal() as session:
        if (await session.scalar(select(func.count()).select_from(User))) != 0:
            raise RuntimeError("Benchmark requires an empty disposable database; no records were changed")
        owner = User(email="benchmark@example.test", password_hash=None)
        session.add(owner)
        await session.flush()
        auth = AuthSession(owner_id=owner.id, refresh_token_hash=uuid4().hex, expires_at=datetime.now(timezone.utc) + timedelta(hours=1))
        project = Project(owner_id=owner.id, name="Synthetic project")
        session.add_all([auth, project])
        await session.flush()
        token = create_token(owner.id, "access", 3600, session_id=auth.id)
        for index in range(args.records):
            session.add(Task(owner_id=owner.id, title=f"benchmarkmatch task {index}", description="Synthetic description " * 30, project_id=project.id if index % 10 == 0 else None))
            session.add(Note(owner_id=owner.id, title=f"benchmarkmatch note {index}", markdown_body="Synthetic Markdown body " * 350))
            session.add(MailMessage(owner_id=owner.id, subject=f"benchmarkmatch mail {index}", sender="fixture@example.test", recipients=[], body="Synthetic mail body " * 350, received_at=datetime.now(timezone.utc)))
        await session.commit()
        project_id = project.id
    queries = 0

    def count_query(*_args):
        nonlocal queries
        queries += 1

    event.listen(db.engine.sync_engine, "before_cursor_execute", count_query)
    report = {"method": "httpx ASGITransport, real SQLAlchemy DB, no worker lifespan; includes authentication SQL, no network latency", "dialect": db.engine.dialect.name, "records_per_domain": args.records, "repeats": args.repeats, "endpoints": {}}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://benchmark", headers={"Authorization": f"Bearer {token}"}) as client:
        for name, path in [("task_list", "/api/v1/tasks"), ("project_tasks", f"/api/v1/tasks?project_id={project_id}"), ("notes", "/api/v1/notes"), ("search", "/api/v1/search?q=benchmarkmatch")]:
            durations = []
            counts = []
            size = 0
            for iteration in range(args.repeats + 1):
                queries = 0
                started = time.perf_counter()
                response = await client.get(path)
                elapsed = (time.perf_counter() - started) * 1000
                response.raise_for_status()
                size = len(response.content)
                if iteration == 0:
                    cold = elapsed
                else:
                    durations.append(elapsed)
                    counts.append(queries)
            ordered = sorted(durations)
            report["endpoints"][name] = {"first_request_ms": round(cold, 3), "warm_p50_ms": round(statistics.median(durations), 3), "warm_p95_ms": round(ordered[min(len(ordered) - 1, int(len(ordered) * .95))], 3), "response_bytes": size, "queries_min": min(counts), "queries_max": max(counts)}
        tracemalloc.start()
        response = await client.get("/api/v1/search?q=benchmarkmatch")
        response.raise_for_status()
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        report["search_peak_python_bytes"] = peak
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    await db.engine.dispose()


try:
    asyncio.run(main())
finally:
    work.cleanup()
