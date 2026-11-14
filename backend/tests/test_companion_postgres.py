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


async def test_character_epochs_and_sequences_fence_concurrent_writers(postgres, monkeypatch):
    """Overlapping sessions and reports cannot restore a stale character state."""
    from app.core.security import decode_token
    from companion_helpers import companion_token
    from httpx import ASGITransport, AsyncClient

    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        _, board, device_id = await pair_companion(http)
        claims = decode_token(await companion_token(http, board, device_id))
        closed: list[int] = []

        async def reply(_message):
            pass

        async def close(code):
            closed.append(code)

        links = [channel_module._Link(device_id, claims['sub'], reply, close, session_id=claims['sid'])
                 for _ in range(8)]
        epochs = await asyncio.gather(*(channel_module._begin_character_session(link) for link in links))
        assert sorted(epochs) == list(range(1, 9))
        for link, epoch in zip(links, epochs):
            link.character_epoch = epoch
        latest = max(links, key=lambda link: link.character_epoch)
        stale = [link for link in links if link is not latest]

        def message(seq, mood, reason):
            return {'type': 'character_state', 'lost_rev': 0, 'seq': seq, 'mood': mood, 'reason': reason}

        await asyncio.gather(
            *(channel_module._character_state(link, message(1000 + index, 'sad', 'overdue'))
              for index, link in enumerate(stale)),
            *(channel_module._character_state(latest, message(seq, 'calm', 'calm'))
              for seq in range(32)),
        )
        async with db.SessionLocal() as session:
            row = await session.get(CompanionState, device_id)
            assert row.character_epoch == max(epochs)
            assert row.character_seq == 31
            assert row.character_json['current']['mood'] == 'calm'
            assert row.character_json['current']['reason'] == 'calm'
        # A lower and a duplicate sequence arriving after 31 must not replace it.
        await channel_module._character_state(latest, message(3, 'sad', 'overdue'))
        await channel_module._character_state(latest, message(31, 'sad', 'overdue'))
        async with db.SessionLocal() as session:
            row = await session.get(CompanionState, device_id)
            assert row.character_seq == 31 and row.character_json['current']['mood'] == 'calm'

        # Pause an old report immediately before it locks character state, then
        # allocate the next epoch and let the old report continue against it.
        old_waiting, resume_old = asyncio.Event(), asyncio.Event()
        original_locked_state = channel_module.locked_state
        old_task = None

        async def gated_locked_state(*args, **kwargs):
            if asyncio.current_task() is old_task:
                old_waiting.set()
                await resume_old.wait()
            return await original_locked_state(*args, **kwargs)

        monkeypatch.setattr(channel_module, 'locked_state', gated_locked_state)
        old_task = asyncio.create_task(channel_module._character_state(latest, message(32, 'sad', 'overdue')))
        try:
            await asyncio.wait_for(old_waiting.wait(), timeout=5)
            replacement = channel_module._Link(device_id, claims['sub'], reply, close, session_id=claims['sid'])
            replacement.character_epoch = await asyncio.wait_for(
                channel_module._begin_character_session(replacement), timeout=5
            )
        finally:
            resume_old.set()
            await asyncio.wait_for(old_task, timeout=5)
        assert replacement.character_epoch == 9
        async with db.SessionLocal() as session:
            row = await session.get(CompanionState, device_id)
            assert row.character_epoch == 9 and row.character_seq == -1
            assert row.character_json['current']['mood'] == 'calm'
        await channel_module._character_state(replacement, message(0, 'joy', 'task_done'))
        async with db.SessionLocal() as session:
            row = await session.get(CompanionState, device_id)
            assert row.character_seq == 0 and row.character_json['current']['mood'] == 'joy'
        assert closed == []


