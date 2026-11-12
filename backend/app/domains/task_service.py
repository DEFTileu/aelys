"""Task completion shared by the AI tool and the companion actions.

Contract: never commits. The caller (the AI run or `run_action`) commits the update, its sync-log
row and the `task.completed` automation hook in one transaction.
"""
from __future__ import annotations

from app.core.models import Task
from app.domains.ownership import owner_obj
from app.sync.change_log import lock_owner, record_domain_change
from fastapi import HTTPException
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

_CONFLICT = {"code": "VERSION_CONFLICT", "message": "Task changed; read the latest version before editing"}


async def complete_task(db: AsyncSession, owner_id: str, task_id: str, version: int | None = None) -> Task:
    await lock_owner(db, owner_id, ("task", task_id))
    item = await owner_obj(Task, task_id, owner_id, db)
    if version is not None and item.version != version:
        raise HTTPException(409, detail=_CONFLICT)
    if item.status == "completed":
        return item
    result = await db.execute(update(Task).where(Task.id == item.id, Task.owner_id == owner_id, Task.deleted_at.is_(None),
        Task.version == item.version).values(status="completed", version=item.version + 1))
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        raise HTTPException(409, detail=_CONFLICT)
    await db.refresh(item)
    await record_domain_change(db, item)
    return item
