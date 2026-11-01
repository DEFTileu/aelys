"""Apply device patches to the same four domain tables used by mounted REST."""
from __future__ import annotations

from typing import Any

from app.core.models import CalendarEvent, Note, NoteRevision, Owned, Project, Task, now
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from .change_log import FIELDS


async def apply_domain_patch(db: AsyncSession, *, owner_id: str, device_id: str,
                             kind: str, resource_id: str, version: int, action: str,
                             patch: dict[str, Any], item: Owned | None,
                             prior_payload: dict[str, Any] | None = None) -> Owned:
    # Reuse mounted validators/reference checks; this is not a second schema
    # accepting arbitrary fields into ORM objects from a device payload.
    from app.domains import capture
    from app.domains.api import EventIn, NoteIn, TaskIn, owned_ref

    schemas = {'task': TaskIn, 'note': NoteIn, 'event': EventIn}
    models = {'task': Task, 'note': Note, 'event': CalendarEvent, 'project': Project}
    immutable = {'id', 'version', 'created_at', 'updated_at', 'deleted_at', 'owner_id'}
    if kind == 'event':
        immutable.update({'external_source', 'external_id', 'external_metadata'})
        if isinstance(item, CalendarEvent) and item.external_source:
            raise HTTPException(409, detail={'code': 'EXTERNAL_EVENT_READ_ONLY', 'message': 'Imported events can only change through their source calendar'})
    if kind == 'task':
        immutable.update({'started_at', 'completed_at'})
    if set(patch) - set(FIELDS[kind]) - immutable:
        raise HTTPException(422, detail={'code': 'VALIDATION_ERROR', 'message': 'Unknown domain sync fields'})
    if ('id' in patch and patch['id'] != resource_id) or ('owner_id' in patch and patch['owner_id'] != owner_id):
        raise HTTPException(403, detail={'code': 'FORBIDDEN', 'message': 'Sync identity fields cannot change'})
    if action == 'delete':
        if item is None:
            raise HTTPException(409, detail={'code': 'VERSION_CONFLICT', 'message': 'Domain record is missing'})
        item.deleted_at = now(); item.version = version
        return item
    writable = set(FIELDS[kind]) - immutable
    values = {name: getattr(item, name) for name in writable} if item else {}
    values.update({name: value for name, value in patch.items() if name in writable})
    try:
        if kind == 'project':
            from app.core.schemas import ProjectCreate
            project = ProjectCreate.model_validate(values)
            values.update(project.model_dump())
            status = values.get('status', 'active')
            if not isinstance(status, str) or not 1 <= len(status) <= 20:
                raise ValueError('Invalid project status')
        else:
            values = schemas[kind].model_validate(values).model_dump()
            values.pop('reminder_at', None)
    except (ValidationError, ValueError) as exc:
        raise HTTPException(422, detail={'code': 'VALIDATION_ERROR', 'message': 'Invalid domain sync payload'}) from exc
    if kind != 'project':
        await owned_ref(Project, values.get('project_id'), owner_id, db)
    if kind == 'task':
        await owned_ref(Task, values.get('parent_task_id'), owner_id, db)
    elif kind == 'note':
        await owned_ref(Note, values.get('parent_id'), owner_id, db)
    elif kind == 'event':
        await owned_ref(Task, values.get('linked_task_id'), owner_id, db)
    if item is None:
        if kind == 'task':
            item = await capture.create_task(db, owner_id, id=resource_id, version=version, **values)
        elif kind == 'note':
            item = await capture.create_note(db, owner_id, id=resource_id, version=version,
                                             source_device_id=device_id, **values)
            if action == 'update' and version > 1 and prior_payload:
                db.add(NoteRevision(note_id=item.id, base_version=version-2, revision_no=version-1,
                                    body=prior_payload.get('markdown_body', ''), source_device_id=None))
        else:
            item = models[kind](id=resource_id, owner_id=owner_id, version=version, **values)
            db.add(item)
    else:
        body_changed = kind == 'note' and item.markdown_body != values['markdown_body']
        for name, value in values.items():
            setattr(item, name, value)
        item.version = version; item.deleted_at = None
        if body_changed:
            db.add(NoteRevision(note_id=item.id, base_version=version-1, revision_no=version,
                                body=values['markdown_body'], source_device_id=device_id))
    await db.flush()
    return item
