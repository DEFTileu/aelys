"""Real SQL regressions for exact, bounded-memory reads and index upgrades."""
import asyncio
import os
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from app.core.db import Base
from app.core.models import FinanceAccount, FinanceTransaction, User
from app.domains.finance_summary import summarize_ledger
from sqlalchemy import event, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

INDEXES = {
    "tasks": "ix_tasks_owner_project_live",
    "finance_transactions": "ix_finance_owner_occurred_live",
    "mail_messages": "ix_mail_owner_received_live",
    "activity_events": "ix_activity_owner_occurred",
    "history_entries": "ix_history_owner_created",
    "notifications": "ix_notifications_owner_created_live",
}


@pytest_asyncio.fixture(params=["sqlite", "postgresql"])
async def read_engine(request, tmp_path) -> AsyncIterator[AsyncEngine]:
    admin = None
    name = f"aelys_read_test_{uuid4().hex}"
    if request.param == "postgresql":
        configured = os.environ.get("AELYS_TEST_READ_POSTGRES_ADMIN_URL")
        if not configured:
            pytest.skip("Set AELYS_TEST_READ_POSTGRES_ADMIN_URL for disposable PostgreSQL read tests")
        url = make_url(configured)
        if url.drivername != "postgresql+asyncpg" or url.host not in {"127.0.0.1", "localhost", "::1"} or url.database != "postgres":
            pytest.fail("Read tests require an explicit loopback asyncpg admin URL to postgres")
        admin = create_async_engine(url, isolation_level="AUTOCOMMIT")
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{name}"'))
        engine = create_async_engine(url.set(database=name))
    else:
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/reads.db")
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        yield engine
    finally:
        await engine.dispose()
        if admin:
            try:
                async with admin.connect() as connection:
                    await connection.execute(text(f'DROP DATABASE "{name}"'))
            finally:
                await admin.dispose()


@pytest.mark.asyncio
async def test_summary_preserves_exact_signs_currency_owner_and_tombstone_rules(read_engine):
    sessions = async_sessionmaker(read_engine, expire_on_commit=False)
    async with sessions() as session:
        owner, foreign = User(), User()
        session.add_all([owner, foreign])
        await session.flush()
        account = FinanceAccount(owner_id=owner.id, name="Synthetic", currency="USD")
        session.add(account)
        await session.flush()
        assert await summarize_ledger(session, owner.id) == {"total": "0", "count": 0, "currencies": []}
        amounts = [("income", "9999999999999999.9999"), ("expense", "-0.1001"), ("expense", "0.0001"), ("income", "-0.0002"), ("transfer", "12.3456"), ("transfer", "-12.3456")]
        for kind, amount in amounts:
            session.add(FinanceTransaction(owner_id=owner.id, account_id=account.id, currency="USD", type=kind, amount=Decimal(amount), occurred_at=datetime.now(UTC), notes="Unused body " * 500))
        for other, deleted in ((foreign.id, None), (owner.id, datetime.now(UTC))):
            session.add(FinanceTransaction(owner_id=other, account_id=account.id, currency="USD", type="income", amount=Decimal(100), occurred_at=datetime.now(UTC), deleted_at=deleted))
        await session.commit()
        statements = []

        def observe(_connection, _cursor, statement, _parameters, _context, _many):
            statements.append(statement)

        event.listen(read_engine.sync_engine, "before_cursor_execute", observe)
        try:
            result = await summarize_ledger(session, owner.id)
        finally:
            event.remove(read_engine.sync_engine, "before_cursor_execute", observe)
        assert result["count"] == 6
        assert Decimal(result["total"]) == Decimal("9999999999999999.8999")
        assert Decimal(result["currencies"][0]["income"]) == Decimal("10000000000000000.0001")
        assert Decimal(result["currencies"][0]["expense"]) == Decimal("0.1002")
        assert len(statements) == 1
        selected = statements[0].split("FROM")[0].lower()
        assert "notes" not in selected and ".id" not in selected and ".account_id" not in selected
        assert ("group by" in statements[0].lower()) == (read_engine.dialect.name == "postgresql")
        assert not any(isinstance(value, FinanceTransaction) for value in session.identity_map.values())
        session.add(FinanceTransaction(owner_id=owner.id, account_id=account.id, currency="KZT", type="income", amount=Decimal("10.0201"), occurred_at=datetime.now(UTC)))
        await session.commit()
        multiple = await summarize_ledger(session, owner.id)
        assert multiple["count"] == 7 and multiple["total"] is None
        assert [row["currency"] for row in multiple["currencies"]] == ["KZT", "USD"]
        assert Decimal(multiple["currencies"][0]["balance"]) == Decimal("10.0201")


