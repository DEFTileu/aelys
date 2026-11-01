"""One flush-only projection/change writer for mounted sync and domain mutations.

Call lock_owner before reading or changing a domain row. The PostgreSQL lock
lasts until the caller commits/rolls back, so sequence allocation follows commit
order for every writer of this owner's log, not just device pushes.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.core.models import (
    CalendarEvent,
    Note,
    Owned,
    Project,
    SyncChange,
    SyncRecord,
    Task,
)
from app.domains.recurrence import utc
from app.domains.task_clock import apply_task_transition, capture_task_statuses
from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .errors import SyncException
from .validation import validate_patch

DOMAIN_MODELS: dict[str, type[Owned]] = {'task': Task, 'note': Note, 'event': CalendarEvent, 'project': Project}
FIELDS = {
    'task': ('title', 'description', 'project_id', 'parent_task_id', 'status', 'priority', 'due_at', 'due_timezone', 'rrule', 'started_at', 'completed_at'),
    'note': ('title', 'markdown_body', 'parent_id', 'project_id', 'folder', 'tags', 'pinned'),
    'event': ('title', 'description', 'starts_at', 'ends_at', 'timezone', 'all_day', 'project_id', 'linked_task_id', 'rrule', 'external_source', 'external_id', 'external_metadata'),
    'project': ('name', 'description', 'status'),
}
SCOPES = {'task': 'tasks.write', 'note': 'notes.write', 'event': 'calendar.write', 'project': 'projects.write'}


@dataclass(frozen=True)
class _WritePolicy:
    name: str
    required_scope: str
    external_effect: bool = False


async def lock_owner(db: AsyncSession, owner_id: str) -> None:
    # Do not autoflush before locking: a writer holding a row and waiting on the
    # advisory lock would deadlock against a push holding the advisory lock.
    with db.no_autoflush:
        if db.get_bind().dialect.name == 'postgresql':
            await db.execute(text('SELECT pg_advisory_xact_lock(hashtext(:key))'), {'key': f'sync-owner:{owner_id}'})
        await capture_task_statuses(db, owner_id)
        # Validate pre-mutation state as well as the eventual log write. A patch
        # must not increment the version and hide historical equal-version drift.
        records = {(row.resource_kind, row.resource_id): row for row in
                   (await db.execute(select(SyncRecord).where(SyncRecord.owner_id == owner_id,
                        SyncRecord.resource_kind.in_(DOMAIN_MODELS)))).scalars()}
        for kind, model in DOMAIN_MODELS.items():
            rows = (await db.execute(select(model).where(model.owner_id == owner_id))).scalars()
            for item in rows:
                record = records.get((kind, item.id))
                if record and (record.version > item.version or (record.version == item.version
                        and _projection_disagrees(record, domain_payload(item, kind), item.deleted_at))):
                    raise HTTPException(409, detail={'code': 'SYNC_RECONCILIATION_REQUIRED',
                        'message': 'Historical domain and sync data diverge; review both before merging.'})


def _projection_disagrees(record: SyncRecord, payload: dict[str, Any], deleted_at: datetime | None) -> bool:
    if bool(record.deleted_at) != bool(deleted_at):
        return True
    metadata = {'id', 'version', 'owner_id', 'created_at', 'updated_at', 'deleted_at'}
    return any(payload.get(key) != value for key, value in record.payload.items() if key not in metadata)


async def record_change(db: AsyncSession, *, owner_id: str, kind: str, resource_id: str,
                        version: int, payload: dict[str, Any], operation: str,
                        deleted_at: datetime | None = None) -> SyncChange:
    """Write the projection and log atomically, never committing the caller."""
    scope = SCOPES.get(kind, 'sync.write')
    ServerPolicyEngine().authorize(_WritePolicy(f'domain.{kind}.write', scope),
        ToolCall(f'domain.{kind}.write', {}), PermissionContext(
            actor=f'owner:{owner_id}', scopes=frozenset({scope}), policy_id='owner-domain-write'))
    await lock_owner(db, owner_id)
    try:
        validate_patch(payload)
    except SyncException as exc:
        raise HTTPException(exc.status_code, detail={'code': exc.code.value, 'message': exc.message}) from exc
    record = await db.get(SyncRecord, (owner_id, kind, resource_id))
    if record and record.version > version:
        raise HTTPException(409, detail={'code': 'SYNC_RECONCILIATION_REQUIRED',
            'message': 'Historical sync data is newer than the domain row; review both before merging.'})
    if record and record.version == version and _projection_disagrees(record, payload, deleted_at):
        raise HTTPException(409, detail={'code': 'SYNC_RECONCILIATION_REQUIRED',
            'message': 'Historical domain and sync content diverge; review both before merging.'})
    default_projection_enrichment = False
    if record and kind == 'event' and record.version == version:
        added = payload.keys() - record.payload.keys()
        defaults: dict[str, Any] = {'external_source': None, 'external_id': None, 'external_metadata': {}}
        default_projection_enrichment = (bool(added) and added <= defaults.keys()
            and all(payload[name] == defaults[name] for name in added)
            and record.payload == {name: value for name, value in payload.items() if name not in added})
    if record and kind == 'task' and record.version == version:
        added = payload.keys() - record.payload.keys()
        default_projection_enrichment = (bool(added) and added <= {'started_at', 'completed_at'}
            and all(payload[name] is None for name in added)
            and record.payload == {name: value for name, value in payload.items() if name not in added})
    if (record and record.version == version and bool(record.deleted_at) == bool(deleted_at)
            and (record.payload == payload or default_projection_enrichment)):
        existing = (await db.execute(select(SyncChange).where(
            SyncChange.owner_id == owner_id, SyncChange.resource_kind == kind,
            SyncChange.resource_id == resource_id, SyncChange.version == version,
        ).order_by(SyncChange.seq.desc()).limit(1))).scalar_one_or_none()
        if existing and (record.payload == payload or existing.payload == record.payload):
            if default_projection_enrichment:
                # Enrich only the derived mirror. The historical log remains
                # immutable and keeps its original sequence/cursor position.
                record.payload = payload
                await db.flush()
            return existing
    if record is None:
        record = SyncRecord(owner_id=owner_id, resource_kind=kind, resource_id=resource_id)
        db.add(record)
    record.version = version; record.payload = payload; record.deleted_at = deleted_at
    change = SyncChange(owner_id=owner_id, resource_kind=kind, resource_id=resource_id,
                        version=version, operation=operation, payload=payload)
    db.add(change)
    await db.flush()
    return change


async def record_domain_change(db: AsyncSession, item: Owned, *, track_task_clock: bool = True) -> SyncChange:
    kind = next((kind for kind, model in DOMAIN_MODELS.items() if isinstance(item, model)), None)
    if kind is None:
        raise ValueError('Domain is not included in this sync slice')
    await lock_owner(db, item.owner_id)
    await db.flush()
    await db.refresh(item)
    prior = await db.get(SyncRecord, (item.owner_id, kind, item.id))
    if track_task_clock and isinstance(item, Task):
        await apply_task_transition(db, item, prior)
    operation = 'delete' if item.deleted_at else ('update' if prior else 'create')
    payload = domain_payload(item, kind)
    return await record_change(db, owner_id=item.owner_id, kind=kind, resource_id=item.id,
                               version=item.version, payload=payload, operation=operation,
                               deleted_at=item.deleted_at)


def domain_payload(item: Owned, kind: str) -> dict[str, Any]:
    """Explicit allowlist, shared by the log and conflict responses."""
    if item.deleted_at:
        return {}
    values = {'id': item.id, 'version': item.version, **{name: getattr(item, name) for name in FIELDS[kind]}}
    if kind == 'task':
        for name in ('started_at', 'completed_at'):
            if values[name] is not None:
                values[name] = utc(values[name])
    return jsonable_encoder(values)


async def ensure_domain_projection(db: AsyncSession, owner_id: str) -> None:
    """Index pre-upgrade REST objects through the same writer before snapshotting.

    This repairs a derived index, never mutates a domain object or its version.
    Ordinary post-upgrade mutations already update the projection transactionally.
    """
    await lock_owner(db, owner_id)
    records = {(row.resource_kind, row.resource_id): row for row in
               (await db.execute(select(SyncRecord).where(SyncRecord.owner_id == owner_id,
                    SyncRecord.resource_kind.in_(DOMAIN_MODELS)))).scalars()}
    for kind, model in DOMAIN_MODELS.items():
        rows = list((await db.execute(select(model).where(model.owner_id == owner_id))).scalars())
        for item in rows:
            record = records.get((kind, item.id))
            if (record is None or record.version != item.version
                    or bool(record.deleted_at) != bool(item.deleted_at)
                    or record.payload != domain_payload(item, kind)):
                await record_domain_change(db, item, track_task_clock=False)
    # Keep this derived-index commit separate from the repeatable-read snapshot
    # opened by bootstrap. PostgreSQL's owner lock preserves cursor commit order.
    await db.commit()
