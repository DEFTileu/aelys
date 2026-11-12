from datetime import UTC, datetime

import pytest
import pytest_asyncio
from app.companion import hub as hub_module
from app.companion.hub import CompanionHub, hub, install_change_listeners
from app.core import db
from app.core.models import FocusSession, Notification, Task
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

OWNER = 'owner-1'


@pytest_asyncio.fixture
async def setup(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/hub.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    monkeypatch.setattr(hub, 'debounce', 0.01)
    install_change_listeners()
    install_change_listeners()  # idempotent
    sent, unregister = [], []

    async def send(message):
        sent.append(message)
    unregister.append(hub.register('dev-1', OWNER, send))
    yield sent
    unregister[0]()
    await hub.wait_idle()
    await engine.dispose()


def task(title='t'):
    return Task(owner_id=OWNER, title=title, due_at=datetime(2030, 1, 1, tzinfo=UTC))


@pytest.mark.asyncio
async def test_commit_of_task_marks_owner_dirty_once(setup):
    async with db.SessionLocal() as session:
        session.add(task('a'))
        await session.flush()
        session.add(task('b'))
        await session.commit()
    await hub.wait_idle()
    assert len(setup) == 1
    assert setup[0]['type'] == 'snapshot' and setup[0]['snapshot']['next_task']['title'] in {'a', 'b'}


@pytest.mark.asyncio
async def test_commits_inside_debounce_window_share_one_rebuild(setup, monkeypatch):
    monkeypatch.setattr(hub, 'debounce', 0.2)
    for title in 'abc':
        async with db.SessionLocal() as session:
            session.add(task(title))
            await session.commit()
    await hub.wait_idle()
    assert len(setup) == 1


@pytest.mark.asyncio
async def test_rollback_marks_nothing(setup):
    async with db.SessionLocal() as session:
        session.add(task())
        await session.flush()
        await session.rollback()
    await hub.wait_idle()
    assert setup == []


@pytest.mark.asyncio
async def test_notification_insert_triggers_rebuild(setup):
    async with db.SessionLocal() as session:
        session.add(Notification(owner_id=OWNER, kind='task.reminder', title='Soon'))
        await session.commit()
    await hub.wait_idle()
    assert setup[0]['snapshot']['unread_count'] == 1


@pytest.mark.asyncio
async def test_focus_update_triggers_rebuild(setup):
    async with db.SessionLocal() as session:
        focus = FocusSession(owner_id=OWNER, mode='pomodoro', status='active', started_at=datetime.now(UTC))
        session.add(focus)
        await session.commit()
        await hub.wait_idle()
        focus.status = 'paused'
        await session.commit()
    await hub.wait_idle()
    assert len(setup) == 2


@pytest.mark.asyncio
async def test_other_owner_is_not_notified(setup):
    async with db.SessionLocal() as session:
        session.add(Notification(owner_id='someone-else', kind='task.x', title='x'))
        await session.commit()
    await hub.wait_idle()
    assert setup == []


@pytest.mark.asyncio
async def test_failing_socket_is_dropped_and_others_still_get_snapshot(setup):
    async def broken(message):
        raise RuntimeError('closed')
    hub.register('dev-broken', OWNER, broken)
    async with db.SessionLocal() as session:
        session.add(task())
        await session.commit()
    await hub.wait_idle()
    assert len(setup) == 1 and not hub.is_online('dev-broken') and hub.is_online('dev-1')


@pytest.mark.asyncio
async def test_second_register_closes_first_with_4000():
    local, closed = CompanionHub(), []

    async def noop(message):
        pass

    async def close_first(code):
        closed.append(('first', code))

    async def close_second(code):
        closed.append(('second', code))
    unregister_first = local.register('d', 'o', noop, close_first)
    local.register('d', 'o', noop, close_second)
    await local.wait_idle()
    assert closed == [('first', 4000)]
    unregister_first()  # a stale unregister must not evict the new connection
    assert local.is_online('d')


@pytest.mark.asyncio
async def test_send_to_offline_device_returns_false():
    local = CompanionHub()
    assert await local.send_to_device('nobody', {'type': 'x'}) is False
    sent = []

    async def send(message):
        sent.append(message)
    local.register('d', 'o', send)
    assert await local.send_to_device('d', {'type': 'x'}) is True and sent == [{'type': 'x'}]
    await local.close_device('d', 1000)
    assert not local.is_online('d')


def test_install_is_guarded():
    install_change_listeners()
    assert hub_module._installed is True