@pytest.mark.parametrize('preexisting', [False, True])
async def test_character_migration_preserves_existing_postgres_row(postgres, monkeypatch, preexisting):
    """The character migration upgrades and downgrades an existing PostgreSQL row."""
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    path = Path(__file__).parents[1] / 'alembic/versions/0055_companion_character.py'
    spec = importlib.util.spec_from_file_location('character_migration_postgres', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    def exercise(connection):
        public_columns_query = text("SELECT attname FROM pg_attribute WHERE attrelid = 'public.companion_state'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum")
        public_columns = list(connection.execute(public_columns_query).scalars())
        public_count = connection.execute(text('SELECT count(*) FROM public.companion_state')).scalar_one()
        extra = ', character_epoch BIGINT NOT NULL DEFAULT 0' if preexisting else ''
        connection.execute(text(f'CREATE TEMP TABLE companion_state (device_id VARCHAR PRIMARY KEY, owner_id VARCHAR NOT NULL{extra}) ON COMMIT DROP'))
        if preexisting:
            connection.execute(text("INSERT INTO companion_state VALUES ('board', 'owner', 42)"))
        else:
            connection.execute(text("INSERT INTO companion_state VALUES ('board', 'owner')"))
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(connection)))
        migration.upgrade()
        row = connection.execute(text('SELECT owner_id, character_epoch, character_seq, character_json FROM companion_state')).one()
        assert tuple(row) == ('owner', 42 if preexisting else 0, -1, None)
        migration.downgrade()
        assert connection.execute(text('SELECT owner_id FROM companion_state')).scalar_one() == 'owner'
        # PostgreSQL temporary tables live in pg_temp, not current_schema().
        temp_columns = connection.execute(text("SELECT column_name FROM information_schema.columns WHERE table_schema = (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()) AND table_name = 'companion_state'"))
        assert {row[0] for row in temp_columns} == {'device_id', 'owner_id'}
        assert list(connection.execute(public_columns_query).scalars()) == public_columns
        assert connection.execute(text('SELECT count(*) FROM public.companion_state')).scalar_one() == public_count

    async with postgres.begin() as connection:
        await connection.run_sync(exercise)


async def test_character_real_websocket_replacements_on_postgres(postgres):
    """Overlapping real sockets fence stale state and preserve the last reaction."""
    import json
    import socket

    import uvicorn
    import websockets
    from companion_helpers import companion_token
    from httpx import AsyncClient
    from websockets.exceptions import ConnectionClosed

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, lifespan='off', log_level='error'))
    server_task = asyncio.create_task(server.serve(sockets=[listener]))

    async def wait_started():
        while not server.started:
            if server_task.done():
                await server_task
                raise RuntimeError('local test server stopped before startup')
            await asyncio.sleep(0.01)

    async def receive_type(ws, expected):
        for _ in range(10):
            value = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            if value['type'] == expected:
                return value
        raise AssertionError(f'missing {expected} within ten messages')

    try:
        await asyncio.wait_for(wait_started(), timeout=10)
        async with AsyncClient(base_url=f'http://127.0.0.1:{port}') as http:
            owner, board, device_id = await pair_companion(http)
            token = await companion_token(http, board, device_id)
            uri = f'ws://127.0.0.1:{port}{B}/devices/channel'
            header = {'Authorization': f'Bearer {token}'}
            for _ in range(4):
                async with websockets.connect(uri, additional_headers=header, proxy=None) as first:
                    await receive_type(first, 'ready')
                    await receive_type(first, 'snapshot')
                    await first.send(json.dumps({'type': 'character_state', 'lost_rev': 0, 'seq': 0,
                                                 'mood': 'joy', 'reason': 'task_done'}))
                    await first.send(json.dumps({'type': 'heartbeat'}))
                    await receive_type(first, 'heartbeat_ack')
                    # Send without waiting for processing: it may race the replacement.
                    await first.send(json.dumps({'type': 'character_state', 'lost_rev': 0, 'seq': 1,
                                                 'mood': 'sad', 'reason': 'overdue'}))
                    async with websockets.connect(uri, additional_headers=header, proxy=None) as second:
                        await receive_type(second, 'ready')
                        await receive_type(second, 'snapshot')
                        with pytest.raises(ConnectionClosed) as closed:
                            await asyncio.wait_for(first.recv(), timeout=5)
                        assert closed.value.rcvd.code == 4000
                        url = f'{B}/companion/devices/{device_id}'
                        assert (await http.get(url, headers=bearer(owner))).json()['character'] is None
                        await second.send(json.dumps({'type': 'character_state', 'lost_rev': 0, 'seq': 0,
                                                      'mood': 'calm', 'reason': 'calm'}))
                        await second.send(json.dumps({'type': 'heartbeat'}))
                        await receive_type(second, 'heartbeat_ack')
                        character = (await http.get(url, headers=bearer(owner))).json()['character']
                        assert character['current']['reason'] == 'calm'
                        assert character['recent']['reason'] == 'task_done'
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, timeout=10)
        finally:
            listener.close()
