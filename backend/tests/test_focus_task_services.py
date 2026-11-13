from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from app.core import db
from app.core.models import FocusSession, SyncChange, Task, User
from app.domains import focus_service, task_service
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest_asyncio.fixture
async def session(tmp_path):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/services.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        s.add_all([User(id='owner'), User(id='other')])
        await s.commit()
        yield s
    await engine.dispose()


async def start(session, **kw):
    item = await focus_service.start_focus(session, 'owner', started_at=datetime.now(UTC), mode='pomodoro', task_id=None, idempotency_key=None, **kw)
    await session.commit()
    return item


async def test_start_twice_is_timer_active(session):
    first = await start(session)
    assert (await focus_service.active_focus(session, 'owner')).id == first.id
    with pytest.raises(HTTPException) as caught:
        await start(session)
    assert caught.value.status_code == 409 and caught.value.detail['code'] == 'TIMER_ACTIVE'
    assert await focus_service.active_focus(session, 'other') is None


async def test_start_with_same_key_replays_and_other_request_conflicts(session):
    at = datetime.now(UTC)
    args = {'started_at': at, 'mode': 'pomodoro', 'task_id': None, 'idempotency_key': 'k'}
    first = await focus_service.start_focus(session, 'owner', **args)
    await session.commit()
    assert (await focus_service.start_focus(session, 'owner', **args)).id == first.id
    with pytest.raises(HTTPException) as caught:
        await focus_service.start_focus(session, 'owner', **{**args, 'mode': 'stopwatch'})
    assert caught.value.detail['code'] == 'IDEMPOTENCY_CONFLICT'


async def test_pause_resume_stop_elapsed_matches_focus_elapsed(session):
    item = await start(session)
    item.started_at = datetime.now(UTC) - timedelta(seconds=100)
    await session.commit()
    paused = await focus_service.set_focus_paused(session, 'owner', item.id, True, None)
    assert paused.status == 'paused' and paused.version == 2
    assert (await focus_service.set_focus_paused(session, 'owner', item.id, True, None)).version == 2, 'repeat is a no-op'
    paused.paused_at = datetime.now(UTC) - timedelta(seconds=30)
    await session.commit()
    resumed = await focus_service.set_focus_paused(session, 'owner', item.id, False, 2)
    assert resumed.status == 'active' and 29 <= resumed.paused_seconds <= 31
    stopped = await focus_service.stop_focus(session, 'owner', item.id, None)
    await session.commit()
    assert stopped.status == 'completed'
    assert stopped.elapsed_seconds == focus_service.focus_elapsed(stopped.started_at.replace(tzinfo=UTC), stopped.paused_seconds, stopped.ended_at.replace(tzinfo=UTC))
    assert 68 <= stopped.elapsed_seconds <= 72
    assert (await focus_service.stop_focus(session, 'owner', item.id, None)).version == stopped.version, 'stopping twice is a no-op'


async def test_stop_rejects_stale_version_and_other_owner(session):
    item = await start(session)
    with pytest.raises(HTTPException) as caught:
        await focus_service.stop_focus(session, 'owner', item.id, 9)
    assert caught.value.detail['code'] == 'VERSION_CONFLICT'
    with pytest.raises(HTTPException) as caught:
        await focus_service.stop_focus(session, 'other', item.id, None)
    assert caught.value.status_code == 404
    assert (await session.get(FocusSession, item.id)).status == 'active'


async def test_complete_task_sets_completed_at_logs_once_and_second_call_is_noop(session):
    session.add(Task(id='t1', owner_id='owner', title='Ship'))
    await session.commit()
    item = await task_service.complete_task(session, 'owner', 't1')
    await session.commit()
    assert item.status == 'completed' and item.completed_at is not None and item.version == 2
    count = select(func.count()).select_from(SyncChange).where(SyncChange.resource_id == 't1')
    assert await session.scalar(count) == 1
    again = await task_service.complete_task(session, 'owner', 't1')
    await session.commit()
    assert again.version == 2 and await session.scalar(count) == 1


async def test_complete_task_checks_version_and_owner(session):
    session.add(Task(id='t1', owner_id='owner', title='Ship'))
    await session.commit()
    with pytest.raises(HTTPException) as caught:
        await task_service.complete_task(session, 'owner', 't1', 7)
    assert caught.value.detail['code'] == 'VERSION_CONFLICT'
    with pytest.raises(HTTPException) as caught:
        await task_service.complete_task(session, 'other', 't1')
    assert caught.value.status_code == 404
