"""App hint stream: owner-scoped "which collections changed" hints, never content."""
import asyncio
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from app.companion import changes
from app.companion.hub import hub, install_change_listeners
from app.core import db
from app.core.models import FocusSession, Task
from app.main import app
from companion_helpers import B, bearer, claim_owner, companion_token, pair_companion
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest_asyncio.fixture
async def database(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/changes.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    install_change_listeners()
    yield
    await hub.wait_idle()
    await engine.dispose()


@pytest_asyncio.fixture
async def client(database):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http


async def commit(*items):
    async with db.SessionLocal() as session:
        session.add_all(items)
        await session.commit()


@pytest.mark.asyncio
async def test_hints_reach_only_their_owner(database):
    mine, unsubscribe_mine = hub.subscribe_hints('owner-1')
    theirs, unsubscribe_theirs = hub.subscribe_hints('owner-2')
    try:
        await commit(Task(owner_id='owner-1', title='secret title'), FocusSession(owner_id='owner-1', started_at=datetime.now(UTC)))
        assert mine.wake.is_set() and mine.take() == {'tasks', 'focus'}
        assert not mine.wake.is_set()
        assert not theirs.wake.is_set() and theirs.take() == set()
    finally:
        unsubscribe_mine(); unsubscribe_theirs()
    assert 'owner-1' not in hub._hint_subscribers


@pytest.mark.asyncio
async def test_rolled_back_write_hints_nothing(database):
    subscriber, unsubscribe = hub.subscribe_hints('owner-1')
    try:
        async with db.SessionLocal() as session:
            session.add(Task(owner_id='owner-1', title='t'))
            await session.flush()
            await session.rollback()
        assert not subscriber.wake.is_set()
    finally:
        unsubscribe()


async def read_stream(client, headers, during):
    """Open the stream, run `during` once it is subscribed, and return the whole body after the stream ends."""
    before = sum(len(s) for s in hub._hint_subscribers.values())
    request = asyncio.create_task(client.get(f'{B}/changes', headers=headers))
    for _ in range(200):
        if sum(len(s) for s in hub._hint_subscribers.values()) > before:
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError('stream never subscribed')
    await during()
    response = await request
    assert response.status_code == 200, response.text
    assert response.headers['content-type'].startswith('text/event-stream')
    return response.text


@pytest.mark.asyncio
async def test_focus_started_through_api_streams_a_focus_hint_and_no_other_owner_data(client, monkeypatch):
    monkeypatch.setattr(changes, 'MAX_STREAM_SECONDS', 0.5)
    _, session = await claim_owner(client)
    headers = bearer(session)

    async def during():
        await commit(Task(owner_id='someone-else', title='other owner'))  # another owner's write must not surface
        started = await client.post(f'{B}/focus/sessions', json={'started_at': datetime.now(UTC).isoformat()}, headers=headers)
        assert started.status_code == 200, started.text

    body = await read_stream(client, headers, during)
    assert body.startswith(': ready')
    assert body.count('event: changes.hint') == 1
    assert 'data: {"collections": ["focus"]}' in body
    assert 'other owner' not in body and 'tasks' not in body


@pytest.mark.asyncio
async def test_focus_pause_core_update_streams_a_focus_hint(client, monkeypatch):
    monkeypatch.setattr(changes, 'MAX_STREAM_SECONDS', 0.5)
    _, session = await claim_owner(client)
    headers = bearer(session)
    focus = (await client.post(f'{B}/focus/sessions', json={'started_at': datetime.now(UTC).isoformat()}, headers=headers)).json()

    async def during():
        assert (await client.post(f"{B}/focus/sessions/{focus['id']}/pause", headers=headers)).status_code == 200

    assert 'data: {"collections": ["focus"]}' in await read_stream(client, headers, during)


@pytest.mark.asyncio
async def test_stream_requires_an_app_session(client):
    assert (await client.get(f'{B}/changes')).status_code == 401
    _, key, device_id = await pair_companion(client)
    board = {'Authorization': f'Bearer {await companion_token(client, key, device_id)}'}
    assert (await client.get(f'{B}/changes', headers=board)).status_code == 403  # a board is not on its allow-list
