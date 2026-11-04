"""Benchmark read paths on a fresh synthetic database, never the application DB."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import tempfile
import time
import tracemalloc
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import uuid4


async def benchmark(database_url: str, records: int, repeats: int) -> dict:
    # Import only after selecting the explicitly disposable database.
    os.environ["AELYS_DATABASE_URL"] = database_url
    os.environ["AELYS_SECRET_KEY"] = "synthetic-read-benchmark-secret-0123456789"
    from app.core import db
    from app.core.models import (
        ActivityEvent,
        AuthSession,
        FinanceAccount,
        FinanceTransaction,
        HistoryEntry,
        MailMessage,
        Notification,
        Project,
        Task,
        User,
    )
    from app.core.security import create_token
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import event, insert, inspect, select, text

    try:
        async with db.engine.begin() as connection:
            tables = await connection.run_sync(lambda sync: inspect(sync).get_table_names())
            if tables:
                raise RuntimeError("Read benchmark requires an empty disposable database")
            await connection.run_sync(db.Base.metadata.create_all)
        now = datetime.now(UTC)
        async with db.SessionLocal() as session:
            owner = User(email="read-benchmark@example.test")
            session.add(owner)
            await session.flush()
            auth = AuthSession(owner_id=owner.id, refresh_token_hash=uuid4().hex, expires_at=now + timedelta(hours=1))
            project = Project(owner_id=owner.id, name="Synthetic project")
            account = FinanceAccount(owner_id=owner.id, name="Synthetic account", currency="USD")
            session.add_all([auth, project, account])
            await session.flush()
            owner_id = owner.id
            project_id = project.id
            token = create_token(owner_id, "access", 3600, session_id=auth.id)
            for model in (Task, FinanceTransaction, MailMessage, Notification, ActivityEvent, HistoryEntry):
                rows = []
                for index in range(records):
                    timestamp = now - timedelta(seconds=index)
                    base = {"owner_id": owner_id, "created_at": timestamp}
                    if model is Task:
                        base.update(title=f"Synthetic task {index}", project_id=project_id if index % 100 == 0 else None)
                    elif model is FinanceTransaction:
                        base.update(account_id=account.id, amount=Decimal("0.1001"), currency="USD", type="income", occurred_at=timestamp, notes="Synthetic posting " * 100)
                    elif model is MailMessage:
                        base.update(subject="Synthetic mail", sender="fixture@example.test", recipients=[], body="Synthetic body " * 100, received_at=timestamp)
                    elif model is Notification:
                        base.update(title="Synthetic notice", kind="info")
                    elif model is ActivityEvent:
                        base.update(event_kind="synthetic", actor_kind="user", occurred_at=timestamp)
                    else:
                        base.update(action="synthetic", actor="user")
                    rows.append(base)
                await session.execute(insert(model), rows)
            await session.commit()
        async with db.engine.begin() as connection:
            await connection.execute(text("ANALYZE"))

        query_count = 0

        def observe(*_args) -> None:
            nonlocal query_count
            query_count += 1

        event.listen(db.engine.sync_engine, "before_cursor_execute", observe)
        report = {"method": "Synthetic httpx ASGI requests; includes auth SQL, excludes network and workers", "dialect": db.engine.dialect.name, "records_per_table": records, "repeats": repeats, "endpoints": {}, "plans": {}}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://benchmark", headers={"Authorization": f"Bearer {token}"}) as client:
            for name, path in (
                ("project_tasks", f"/api/v1/tasks?project_id={project_id}"),
                ("finance_summary", "/api/v1/finance/summary"),
                ("activity", "/api/v1/activity"),
                ("history", "/api/v1/history"),
                ("notifications", "/api/v1/notifications"),
            ):
                durations = []
                counts = []
                for iteration in range(repeats + 1):
                    query_count = 0
                    started = time.perf_counter()
                    response = await client.get(path)
                    elapsed = (time.perf_counter() - started) * 1000
                    response.raise_for_status()
                    if iteration:
                        durations.append(elapsed)
                        counts.append(query_count)
                report["endpoints"][name] = {"warm_p50_ms": round(statistics.median(durations), 3), "warm_p95_ms": round(sorted(durations)[min(len(durations) - 1, int(len(durations) * .95))], 3), "queries_min": min(counts), "queries_max": max(counts), "response_bytes": len(response.content)}
            tracemalloc.start()
            response = await client.get("/api/v1/finance/summary")
            response.raise_for_status()
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            report["finance_summary_peak_python_bytes"] = peak
        event.remove(db.engine.sync_engine, "before_cursor_execute", observe)

        async with db.engine.connect() as connection:
            for name, model, column, live in (
                ("project_tasks", Task, None, True),
                ("finance_transactions", FinanceTransaction, FinanceTransaction.occurred_at, True),
                ("mail_messages", MailMessage, MailMessage.received_at, True),
                ("activity", ActivityEvent, ActivityEvent.occurred_at, False),
                ("history", HistoryEntry, HistoryEntry.created_at, False),
                ("notifications", Notification, Notification.created_at, True),
            ):
                query = select(model).where(model.owner_id == owner_id)
                if live:
                    query = query.where(model.deleted_at.is_(None))
                if column is not None:
                    query = query.order_by(column.desc())
                    if model in {ActivityEvent, HistoryEntry, Notification}:
                        query = query.limit(200)
                else:
                    query = query.where(Task.project_id == project_id)
                sql = str(query.compile(dialect=db.engine.dialect, compile_kwargs={"literal_binds": True}))
                prefix = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " if db.engine.dialect.name == "postgresql" else "EXPLAIN QUERY PLAN "
                rows = (await connection.execute(text(prefix + sql))).all()
                if db.engine.dialect.name == "postgresql":
                    report["plans"][name] = rows[0][0][0]
                else:
                    report["plans"][name] = [row[3] for row in rows]
        return report
    finally:
        await db.engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="Explicit EMPTY disposable database")
    parser.add_argument("--records", type=int, default=10_000)
    parser.add_argument("--repeats", type=int, default=7)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.records < 1 or args.repeats < 3:
        parser.error("records must be positive and repeats >= 3")
    with tempfile.TemporaryDirectory(prefix="aelys-read-benchmark-") as directory:
        url = args.database_url or f"sqlite+aiosqlite:///{directory}/synthetic.db"
        report = asyncio.run(benchmark(url, args.records, args.repeats))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "plans"}, indent=2))


if __name__ == "__main__":
    main()
