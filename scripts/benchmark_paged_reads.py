"""Compare full-list, first-page and conditional reads on disposable data."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4


async def benchmark(url: str, records: int, repeats: int) -> dict:
    os.environ["AELYS_DATABASE_URL"] = url
    os.environ["AELYS_SECRET_KEY"] = "synthetic-paged-benchmark-secret-0123456789"
    from app.core import db
    from app.core.models import AuthSession, MailMessage, Note, User
    from app.core.security import create_token
    from app.main import app
    from httpx import ASGITransport, AsyncClient
    from sqlalchemy import insert, inspect

    try:
        async with db.engine.begin() as connection:
            if await connection.run_sync(lambda sync: inspect(sync).get_table_names()):
                raise RuntimeError("Benchmark requires an empty disposable database")
            await connection.run_sync(db.Base.metadata.create_all)
        async with db.SessionLocal() as session:
            owner = User()
            session.add(owner)
            await session.flush()
            auth = AuthSession(owner_id=owner.id, refresh_token_hash=uuid4().hex, expires_at=datetime.now(UTC) + timedelta(hours=1))
            session.add(auth)
            await session.flush()
            token = create_token(owner.id, "access", 3600, session_id=auth.id)
            await session.execute(insert(Note), [{"owner_id": owner.id, "title": f"Fixture note {i}", "markdown_body": "Synthetic note body " * 400} for i in range(records)])
            await session.execute(insert(MailMessage), [{"owner_id": owner.id, "subject": f"Fixture mail {i}", "sender": "fixture@example.test", "body": "Synthetic mail body " * 400, "received_at": datetime.now(UTC)} for i in range(records)])
            await session.commit()
        result = {"method": "Synthetic ASGI requests; no workers/network; body bytes exclude HTTP headers", "dialect": db.engine.dialect.name, "records_per_collection": records, "repeats": repeats, "endpoints": {}}
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://benchmark", headers={"Authorization": f"Bearer {token}"}) as client:
            for kind, legacy in [("notes", "/notes"), ("mail", "/mail/messages")]:
                for name, path in [(f"{kind}_full", legacy), (f"{kind}_page", f"/read/{kind}?limit=50")]:
                    durations = []
                    for iteration in range(repeats + 1):
                        start = time.perf_counter()
                        response = await client.get(f"/api/v1{path}")
                        response.raise_for_status()
                        if iteration:
                            durations.append((time.perf_counter() - start) * 1000)
                    result["endpoints"][name] = {"warm_p50_ms": round(statistics.median(durations), 3), "body_bytes": len(response.content), "items": len(response.json()["items"]) if name.endswith("_page") else len(response.json())}
                    if name.endswith("_page"):
                        unchanged = await client.get(f"/api/v1{path}", headers={"If-None-Match": response.headers["etag"]})
                        assert unchanged.status_code == 304
                        result["endpoints"][f"{kind}_unchanged"] = {"status": unchanged.status_code, "body_bytes": len(unchanged.content)}
        return result
    finally:
        await db.engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="Explicit EMPTY disposable database")
    parser.add_argument("--records", type=int, default=2000)
    parser.add_argument("--repeats", type=int, default=7)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.records < 1 or args.repeats < 3:
        parser.error("records must be positive and repeats >= 3")
    with tempfile.TemporaryDirectory(prefix="aelys-paged-reads-") as directory:
        result = asyncio.run(benchmark(args.database_url or f"sqlite+aiosqlite:///{directory}/synthetic.db", args.records, args.repeats))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
