import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
import pytest_asyncio
from app.companion import hub as hub_module
from app.companion.hub import CompanionHub, hub, install_change_listeners
from app.core import db
from app.core.models import FocusSession, Notification, Task, TaskReminder
from app.domains import task_service
from app.integrations.telegram_reminders import _notification
from app.main import app
from companion_helpers import B, bearer, claim_owner
from httpx import ASGITransport, AsyncClient
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


# --- real write paths: Core statements bypass mapper events, each must still push exactly one snapshot ---

@pytest_asyncio.fixture
async def client_owner(setup):
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        _, session = await claim_owner(client)
        headers = bearer(session)
        owner_id = (await client.get(f'{B}/me', headers=headers)).json()['id']
        yield client, owner_id, headers


class Board:
    """A connected board for the real owner; `settle` returns snapshots pushed since the last call."""
    def __init__(self, owner_id):
        self.sent = []

        async def send(message):
            self.sent.append(message)
        self.unregister = hub.register('dev-real', owner_id, send)

    async def settle(self):
        await hub.wait_idle()
        got, self.sent = self.sent, []
        return got


@pytest_asyncio.fixture
async def board(client_owner):
    _, owner_id, _ = client_owner
    board = Board(owner_id)
    yield board
    board.unregister()


async def new_task(client, headers, board, **extra):
    body = {'title': 'T', 'due_at': (datetime.now(UTC) + timedelta(hours=2)).isoformat(), **extra}
    task = (await client.post(f'{B}/tasks', json=body, headers=headers)).json()
    await board.settle()
    return task


@pytest.mark.asyncio
async def test_task_patch_route_pushes_one_snapshot(client_owner, board):
    client, _, headers = client_owner
    task = await new_task(client, headers, board)
    body = {'title': 'Renamed', 'due_at': task['due_at'], 'version': task['version']}
    assert (await client.patch(f"{B}/tasks/{task['id']}", json=body, headers=headers)).status_code == 200
    got = await board.settle()
    assert len(got) == 1 and got[0]['snapshot']['next_task']['title'] == 'Renamed'


@pytest.mark.asyncio
async def test_complete_task_service_pushes_one_snapshot(client_owner, board):
    client, owner_id, headers = client_owner
    task = await new_task(client, headers, board)
    async with db.SessionLocal() as session:
        await task_service.complete_task(session, owner_id, task['id'])
        await session.commit()
    got = await board.settle()
    assert len(got) == 1 and got[0]['snapshot']['next_task'] is None


@pytest.mark.asyncio
async def test_event_update_and_delete_routes_push_one_snapshot_each(client_owner, board):
    client, _, headers = client_owner
    start = datetime.now(UTC) + timedelta(hours=3)
    body = {'title': 'Standup', 'starts_at': start.isoformat(), 'ends_at': (start + timedelta(minutes=15)).isoformat()}
    event = (await client.post(f'{B}/calendar/events', json=body, headers=headers)).json()
    await board.settle()
    assert (await client.patch(f"{B}/calendar/events/{event['id']}", json={**body, 'title': 'Renamed', 'version': event['version']}, headers=headers)).status_code == 200
    got = await board.settle()
    assert len(got) == 1 and got[0]['snapshot']['next_event']['title'] == 'Renamed'
    assert (await client.delete(f"{B}/calendar/events/{event['id']}", params={'version': event['version'] + 1}, headers=headers)).status_code == 200
    got = await board.settle()
    assert len(got) == 1 and got[0]['snapshot']['next_event'] is None


@pytest.mark.asyncio
async def test_focus_pause_resume_stop_routes_push_one_snapshot_each(client_owner, board):
    client, _, headers = client_owner
    focus = (await client.post(f'{B}/focus/sessions', json={'started_at': datetime.now(UTC).isoformat()}, headers=headers)).json()
    assert len(await board.settle()) == 1
    for action, status in (('pause', 'paused'), ('resume', 'active'), ('stop', None)):
        assert (await client.post(f"{B}/focus/sessions/{focus['id']}/{action}", headers=headers)).status_code == 200
        got = await board.settle()
        assert len(got) == 1, action
        assert (got[0]['snapshot']['focus'] or {}).get('status') == status, action


@pytest.mark.asyncio
async def test_telegram_reminder_notification_insert_pushes_one_snapshot(client_owner, board):
    _, owner_id, _ = client_owner
    async with db.SessionLocal() as session:
        reminder = TaskReminder(id='r1')
        assert await _notification(session, SimpleNamespace(owner_id=owner_id), reminder, 't1', datetime.now(UTC))
        await session.commit()
    assert len(await board.settle()) == 1


@pytest.mark.asyncio
async def test_sends_to_one_socket_never_overlap_and_stay_ordered(setup):
    local, order, running = CompanionHub(), [], 0

    async def send(message):
        nonlocal running
        running += 1
        assert running == 1
        await asyncio.sleep(0.01)
        order.append(message['n'])
        running -= 1
    local.register('d', 'o', send)
    await asyncio.gather(*(local.send_to_device('d', {'n': n}) for n in range(5)))
    assert order == [0, 1, 2, 3, 4]


@pytest.mark.asyncio
async def test_failed_send_unregisters_and_closes_with_1011():
    local, closed = CompanionHub(), []

    async def broken(message):
        raise RuntimeError('gone')

    async def close(code):
        closed.append(code)
    local.register('d', 'o', broken, close)
    assert await local.send_to_device('d', {'type': 'x'}) is False
    assert closed == [1011] and not local.is_online('d')


@pytest.mark.asyncio
async def test_cancelled_flush_clears_pending(setup):
    hub.debounce = 5
    async with db.SessionLocal() as session:
        session.add(task())
        await session.commit()
    pending = list(hub._pending.values())
    assert len(pending) == 1
    pending[0].cancel()
    await hub.wait_idle()
    assert hub._pending == {}


@pytest.mark.asyncio
async def test_slow_older_build_is_sent_before_newer_snapshot(setup, monkeypatch):
    from app.companion import snapshot as snapshot_module
    real, started, release, calls = snapshot_module.build_snapshot, asyncio.Event(), asyncio.Event(), 0

    async def slow_first(session, owner_id, now):
        nonlocal calls
        calls += 1
        built = await real(session, owner_id, now)
        if calls == 1:
            started.set()
            await release.wait()  # flush A: built from older data, still in flight
        return built
    monkeypatch.setattr(snapshot_module, 'build_snapshot', slow_first)

    async def notify():
        async with db.SessionLocal() as session:
            session.add(Notification(owner_id=OWNER, kind='task.reminder', title='n'))
            await session.commit()
    await notify()
    await started.wait()
    await notify()  # schedules flush B while A's build is blocked
    while OWNER in hub._pending:
        await asyncio.sleep(0)  # B's debounce is over: without the owner lock it would now build and send first
    for _ in range(50):
        await asyncio.sleep(0.001)
    release.set()
    await hub.wait_idle()
    assert [m['snapshot']['unread_count'] for m in setup] == [1, 2]


@pytest.mark.asyncio
async def test_wait_idle_with_timeout_cancels_leftover_tasks(setup, monkeypatch):
    monkeypatch.setattr(hub, 'debounce', 60)
    hub.mark_owner_dirty(OWNER)
    assert hub._background
    await asyncio.wait_for(hub.wait_idle(timeout=0.05), 2)
    assert not hub._background and not hub._pending
    assert setup == []
