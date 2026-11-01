"""Shared, flush-only creation for REST, AI, automation and verified capture."""
from typing import Any

from app.core.models import Note, NoteRevision, Project, Task
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession


async def _owned_ref(db: AsyncSession, model: Any, item_id: str | None, owner_id: str) -> None:
    if item_id is None:
        return
    item = await db.get(model, item_id)
    if item is None or item.owner_id != owner_id or item.deleted_at is not None:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Referenced resource not found"})


async def create_task(db: AsyncSession, owner_id: str, *, title: str, description: str = "",
                      project_id: str | None = None, parent_task_id: str | None = None, **fields: Any) -> Task:
    await _owned_ref(db, Project, project_id, owner_id)
    await _owned_ref(db, Task, parent_task_id, owner_id)
    item = Task(owner_id=owner_id, title=title, description=description,
                project_id=project_id, parent_task_id=parent_task_id, **fields)
    db.add(item)
    await db.flush()
    return item


async def create_note(db: AsyncSession, owner_id: str, *, title: str, markdown_body: str = "",
                      project_id: str | None = None, parent_id: str | None = None,
                      source_device_id: str | None = None, **fields: Any) -> Note:
    await _owned_ref(db, Project, project_id, owner_id)
    await _owned_ref(db, Note, parent_id, owner_id)
    item = Note(owner_id=owner_id, title=title, markdown_body=markdown_body,
                project_id=project_id, parent_id=parent_id, **fields)
    db.add(item)
    await db.flush()
    db.add(NoteRevision(note_id=item.id, base_version=0, revision_no=1,
                        body=markdown_body, source_device_id=source_device_id))
    await db.flush()
    return item
