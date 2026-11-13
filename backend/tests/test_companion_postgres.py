"""CompanionState row lock and race-free creation on real PostgreSQL (opt-in, same switch as the other PostgreSQL tests)."""
import asyncio
import os
from uuid import uuid4

import pytest
import pytest_asyncio
from app.companion import channel as channel_module
from app.companion.hub import hub
from app.companion.models import CompanionState
from app.companion.state import locked_state
from app.core import db
from app.core.models import Device, User
from app.main import app
from companion_helpers import B, bearer, pair_companion
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

LOST_ON = {'on': True, 'message': 'Call me', 'show_phone': True, 'show_telegram': False}


@pytest_asyncio.fixture
async def postgres(monkeypatch):
    raw = os.environ.get('AELYS_TEST_AI_POSTGRES_ADMIN_URL')
    if not raw:
        pytest.skip('explicit disposable PostgreSQL admin URL required')
    url = make_url(raw)
    assert url.host in {'localhost', '127.0.0.1'} and url.database == 'postgres'
    name = 'aelys_companion_' + uuid4().hex
    admin = create_async_engine(url, isolation_level='AUTOCOMMIT')
    engine = None
    try:
        async with admin.connect() as connection:
            await connection.execute(text(f'CREATE DATABASE "{name}"'))
        engine = create_async_engine(url.set(database=name))
        async with engine.begin() as connection:
            await connection.run_sync(db.Base.metadata.create_all)
        monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
        hub._owner_locks.clear()
        yield engine
    finally:
        if engine is not None:
            await engine.dispose()
        async with admin.connect() as connection:
            await connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        await admin.dispose()


async def test_state_row_is_created_once_and_serialises_lost_mode_writers(postgres):
    from httpx import ASGITransport, AsyncClient
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        owner, _, device_id = await pair_companion(http)
        owner_id = (await http.get(f'{B}/me', headers=bearer(owner))).json()['id']
        sent: list[dict] = []

        async def reply(message):
            sent.append(message)

        async def close(code):
            pass
        link = channel_module._Link(device_id, owner_id, reply, close)
        # hello creates the row through the pg_insert ... ON CONFLICT DO NOTHING + FOR UPDATE path.
        await channel_module._hello(link, {'type': 'hello', 'fw_version': '0.4.1', 'board': 'esp32', 'features': []})
        assert sent == []

        # Two concurrent writers must both land: the row lock makes revs 1 and 2, the newer one replaces the older.
        puts = await asyncio.gather(*(http.put(f'{B}/companion/devices/{device_id}/lost-mode', json={**LOST_ON, 'message': m}, headers=bearer(owner)) for m in ('A', 'B')))
        assert [p.status_code for p in puts] == [200, 200]
        async with db.SessionLocal() as session:
            row = (await session.execute(select(CompanionState).where(CompanionState.device_id == device_id))).scalar_one()
            assert row.fw_version == '0.4.1' and row.lost_mode_json['rev'] == 2
            assert [(c['name'], c['args']['rev']) for c in row.pending_commands_json] == [('lost_mode', 2)]
            queued_id = row.pending_commands_json[0]['id']

        await channel_module._hello(link, {'type': 'hello', 'fw_version': '0.4.1', 'board': 'esp32', 'features': []})
        assert [(m['id'], m['args']['rev']) for m in sent] == [(queued_id, 2)]
        await channel_module._command_ack(link, {'type': 'command_ack', 'id': queued_id, 'ok': True})
        async with db.SessionLocal() as session:
            row = (await session.execute(select(CompanionState).where(CompanionState.device_id == device_id))).scalar_one()
            assert row.pending_commands_json == [] and row.lost_mode_json['rev'] == 2


async def test_first_touch_race_creates_one_row(postgres):
    """Several writers meeting a device that has no state row yet: the insert is conflict-free and nobody errors."""
    async with db.SessionLocal() as session:
        user = User(email=None, password_hash=None)
        session.add(user)
        await session.flush()
        device = Device(owner_id=user.id, platform='companion', display_name='Desk', public_key='k', credential_hash='x')
        session.add(device)
        await session.commit()
        owner_id, device_id = user.id, device.id

    async def touch(n):
        async with db.SessionLocal() as session:
            row = await locked_state(session, device_id, owner_id)
            row.last_metrics_json = {'n': n}
            await asyncio.sleep(0.05)  # hold the lock so the others really queue behind it
            await session.commit()
    await asyncio.gather(*(touch(n) for n in range(4)))
    async with db.SessionLocal() as session:
        assert len((await session.execute(select(CompanionState).where(CompanionState.device_id == device_id))).scalars().all()) == 1
