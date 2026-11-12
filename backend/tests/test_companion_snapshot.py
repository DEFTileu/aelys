from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from app.companion.snapshot import ALLOWED_NOTICE_PREFIXES, build_snapshot
from app.core import db
from app.core.models import CalendarEvent, FocusSession, Notification, Task
from app.main import app
from companion_helpers import B, bearer, claim_owner, companion_token, pair_companion
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

NOW = datetime(2026, 11, 13, 9, 30, tzinfo=UTC)


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/snapshot.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http
    await engine.dispose()


async def owner_id_of(client, session):
    return (await client.get(f'{B}/me', headers=bearer(session))).json()['id']


@pytest_asyncio.fixture
async def owner(client):
    _, session = await claim_owner(client)
    return await owner_id_of(client, session)


async def snapshot(owner_id, rows=()):
    async with db.SessionLocal() as session:
        session.add_all(rows)
        await session.commit()
        return await build_snapshot(session, owner_id, NOW)


@pytest.mark.asyncio
async def test_next_task_is_earliest_open_due_after_now(owner):
    def task(title, due, status='todo'):
        return Task(owner_id=owner, title=title, due_at=NOW + timedelta(hours=due), status=status)
    later, soon = task('later', 5), task('soon', 2)
    snap = await snapshot(owner, [later, soon, task('done', 1, 'done'), task('cancelled', 1, 'cancelled'), task('late', -3), task('late 2', -1)])
    assert snap.next_task and snap.next_task.id == soon.id and snap.next_task.title == 'soon'
    assert snap.overdue_count == 2
    assert (await snapshot(owner)).next_task.id == soon.id


@pytest.mark.asyncio
async def test_next_event_includes_recurring_and_ongoing(owner):
    def event(title, start, minutes, rrule=None):
        return CalendarEvent(owner_id=owner, title=title, starts_at=start, ends_at=start + timedelta(minutes=minutes), rrule=rrule)
    ongoing = event('ongoing', NOW - timedelta(minutes=10), 60)
    snap = await snapshot(owner, [ongoing, event('tomorrow', NOW + timedelta(days=1), 30), event('beyond window', NOW + timedelta(days=9), 30)])
    assert snap.next_event.id == ongoing.id and snap.next_event.ends_at == NOW + timedelta(minutes=50) and not snap.next_event.all_day

    async with db.SessionLocal() as session:
        await session.delete(await session.get(CalendarEvent, ongoing.id))
        await session.commit()
    daily = event('daily', NOW - timedelta(days=20, hours=1), 15, 'FREQ=DAILY')  # next occurrence: today 09:30 is over -> tomorrow
    snap = await snapshot(owner, [daily])
    assert snap.next_event.id == daily.id
    assert snap.next_event.starts_at == NOW + timedelta(days=1) - timedelta(hours=1)  # series time of day, in the window


@pytest.mark.asyncio
async def test_unread_counts_all_kinds_but_titles_only_allowed(owner):
    kinds = {'task.reminder': 'TASK-T', 'calendar.reminder': 'CAL-T', 'telegram.digest': 'SECRET-TG', 'automation': 'SECRET-AUTO', 'info': 'SECRET-INFO'}
    rows = [Notification(owner_id=owner, kind=kind, title=title, body='SECRET-BODY', data_json={'k': 'SECRET-DATA'}, created_at=NOW - timedelta(minutes=index)) for index, (kind, title) in enumerate(kinds.items())]
    rows.append(Notification(owner_id=owner, kind='task.reminder', title='already read', read_at=NOW))
    snap = await snapshot(owner, rows)
    assert snap.unread_count == 5
    assert [n.kind for n in snap.notices] == ['task.reminder', 'calendar.reminder']  # newest first
    assert all(n.kind.startswith(ALLOWED_NOTICE_PREFIXES) for n in snap.notices)
    raw = snap.model_dump_json()
    for secret in ('SECRET', 'body', 'data_json'):
        assert secret not in raw


@pytest.mark.asyncio
async def test_notices_capped_at_five(owner):
    rows = [Notification(owner_id=owner, kind='focus.done', title=f'n{i}', created_at=NOW - timedelta(minutes=i)) for i in range(7)]
    snap = await snapshot(owner, rows)
    assert [n.title for n in snap.notices] == ['n0', 'n1', 'n2', 'n3', 'n4'] and snap.unread_count == 7


@pytest.mark.asyncio
async def test_focus_active_or_paused_only(owner):
    assert (await snapshot(owner, [FocusSession(owner_id=owner, started_at=NOW - timedelta(hours=1), status='completed')])).focus is None
    active = FocusSession(owner_id=owner, started_at=NOW - timedelta(minutes=20), status='active', mode='pomodoro', paused_seconds=60)
    focus = (await snapshot(owner, [active])).focus
    assert (focus.id, focus.status, focus.mode, focus.elapsed_seconds) == (active.id, 'active', 'pomodoro', 1140)
    async with db.SessionLocal() as session:
        row = await session.get(FocusSession, active.id)
        row.status, row.paused_at = 'paused', NOW - timedelta(minutes=5)
        await session.commit()
    focus = (await snapshot(owner)).focus
    assert (focus.status, focus.elapsed_seconds) == ('paused', 840)


@pytest.mark.asyncio
async def test_snapshot_is_per_owner(client, owner):
    other = await claim_owner_user(client)
    assert (await snapshot(other, [Task(owner_id=owner, title='mine', due_at=NOW + timedelta(hours=1))])).next_task is None


async def claim_owner_user(client):
    async with db.SessionLocal() as session:
        from app.core.models import User
        user = User(email='other@test.example')
        session.add(user)
        await session.commit()
        return user.id


