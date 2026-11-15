from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from app.core.models import EnglishLesson, Task, User
from app.focus.unlock_state import day_unlocked
from sqlalchemy import select
from test_automation_api import _owner, automation_client  # noqa: F401

NOON = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
DAY = NOON.date()


async def _owner_id(factory) -> str:
    async with factory() as db:
        return (await db.execute(select(User.id))).scalar_one()


async def _add(factory, *rows) -> None:
    async with factory() as db:
        db.add_all(rows)
        await db.commit()


def _lesson(owner_id: str, done: dict[str, bool], blocks=("a", "b")) -> EnglishLesson:
    return EnglishLesson(
        owner_id=owner_id, day=DAY, lesson_no=1, week=1, theme="t",
        content_json={"blocks": [{"key": k, "title": k, "minutes": 5} for k in blocks]},
        progress_json={k: {"done": v} for k, v in done.items()},
    )


def _task(owner_id: str, status="todo", due: datetime | None = NOON, tz: str | None = None, **kw) -> Task:
    return Task(owner_id=owner_id, title="t", status=status, due_at=due, due_timezone=tz, **kw)


async def _unlocked(factory, owner_id: str, day: date = DAY) -> bool:
    async with factory() as db:
        return await day_unlocked(db, owner_id, day)


async def test_no_tasks_and_no_lesson_is_not_unlocked(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    assert not await _unlocked(factory, await _owner_id(factory))


async def test_all_lesson_blocks_done_unlocks(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    await _add(factory, _lesson(owner, {"a": True, "b": True}))
    assert await _unlocked(factory, owner)


async def test_some_lesson_blocks_pending_does_not_unlock(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    await _add(factory, _lesson(owner, {"a": True}))
    assert not await _unlocked(factory, owner)


async def test_lesson_without_blocks_is_not_done(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    await _add(factory, _lesson(owner, {}, blocks=()))
    assert not await _unlocked(factory, owner)


async def test_tasks_due_today_all_completed_unlocks(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    await _add(factory, _task(owner, "completed"), _task(owner, "completed"))
    assert await _unlocked(factory, owner)


async def test_one_open_task_due_today_blocks_unlock(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    await _add(factory, _task(owner, "completed"), _task(owner, "todo"))
    assert not await _unlocked(factory, owner)


async def test_open_tasks_do_not_block_a_finished_lesson(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    await _add(factory, _lesson(owner, {"a": True, "b": True}), _task(owner, "todo"))
    assert await _unlocked(factory, owner)


async def test_overdue_and_undated_tasks_are_ignored(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    await _add(factory, _task(owner, "todo", NOON - timedelta(days=2)), _task(owner, "todo", None))
    assert not await _unlocked(factory, owner)  # nothing due today: an empty list never unlocks
    await _add(factory, _task(owner, "completed"))
    assert await _unlocked(factory, owner)


async def test_deleted_tasks_are_ignored(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    await _add(factory, _task(owner, "todo", deleted_at=NOON), _task(owner, "completed"))
    assert await _unlocked(factory, owner)
    await _add(factory, _task(owner, "todo", deleted_at=NOON))
    assert await _unlocked(factory, owner)


async def test_due_day_is_read_in_the_task_timezone(automation_client):  # noqa: F811
    client, factory = automation_client
    await _owner(client)
    owner = await _owner_id(factory)
    late = datetime(DAY.year, DAY.month, DAY.day, 22, 0, tzinfo=UTC)  # already tomorrow in Almaty (UTC+5)
    await _add(factory, _task(owner, "todo", late, "Asia/Almaty"), _task(owner, "completed"))
    assert await _unlocked(factory, owner)  # the open task belongs to tomorrow
    await _add(factory, _task(owner, "todo", late))  # no timezone: UTC, so it is today
    assert not await _unlocked(factory, owner)


async def test_state_endpoint_returns_unlock_counters_and_promoted_config(automation_client):  # noqa: F811
    client, factory = automation_client
    headers = await _owner(client)
    await _add(factory, _task(await _owner_id(factory), "completed"))
    res = await client.get("/api/v1/focus/state", params={"day": DAY.isoformat()}, headers=headers)
    assert res.status_code == 200
    assert res.json() == {
        "day_unlocked": True, "ai_grants_left": 3, "requests_left": 10,
        "config": (await client.get("/api/v1/focus/config", params={"day": DAY.isoformat()}, headers=headers)).json(),
    }
    far = await client.get("/api/v1/focus/state", params={"day": "2020-01-01"}, headers=headers)
    assert far.status_code == 422