async def migrate(engine: AsyncEngine, *args: str) -> None:
    backend = Path(__file__).resolve().parents[1]
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "alembic", *args, cwd=backend,
        env={**os.environ, "AELYS_DATABASE_URL": engine.url.render_as_string(hide_password=False), "AELYS_SECRET_KEY": "synthetic-migration-secret-0123456789", "PYTHONPATH": str(backend)},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 30)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    assert process.returncode == 0, output.decode()


@pytest.mark.asyncio
async def test_index_upgrade_downgrade_preserves_existing_rows(read_engine):
    await migrate(read_engine, "stamp", "0038_ai_chat_design")
    async with read_engine.begin() as connection:
        for table, index in INDEXES.items():
            await connection.execute(text(f'DROP INDEX "{index}"'))
        await connection.execute(text("INSERT INTO users (id, created_at, settings_json) VALUES ('existing-owner', CURRENT_TIMESTAMP, '{}')"))
        await connection.execute(text("INSERT INTO tasks (id, owner_id, title, description, status, priority, version, created_at, updated_at) VALUES ('existing-task', 'existing-owner', 'Keep this', '', 'todo', 0, 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"))
    await migrate(read_engine, "upgrade", "head")

    async with read_engine.connect() as connection:
        for table, expected in INDEXES.items():
            indexes = await connection.run_sync(lambda sync, name=table: inspect(sync).get_indexes(name))
            assert expected in {index["name"] for index in indexes}
        assert (await connection.execute(text("SELECT title, version FROM tasks WHERE id='existing-task'"))).one() == ("Keep this", 7)
    await migrate(read_engine, "check")
    await migrate(read_engine, "downgrade", "0038_ai_chat_design")
    async with read_engine.connect() as connection:
        for table, expected in INDEXES.items():
            indexes = await connection.run_sync(lambda sync, name=table: inspect(sync).get_indexes(name))
            assert expected not in {index["name"] for index in indexes}
        assert await connection.scalar(text("SELECT version FROM tasks WHERE id='existing-task'")) == 7
    await migrate(read_engine, "upgrade", "head")


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["notes", "mail"])
async def test_conditional_pages_are_bounded_searchable_and_authorized(read_engine, monkeypatch, kind):
    from app.core import db
    from app.core.models import AuthSession, MailMessage, Note
    from app.core.security import create_token
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    monkeypatch.setattr(db, "SessionLocal", async_sessionmaker(read_engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        boot = await client.post("/api/v1/auth/bootstrap", json={"email": "pages@example.test", "password": "page-test-password"})
        client.headers["Authorization"] = f"Bearer {boot.json()['access_token']}"
        for index in range(7):
            body = {"title": f"Note {index}", "markdown_body": f"needle-{index} " * 2000, "folder": "Later", "tags": ["alpha"]} if kind == "notes" else {"sender": "sender@example.test", "recipients": [], "subject": f"Mail {index}", "body": f"needle-{index} " * 2000, "received_at": "2026-10-29T12:00:00Z"}
            created = await client.post("/api/v1/notes" if kind == "notes" else "/api/v1/mail/messages", json=body)
            assert created.status_code == 200
        async with db.SessionLocal() as session:
            foreign = User()
            session.add(foreign)
            await session.flush()
            auth = AuthSession(owner_id=foreign.id, refresh_token_hash=uuid4().hex, expires_at=datetime.now(UTC) + timedelta(hours=1))
            session.add(auth)
            private = Note(owner_id=foreign.id, title="Foreign", markdown_body="private", folder="Foreign", tags=["foreign"]) if kind == "notes" else MailMessage(owner_id=foreign.id, sender="foreign@example.test", subject="Foreign", body="private", received_at=datetime.now(UTC))
            session.add(private)
            await session.commit()
            foreign_token = create_token(foreign.id, "access", 3600, session_id=auth.id)
            foreign_id = private.id
        path = f"/api/v1/read/{kind}"
        first = await client.get(path, params={"limit": 2})
        assert first.status_code == 200
        assert len(first.json()["items"]) == 2
        etag = first.headers["etag"]
        assert first.json()["etag"] == etag
        foreign_headers = {"Authorization": f"Bearer {foreign_token}"}
        foreign_page = await client.get(path, params={"limit": 2}, headers=foreign_headers)
        assert [item["id"] for item in foreign_page.json()["items"]] == [foreign_id]
        assert foreign_page.headers["etag"] != etag
        assert (await client.get(path, params={"limit": 2, "cursor": first.json()["next_cursor"]}, headers=foreign_headers)).status_code == 403
        if kind == "mail":
            assert (await client.get(f"/api/v1/read/mail/{foreign_id}")).status_code == 404
        statements = []

        def observe(_connection, _cursor, statement, _parameters, _context, _many):
            statements.append(statement)

        event.listen(read_engine.sync_engine, "before_cursor_execute", observe)
        try:
            unchanged = await client.get(path, params={"limit": 2}, headers={"If-None-Match": etag})
        finally:
            event.remove(read_engine.sync_engine, "before_cursor_execute", observe)
        assert unchanged.status_code == 304 and unchanged.content == b""
        selected = [statement.split("FROM")[0].lower() for statement in statements if f"FROM {'notes' if kind == 'notes' else 'mail_messages'}" in statement]
        assert selected and all("markdown_body" not in query and ".body" not in query for query in selected)
        native = await client.get(path, params={"limit": 2, "known_etag": etag})
        assert native.status_code == 200 and native.json()["not_modified"] is True
        ids = [item["id"] for item in first.json()["items"]]
        cursor = first.json()["next_cursor"]
        while cursor:
            page = await client.get(path, params={"limit": 2, "cursor": cursor})
            assert page.status_code == 200
            ids.extend(item["id"] for item in page.json()["items"])
            cursor = page.json()["next_cursor"]
        assert len(ids) == len(set(ids)) == 7
        search = await client.get(path, params={"limit": 2, "q": "needle-6"})
        assert len(search.json()["items"]) == 1
        assert (await client.get(path, params={"limit": 101})).status_code == 422
        wrong_scope = await client.get(path, params={"limit": 3, "cursor": first.json()["next_cursor"]})
        assert wrong_scope.status_code == 422
        unauthorized = await client.get(path, headers={"Authorization": "Bearer invalid", "If-None-Match": etag})
        assert unauthorized.status_code == 401
        if kind == "notes":
            assert first.json()["facets"] == {"folders": ["Later"], "tags": ["alpha"]}
            assert len((await client.get(path, params={"tag": "alpha", "folder": "folder:Later"})).json()["items"]) == 7
            item = first.json()["items"][0]
            await client.patch(f"/api/v1/notes/{item['id']}", params={"version": item["version"]}, json={"title": item["title"], "markdown_body": "Changed"})
            changed = await client.get(path, params={"limit": 2}, headers={"If-None-Match": etag})
            assert changed.status_code == 200 and changed.headers["etag"] != etag
            await client.delete(f"/api/v1/notes/{item['id']}")
            deleted = await client.get(path, params={"limit": 2}, headers={"If-None-Match": changed.headers["etag"]})
            assert deleted.status_code == 200 and item["id"] not in {row["id"] for row in deleted.json()["items"]}
