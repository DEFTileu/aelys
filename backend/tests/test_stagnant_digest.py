"""Stagnant tasks extend the digest only, using elapsed UTC instants."""
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from app.core.db import Base
from app.core.models import Task, User
from app.domains.briefings import build_agenda, build_digest, format_agenda
from app.domains.recurrence import utc
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

AT = datetime(2026, 11, 8, 17, tzinfo=UTC)


@pytest.fixture
async def sessions(tmp_path: Path) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/stagnant.db')
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as db:
            db.add_all([User(id='owner'), User(id='other')])
            await db.commit()
        yield factory
    finally:
        await engine.dispose()


async def test_stagnant_strict_seven_day_boundary_and_active_owner_only(sessions: async_sessionmaker[AsyncSession]) -> None:
    cutoff = AT - timedelta(days=7)
    async with sessions() as db:
        db.add_all([
            Task(id='old', owner_id='owner', title='Old active task', status='in_progress', started_at=cutoff - timedelta(milliseconds=1)),
            Task(id='boundary', owner_id='owner', title='Exactly seven days', status='in_progress', started_at=cutoff),
            Task(id='recent', owner_id='owner', title='Less than seven days', status='in_progress', started_at=cutoff + timedelta(milliseconds=1)),
            Task(id='no-start', owner_id='owner', title='Missing start', status='in_progress'),
            Task(id='todo', owner_id='owner', title='Not in progress', status='todo', started_at=cutoff - timedelta(days=1)),
            Task(id='completed', owner_id='owner', title='Completed task', status='completed', started_at=cutoff - timedelta(days=1)),
            Task(id='deleted', owner_id='owner', title='Deleted task', status='in_progress', started_at=cutoff - timedelta(days=1), deleted_at=AT),
            Task(id='foreign', owner_id='other', title='Foreign secret task', status='in_progress', started_at=cutoff - timedelta(days=1)),
        ])
        await db.commit()
        today = format_agenda(await build_agenda(db, 'owner', ZoneInfo('UTC'), AT))
        digest = await build_digest(db, 'owner', ZoneInfo('UTC'), AT)
        assert 'Застывшие задачи' in digest and 'Old active task' in digest
        assert all(title not in digest for title in ['Exactly seven days', 'Less than seven days', 'Missing start', 'Not in progress', 'Completed task', 'Deleted task', 'Foreign secret task'])
        assert 'Old active task' not in today and 'Застывшие' not in today
        assert today == format_agenda(await build_agenda(db, 'owner', ZoneInfo('UTC'), AT))


@pytest.mark.parametrize('at,started,expected', [
    # A wall-clock week across autumn is 169 hours, across spring 167 hours.
    (datetime(2026, 11, 4, 12, tzinfo=ZoneInfo('America/New_York')), datetime(2026, 10, 28, 12, tzinfo=ZoneInfo('America/New_York')), True),
    (datetime(2026, 3, 11, 12, tzinfo=ZoneInfo('America/New_York')), datetime(2026, 3, 4, 12, tzinfo=ZoneInfo('America/New_York')), False),
])
async def test_stagnant_uses_elapsed_time_across_dst_not_calendar_days(
    sessions: async_sessionmaker[AsyncSession], at: datetime, started: datetime, expected: bool,
) -> None:
    async with sessions() as db:
        db.add(Task(owner_id='owner', title='DST task', status='in_progress', started_at=utc(started)))
        await db.commit()
        digest = await build_digest(db, 'owner', ZoneInfo('America/New_York'), at)
        assert ('DST task' in digest) is expected
        same_instant = await build_digest(db, 'owner', ZoneInfo('America/New_York'), utc(at))
        assert same_instant == digest


@pytest.mark.parametrize('status', ['IN_PROGRESS', ' in_progress ', ' IN_PROGRESS '])
async def test_stagnant_includes_accepted_status_variants(
    sessions: async_sessionmaker[AsyncSession], status: str,
) -> None:
    async with sessions() as db:
        db.add(Task(owner_id='owner', title='Eight-day accepted status', status=status,
            started_at=AT - timedelta(days=8)))
        await db.commit()
        digest = await build_digest(db, 'owner', ZoneInfo('UTC'), AT)
        assert 'Eight-day accepted status' in digest.split('Застывшие задачи:')[1]


async def test_empty_stagnant_section_and_bounded_titles_do_not_overflow_digest(sessions: async_sessionmaker[AsyncSession]) -> None:
    async with sessions() as db:
        empty = await build_digest(db, 'owner', ZoneInfo('Asia/Almaty'), AT)
        assert 'Застывшие задачи:\nНет' in empty
        db.add_all([Task(id=f'old-{index:02}', owner_id='owner', title=f'Old {index:02} ' + 'x' * 300,
            status='in_progress', started_at=AT - timedelta(days=8)) for index in range(25)])
        await db.commit()
        digest = await build_digest(db, 'owner', ZoneInfo('Asia/Almaty'), AT)
        assert len(digest) <= 4096 and 'Застывшие задачи' in digest
        assert sum(f'Old {index:02}' in digest for index in range(25)) == 20
        assert 'x' * 121 not in digest
        assert 'Полный список в Aelys' in digest


async def test_busy_agenda_reserves_room_for_stagnant_tasks(sessions: async_sessionmaker[AsyncSession]) -> None:
    async with sessions() as db:
        db.add_all([Task(owner_id='owner', title=f'Due {index} ' + 'x' * 290,
            due_at=AT) for index in range(40)])
        db.add(Task(owner_id='owner', title='Stagnant remains visible', status='in_progress',
            started_at=AT - timedelta(days=8)))
        await db.commit()
        digest = await build_digest(db, 'owner', ZoneInfo('UTC'), AT)
        assert len(digest) <= 4096
        assert 'Завтра:' in digest and 'Застывшие задачи:' in digest
        assert 'Stagnant remains visible' in digest and 'Полный список в Aelys' in digest
