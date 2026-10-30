"""Search reads only public result fields; deleted and foreign rows stay hidden."""
from datetime import UTC, datetime

import pytest
from app.core import db
from app.core.models import MailMessage, Note, Task, User
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
async def test_search_excludes_tombstones_and_other_owners_and_does_not_select_bodies(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/search.db")
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", sessions)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        boot = await client.post("/api/v1/auth/bootstrap", json={"email": "search@example.test", "password": "synthetic-search-password"})
        assert boot.status_code == 200
        client.headers["Authorization"] = f"Bearer {boot.json()['access_token']}"
        me = (await client.get("/api/v1/me")).json()
        async with sessions() as session:
            foreign = User(email="foreign-search@example.test")
            session.add(foreign)
            await session.flush()
            for model, title in [(Note, "Note match"), (Task, "Task match"), (MailMessage, "Mail match")]:
                fields = {"title": title, "description": "needle"} if model is Task else {"title": title, "markdown_body": "needle"} if model is Note else {"subject": title, "body": "needle", "sender": "fixture@example.test", "recipients": [], "received_at": datetime.now(UTC)}
                session.add(model(owner_id=me['id'], **fields))
                session.add(model(owner_id=me['id'], deleted_at=datetime.now(UTC), **fields))
                session.add(model(owner_id=foreign.id, **fields))
            await session.commit()
        statements = []

        def observe(_connection, _cursor, statement, _params, _context, _many):
            statements.append(statement)

        event.listen(engine.sync_engine, "before_cursor_execute", observe)
        response = await client.get("/api/v1/search", params={"q": "needle"})
        event.remove(engine.sync_engine, "before_cursor_execute", observe)
        assert response.status_code == 200
        results = response.json()['results']
        assert len(results) == 3
        assert {item['kind'] for item in results} == {'note', 'task', 'mail'}
        assert all(set(item) == {'kind', 'id', 'title'} for item in results)
        selects = [query.split('FROM')[0].lower() for query in statements if any(f'FROM {table}' in query for table in ('notes', 'tasks', 'mail_messages'))]
        assert len(selects) == 3
        for select_fields in selects:
            assert 'markdown_body' not in select_fields
            assert '.description' not in select_fields
            assert '.body' not in select_fields
    await engine.dispose()
