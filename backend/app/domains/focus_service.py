"""Focus-session logic shared by the HTTP routes and the companion actions.

Contract: these functions never commit. They flush at most; the caller (the route or
`run_action`) owns the transaction and commits it together with its own effects.
Failures raise HTTPException exactly as the routes always did.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, uuid4, uuid5

from app.companion.hub import mark_dirty
from app.core.models import FocusSession
from app.domains.ownership import owner_obj
from app.domains.recurrence import utc
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession


def focus_elapsed(started_at: datetime, paused_seconds: int, until: datetime) -> int:
    """Focused seconds: wall time minus accumulated pauses."""
    return max(0, int((until - started_at).total_seconds()) - paused_seconds)


POMODORO_SECONDS = 25 * 60


def focus_due(item: FocusSession, now: datetime) -> bool:
    """A running session with a planned length has used it all up."""
    return item.status == "active" and bool(item.planned_seconds) and focus_elapsed(utc(item.started_at), item.paused_seconds, now) >= (item.planned_seconds or 0)


async def active_focus(db: AsyncSession, owner_id: str) -> FocusSession | None:
    return (await db.execute(select(FocusSession).where(
        FocusSession.owner_id == owner_id, FocusSession.status.in_(("active", "paused"))))).scalar_one_or_none()


async def complete_due(db: AsyncSession, owner_id: str) -> None:
    """Nothing ticks on the server, so a finished pomodoro is completed on the next read or write that touches it."""
    item = await active_focus(db, owner_id)
    if item is None or not focus_due(item, datetime.now(UTC)):
        return
    planned = item.planned_seconds or 0
    ended_at = utc(item.started_at) + timedelta(seconds=item.paused_seconds + planned)
    result = await db.execute(update(FocusSession).where(FocusSession.id == item.id, FocusSession.version == item.version, FocusSession.status == "active").values(ended_at=ended_at, elapsed_seconds=planned, status="completed", version=item.version + 1))
    if int(getattr(result, "rowcount", 0) or 0) == 1:  # 0: another device changed it first, its write stands
        await db.refresh(item)
        mark_dirty(db, owner_id, "focus")  # Core UPDATE: no mapper event fires


async def start_focus(db: AsyncSession, owner_id: str, *, started_at: datetime, mode: str, task_id: str | None,
                      idempotency_key: str | None, project_id: str | None = None, planned_seconds: int | None = None) -> FocusSession:
    item_id = str(uuid5(NAMESPACE_URL, f"aelys:focus:{owner_id}:{idempotency_key}")) if idempotency_key else str(uuid4())
    existing = await db.get(FocusSession, item_id)
    if existing:
        if existing.task_id != task_id or existing.project_id != project_id or existing.mode != mode or utc(existing.started_at) != started_at:
            raise HTTPException(409, detail={"code": "IDEMPOTENCY_CONFLICT", "message": "Focus start key is bound to another request"})
        return existing
    await complete_due(db, owner_id)
    if await active_focus(db, owner_id):
        raise HTTPException(409, detail={"code": "TIMER_ACTIVE", "message": "Only one active focus session is allowed"})
    if planned_seconds is None and mode == "pomodoro":
        planned_seconds = POMODORO_SECONDS  # clients that predate planned_seconds still get a pomodoro that ends
    item = FocusSession(id=item_id, owner_id=owner_id, started_at=started_at, mode=mode, task_id=task_id, project_id=project_id,
                        planned_seconds=None if mode == "stopwatch" else planned_seconds)
    db.add(item)
    try:
        await db.flush()  # the partial unique index rejects a racing second active session here
    except IntegrityError as exc:
        await db.rollback()
        existing = await db.get(FocusSession, item_id)
        if existing:
            return existing
        raise HTTPException(409, detail={"code": "TIMER_ACTIVE", "message": "Another device started a focus session. Reload to see it."}) from exc
    return item


async def stop_focus(db: AsyncSession, owner_id: str, focus_id: str, version: int | None) -> FocusSession:
    await complete_due(db, owner_id)
    item = await owner_obj(FocusSession, focus_id, owner_id, db)
    if item.status == "completed":
        return item
    if version is not None and item.version != version:
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Focus session changed. Reload before stopping."})
    ended_at = datetime.now(UTC)
    paused_seconds = item.paused_seconds + (int((ended_at - utc(item.paused_at)).total_seconds()) if item.status == "paused" and item.paused_at else 0)
    result = await db.execute(update(FocusSession).where(FocusSession.id == focus_id, FocusSession.owner_id == owner_id, FocusSession.version == item.version, FocusSession.status.in_(("active", "paused"))).values(ended_at=ended_at, paused_at=None, paused_seconds=paused_seconds, elapsed_seconds=focus_elapsed(utc(item.started_at), paused_seconds, ended_at), status="completed", version=item.version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Another device changed the focus session. Reload."})
    await db.refresh(item)
    mark_dirty(db, owner_id, "focus")  # Core UPDATE: no mapper event fires
    return item


async def set_focus_paused(db: AsyncSession, owner_id: str, focus_id: str, paused: bool, version: int | None) -> FocusSession:
    await complete_due(db, owner_id)
    item = await owner_obj(FocusSession, focus_id, owner_id, db)
    source, target = ("active", "paused") if paused else ("paused", "active")
    if item.status == target:
        return item  # idempotent repeat
    if item.status != source:
        raise HTTPException(409, detail={"code": "INVALID_STATE", "message": f"Focus session is {item.status}"})
    if version is not None and item.version != version:
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Focus session changed. Reload."})
    now = datetime.now(UTC)
    if paused:
        values = {"paused_at": now, "elapsed_seconds": focus_elapsed(utc(item.started_at), item.paused_seconds, now)}
    else:
        values = {"paused_at": None, "paused_seconds": item.paused_seconds + (max(0, int((now - utc(item.paused_at)).total_seconds())) if item.paused_at else 0)}
    result = await db.execute(update(FocusSession).where(FocusSession.id == focus_id, FocusSession.owner_id == owner_id, FocusSession.version == item.version, FocusSession.status == source).values(status=target, version=item.version + 1, **values))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        await db.rollback()
        raise HTTPException(409, detail={"code": "VERSION_CONFLICT", "message": "Another device changed the focus session. Reload."})
    await db.refresh(item)
    mark_dirty(db, owner_id, "focus")  # Core UPDATE: no mapper event fires
    return item
