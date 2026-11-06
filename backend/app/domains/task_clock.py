"""Flush-only server task status clocks and immutable, versioned history.

The owner lock captures pre-mutation status even for legacy tasks without a
sync projection. The common domain writer invokes the transition after a real
write; rebuilding a projection explicitly skips it. No scheduler or backfill.
"""
from dataclasses import dataclass
from uuid import NAMESPACE_URL, uuid5

from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.core.models import HistoryEntry, SyncRecord, Task, now
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .recurrence import utc

_COMPLETED = frozenset({'done', 'completed', 'complete', 'closed'})
_SNAPSHOT_KEY = 'task_clock_status_snapshot'


@dataclass
class _ClockPolicy:
    name: str = 'task.status.changed'
    required_scope: str = 'tasks.write'
    external_effect: bool = False


@dataclass
class _StatusSnapshot:
    transaction: object
    owners: dict[str, dict[str, tuple[int, str]]]


async def capture_task_statuses(db: AsyncSession, owner_id: str) -> None:
    """Once per owner transaction, under its lock and before any autoflush."""
    transaction = db.sync_session.get_transaction()
    state: _StatusSnapshot | None = db.info.get(_SNAPSHOT_KEY)
    if state is not None and state.transaction is transaction and owner_id in state.owners:
        return
    rows = (await db.execute(select(Task.id, Task.version, Task.status).where(Task.owner_id == owner_id))).all()
    transaction = db.sync_session.get_transaction()
    if state is None or state.transaction is not transaction:
        state = _StatusSnapshot(transaction, {})
        db.info[_SNAPSHOT_KEY] = state
    state.owners[owner_id] = {task_id: (version, status) for task_id, version, status in rows}


async def apply_task_transition(db: AsyncSession, task: Task, prior: SyncRecord | None) -> bool:
    """Set clocks and append history without changing the domain version.

    Returns True only when this call recorded a transition into a completed status.
    """
    if task.deleted_at is not None or (prior is not None and prior.version >= task.version):
        return False
    state: _StatusSnapshot | None = db.info.get(_SNAPSHOT_KEY)
    snapshot = state.owners.get(task.owner_id, {}).get(task.id) if state is not None else None
    previous: str | None = None
    previous_version = -1
    if prior is not None:
        previous_version = prior.version
        previous = prior.payload.get('status', 'todo') if not prior.deleted_at else task.status
    if snapshot is not None and snapshot[0] < task.version and snapshot[0] >= previous_version:
        previous_version, previous = snapshot
    elif prior is None and snapshot is not None:
        # Existing row, no accepted version increment: never invent history.
        return False
    current_state = task.status.strip().casefold()
    previous_state = previous.strip().casefold() if previous is not None else None
    if previous == task.status or (previous is None and current_state == 'todo'):
        return False
    history_id = str(uuid5(NAMESPACE_URL, f'aelys:task-status:{task.owner_id}:{task.id}:{task.version}'))
    if await db.get(HistoryEntry, history_id) is not None:
        return False
    ServerPolicyEngine().authorize(_ClockPolicy(), ToolCall('task.status.changed', {}),
        PermissionContext(actor=f'owner:{task.owner_id}', scopes=frozenset({'tasks.write'}), policy_id='owner-domain-write'))
    occurred_at = utc(now())
    if current_state == 'in_progress' and previous_state != 'in_progress':
        task.started_at = occurred_at
    if current_state in _COMPLETED:
        if previous_state not in _COMPLETED:
            task.completed_at = occurred_at
    elif previous_state in _COMPLETED:
        task.completed_at = None
    db.add(HistoryEntry(id=history_id, owner_id=task.owner_id, resource_id=task.id,
        action='task.status.changed', actor=f'owner:{task.owner_id}', metadata_json={
            'from': previous, 'to': task.status, 'task_version': task.version,
            'occurred_at': occurred_at.isoformat(),
            'started_at': utc(task.started_at).isoformat() if task.started_at else None,
            'completed_at': utc(task.completed_at).isoformat() if task.completed_at else None,
        }))
    await db.flush()
    return current_state in _COMPLETED and previous_state not in _COMPLETED