@pytest.mark.asyncio
async def test_snapshot_route_companion_only(client):
    owner_session, key, device_id = await pair_companion(client)
    # The owner's macOS device is not a companion.
    denied = await client.get(f'{B}/companion/snapshot', headers=bearer(owner_session))
    assert denied.status_code == 403 and denied.json()['detail']['code'] == 'COMPANION_ONLY'
    token = await companion_token(client, key, device_id)
    ok = await client.get(f'{B}/companion/snapshot', headers={'Authorization': f'Bearer {token}'})
    assert ok.status_code == 200, ok.text
    assert set(ok.json()) == {'generated_at', 'next_task', 'overdue_count', 'next_event', 'unread_count', 'notices', 'focus'}


@pytest.mark.asyncio
async def test_notice_filter_is_case_and_prefix_exact(owner):
    kinds = ['Task.x', 'TASK.y', 'taskx', ' task.z', 'task_x', 'Calendar.a', 'FOCUS.b']
    rows = [Notification(owner_id=owner, kind=kind, title=f'LEAK-{index}', created_at=NOW - timedelta(minutes=index)) for index, kind in enumerate(kinds)]
    snap = await snapshot(owner, rows)
    assert snap.unread_count == len(kinds) and snap.notices == []
    assert 'LEAK' not in snap.model_dump_json()


@pytest.mark.asyncio
async def test_broken_calendar_degrades_to_no_event_with_a_warning(owner, caplog):
    start = NOW + timedelta(hours=1)
    bad_rule = CalendarEvent(owner_id=owner, title='TITLE-LEAK', starts_at=start, ends_at=start + timedelta(hours=1), rrule='FREQ=NOPE')
    with caplog.at_level('WARNING', logger='app.companion.snapshot'):
        snap = await snapshot(owner, [bad_rule])
    assert snap.next_event is None and f'owner={owner}' in caplog.text and 'TITLE-LEAK' not in caplog.text
    caplog.clear()
    async with db.SessionLocal() as session:
        await session.delete(await session.get(CalendarEvent, bad_rule.id))
        await session.commit()
    bad_zone = CalendarEvent(owner_id=owner, title='TITLE-LEAK', starts_at=start, ends_at=start + timedelta(hours=1), rrule='FREQ=DAILY', timezone='Nowhere/Land')
    with caplog.at_level('WARNING', logger='app.companion.snapshot'):
        snap = await snapshot(owner, [bad_zone])
    assert snap.next_event is None and f'owner={owner}' in caplog.text and 'TITLE-LEAK' not in caplog.text


@pytest.mark.asyncio
async def test_oversized_calendar_degrades_with_a_warning(owner, caplog):
    start = NOW + timedelta(hours=1)
    rows = [CalendarEvent(owner_id=owner, title='e', starts_at=start, ends_at=start + timedelta(hours=1)) for _ in range(10001)]
    with caplog.at_level('WARNING', logger='app.companion.snapshot'):
        snap = await snapshot(owner, rows)
    assert snap.next_event is None and 'too large' in caplog.text


@pytest.mark.asyncio
async def test_timed_event_beats_all_day_and_all_day_is_a_fallback(owner):
    midnight = NOW.replace(hour=0, minute=0)
    holiday = CalendarEvent(owner_id=owner, title='Holiday', starts_at=midnight, ends_at=midnight + timedelta(days=1), all_day=True)
    standup = CalendarEvent(owner_id=owner, title='Standup', starts_at=NOW + timedelta(minutes=30), ends_at=NOW + timedelta(minutes=45))
    assert (await snapshot(owner, [holiday, standup])).next_event.id == standup.id
    async with db.SessionLocal() as session:
        await session.delete(await session.get(CalendarEvent, standup.id))
        await session.commit()
    only = (await snapshot(owner)).next_event
    assert (only.id, only.all_day, only.starts_at, only.ends_at) == (holiday.id, True, midnight, midnight + timedelta(days=1))


@pytest.mark.asyncio
async def test_deleted_rows_are_excluded(owner):
    gone = NOW - timedelta(minutes=1)
    rows = [
        Task(owner_id=owner, title='deleted task', due_at=NOW + timedelta(hours=1), deleted_at=gone),
        Task(owner_id=owner, title='deleted overdue', due_at=NOW - timedelta(hours=1), deleted_at=gone),
        CalendarEvent(owner_id=owner, title='deleted event', starts_at=NOW + timedelta(hours=1), ends_at=NOW + timedelta(hours=2), deleted_at=gone),
        Notification(owner_id=owner, kind='task.reminder', title='deleted notice', deleted_at=gone),
        FocusSession(owner_id=owner, started_at=NOW - timedelta(minutes=5), status='active', deleted_at=gone),
    ]
    snap = await snapshot(owner, rows)
    assert (snap.next_task, snap.overdue_count, snap.next_event, snap.unread_count, snap.notices, snap.focus) == (None, 0, None, 0, [], None)


@pytest.mark.asyncio
async def test_other_owners_rows_never_appear(client, owner):
    other = await claim_owner_user(client)
    soon = NOW + timedelta(hours=1)
    foreign = [
        Task(owner_id=other, title='their task', due_at=soon), Task(owner_id=other, title='their late task', due_at=NOW - timedelta(hours=1)),
        CalendarEvent(owner_id=other, title='their event', starts_at=soon, ends_at=soon + timedelta(hours=1)),
        Notification(owner_id=other, kind='task.reminder', title='their notice'),
        FocusSession(owner_id=other, started_at=NOW - timedelta(minutes=5), status='active'),
    ]
    snap = await snapshot(owner, foreign)
    assert (snap.next_task, snap.overdue_count, snap.next_event, snap.unread_count, snap.notices, snap.focus) == (None, 0, None, 0, [], None)
