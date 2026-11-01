"""Real PostgreSQL commit order for mixed server domain mutations and push."""
import asyncio
import os
from uuid import uuid4

import pytest
from app.core.db import Base
from app.core.models import SyncChange, Task, User
from sqlalchemy import func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def postgres_domain_sessions():
    raw = os.environ.get('AELYS_TEST_AI_POSTGRES_ADMIN_URL')
    if not raw:
        pytest.skip('explicit disposable PostgreSQL admin URL required')
    url = make_url(raw)
    assert url.host in {'localhost', '127.0.0.1'} and url.database == 'postgres'
    name = 'aelys_domain_sync_' + uuid4().hex
    admin = create_async_engine(url, isolation_level='AUTOCOMMIT')
    engine = None
    try:
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{name}"'))
        engine = create_async_engine(url.set(database=name))
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as session:
            session.add(User(id='owner'))
            await session.commit()
        yield sessions
    finally:
        if engine is not None:
            await engine.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        await admin.dispose()


async def test_parallel_server_writers_serialize_seq_until_commit(postgres_domain_sessions):
    from app.domains import capture

    sessions = postgres_domain_sessions
    entered = asyncio.Event()
    async with sessions() as first:
        one = await capture.create_task(first, 'owner', title='first uncommitted')
        assert (await first.execute(select(SyncChange).where(SyncChange.resource_id == one.id))).scalar_one()
        async def second_writer():
            async with sessions() as second:
                entered.set()
                two = await capture.create_task(second, 'owner', title='second')
                await second.commit()
                return two.id
        second = asyncio.create_task(second_writer())
        try:
            await asyncio.wait_for(entered.wait(), 2)
            # Verify a real database lock wait, not only coroutine scheduling.
            async with sessions() as observer:
                for _ in range(100):
                    waits = (await observer.execute(text("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())"))).scalar_one()
                    if waits:
                        break
                    await asyncio.sleep(0.01)
                assert waits >= 1
                assert (await observer.execute(select(func.count()).select_from(SyncChange))).scalar_one() == 0
                assert not second.done()
            await first.commit()
            two_id = await asyncio.wait_for(second, 5)
        finally:
            if not second.done():
                second.cancel()
                await asyncio.gather(second, return_exceptions=True)
    async with sessions() as observer:
        changes = list((await observer.execute(select(SyncChange).order_by(SyncChange.seq))).scalars())
        assert [row.resource_id for row in changes] == [one.id, two_id]
        after_first = list((await observer.execute(select(SyncChange).where(
            SyncChange.seq > changes[0].seq).order_by(SyncChange.seq))).scalars())
        assert [row.resource_id for row in after_first] == [two_id]
        for row in changes:
            assert row.version == (await observer.get(Task, row.resource_id)).version


async def test_mixed_rest_capture_and_push_wait_on_same_owner_lock(postgres_domain_sessions, monkeypatch):
    import httpx
    from app.core import db
    from app.core.models import Device
    from app.domains import capture
    from app.main import app
    from app.sync.cursor import CursorCodec

    sessions = postgres_domain_sessions
    monkeypatch.setattr(db, 'SessionLocal', sessions)
    async with sessions() as seed:
        owner = await seed.get(User, 'owner')
        device = Device(id='device', owner_id='owner', platform='web', display_name='Device', credential_hash='synthetic')
        seed.add(device)
        await seed.commit()
    from app.core.security import current_principal
    app.dependency_overrides[current_principal] = lambda: (owner, device)
    try:
        async with sessions() as first, httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            one = await capture.create_task(first, 'owner', title='server first')
            payload = {'device_id': device.id, 'operations': [{
                'device_id': device.id, 'resource_kind': 'task', 'resource_id': 'pushed-task',
                'action': 'create', 'base_version': 0, 'patch': {'title': 'device second'},
            }]}
            pending = asyncio.create_task(client.post('/api/v1/sync/push', json=payload))
            try:
                async with sessions() as observer:
                    for _ in range(100):
                        blocked = (await observer.execute(text("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())"))).scalar_one()
                        if blocked:
                            break
                        await asyncio.sleep(0.01)
                    assert blocked >= 1 and not pending.done()
                await first.commit()
                response = await asyncio.wait_for(pending, 5)
                assert response.status_code == 200, response.text
            finally:
                if not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
            async with sessions() as observer:
                changes = list((await observer.execute(select(SyncChange).order_by(SyncChange.seq))).scalars())
                assert [row.resource_id for row in changes] == [one.id, 'pushed-task']
                second_row = await observer.get(Task, 'pushed-task')
                assert second_row.title == 'device second' and second_row.version == 1
                from app.core.config import get_settings
                cursor = CursorCodec(get_settings().secret_key.encode()).encode(
                    kind='pull', owner_id='owner', commit_seq=changes[0].seq)
            pulled = await client.get('/api/v1/sync/pull', params={'cursor': cursor})
            assert pulled.status_code == 200, pulled.text
            assert [row['resource_id'] for row in pulled.json()['changes']] == ['pushed-task']
    finally:
        app.dependency_overrides.pop(current_principal, None)
