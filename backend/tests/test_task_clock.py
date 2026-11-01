"""Server task clocks share the real domain/sync transaction and status history."""
import copy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from app.ai.errors import PolicyDenied
from app.ai.models import PermissionContext, ToolCall
from app.ai.personal_tools import personal_tool_registry
from app.ai.policy import ServerPolicyEngine
from app.core.db import Base, get_db
from app.core.models import Device, HistoryEntry, SyncChange, SyncRecord, Task, User
from app.core.security import current_principal
from app.domains import capture, task_clock
from app.domains.api import TaskIn, TaskOut, TaskPatchIn
from app.domains.api import router as domain_router
from app.domains.recurrence import utc
from app.sync.api import router as sync_router
from app.sync.change_log import lock_owner, record_domain_change
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

AT = datetime(2026, 11, 8, 12, tzinfo=UTC)


@pytest.fixture
async def clock_setup(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/clock.db')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        owner = User(id='owner')
        device = Device(id='device', owner_id='owner', platform='web', display_name='Clock', credential_hash='test')
        db.add_all([owner, device, User(id='other')])
        await db.commit()
    async def database():
        async with sessions() as db:
            yield db
    app = FastAPI()
    app.include_router(domain_router, prefix='/api/v1')
    app.include_router(sync_router, prefix='/api/v1')
    app.dependency_overrides[get_db] = database
    app.dependency_overrides[current_principal] = lambda: (owner, device)
    instant = [AT]
    monkeypatch.setattr(task_clock, 'now', lambda: instant[0])
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            yield SimpleNamespace(client=client, sessions=sessions, instant=instant)
    finally:
        await engine.dispose()


async def create(setup, status='todo', **values):
    response = await setup.client.post('/api/v1/tasks', json={'title': 'Clock task', 'status': status, **values})
    assert response.status_code == 200, response.text
    return response.json()


async def update(setup, task, status, **values):
    response = await setup.client.patch(f'/api/v1/tasks/{task["id"]}', json={
        'title': task['title'], 'version': task['version'], 'status': status, **values,
    })
    assert response.status_code == 200, response.text
    return response.json()


async def history(db, task_id):
    rows = (await db.execute(select(HistoryEntry).where(HistoryEntry.resource_id == task_id,
        HistoryEntry.action == 'task.status.changed'))).scalars()
    return sorted(rows, key=lambda row: row.metadata_json['task_version'])


async def assert_projection(setup, task):
    async with setup.sessions() as db:
        item = await db.get(Task, task['id'])
        mirror = await db.get(SyncRecord, ('owner', 'task', task['id']))
        log = (await db.execute(select(SyncChange).where(SyncChange.resource_id == task['id'])
            .order_by(SyncChange.seq.desc()).limit(1))).scalar_one()
        assert item.version == mirror.version == log.version == task['version']
        assert mirror.payload == log.payload
        for name in ('started_at', 'completed_at'):
            expected = utc(datetime.fromisoformat(task[name])) if task[name] else None
            assert (utc(getattr(item, name)) if getattr(item, name) else None) == expected
            assert (utc(datetime.fromisoformat(log.payload[name])) if log.payload[name] else None) == expected


async def test_transitions_aliases_reentry_and_immutable_completion_history(clock_setup):
    setup = clock_setup
    task = await create(setup)
    assert task['started_at'] is task['completed_at'] is None
    task = await update(setup, task, 'in_progress')
    started = task['started_at']
    assert datetime.fromisoformat(started) == AT
    setup.instant[0] += timedelta(hours=1)
    task = await update(setup, task, 'in_progress', title='Same status')
    assert task['started_at'] == started
    task = await update(setup, task, 'done')
    completed = task['completed_at']
    async with setup.sessions() as db:
        before = {row.id: copy.deepcopy(row.metadata_json) for row in await history(db, task['id'])}
    setup.instant[0] += timedelta(hours=1)
    task = await update(setup, task, 'completed')
    assert task['completed_at'] == completed and task['started_at'] == started
    task = await update(setup, task, 'todo')
    assert task['completed_at'] is None and task['started_at'] == started
    setup.instant[0] += timedelta(hours=1)
    task = await update(setup, task, 'in_progress')
    assert task['started_at'] != started
    setup.instant[0] += timedelta(hours=1)
    task = await update(setup, task, 'closed')
    assert task['completed_at'] != completed
    await assert_projection(setup, task)
    async with setup.sessions() as db:
        rows = await history(db, task['id'])
        assert [row.metadata_json['task_version'] for row in rows] == [2, 4, 5, 6, 7, 8]
        assert all(row.owner_id == 'owner' for row in rows)
        assert {row.id: row.metadata_json for row in rows if row.id in before} == before
        assert datetime.fromisoformat(rows[1].metadata_json['completed_at']) == datetime.fromisoformat(completed)
        assert rows[-1].metadata_json['from'] == 'in_progress'
        assert rows[-1].metadata_json['to'] == 'closed'
        assert 'Clock task' not in str([row.metadata_json for row in rows])
        count = len(rows)
        item = await db.get(Task, task['id'])
        await record_domain_change(db, item)
        await record_domain_change(db, item)
        await db.commit()
        assert len(await history(db, task['id'])) == count
        changes = list((await db.execute(select(SyncChange).where(SyncChange.resource_id == task['id']))).scalars())
        assert len(changes) == task['version']


@pytest.mark.parametrize('status', ['in_progress', 'done', 'completed', 'complete', 'closed'])
async def test_initial_status_stamps_once_and_api_is_read_only(clock_setup, status):
    forged = '1999-01-01T00:00:00Z'
    task = await create(clock_setup, status, started_at=forged, completed_at=forged)
    name = 'started_at' if status == 'in_progress' else 'completed_at'
    assert datetime.fromisoformat(task[name]) == AT
    assert task['completed_at' if name == 'started_at' else 'started_at'] is None
    await assert_projection(clock_setup, task)
    for model in (TaskIn, TaskPatchIn):
        assert not {'started_at', 'completed_at'} & set(model.model_fields)
    for field in ('started_at', 'completed_at'):
        assert TaskOut.model_json_schema()['properties'][field]['readOnly'] is True
    async with clock_setup.sessions() as db:
        rows = await history(db, task['id'])
        assert len(rows) == 1 and rows[0].metadata_json['from'] is None


async def test_capture_clock_and_history_are_flush_only_and_rollback_together(clock_setup):
    async with clock_setup.sessions() as db:
        item = await capture.create_task(db, 'owner', title='Rollback', status='in_progress')
        assert utc(item.started_at) == AT and len(await history(db, item.id)) == 1
        item_id = item.id
        async with clock_setup.sessions() as observer:
            assert await observer.get(Task, item_id) is None
            assert await history(observer, item_id) == []
        await db.rollback()
    async with clock_setup.sessions() as db:
        assert await db.get(Task, item_id) is None and await history(db, item_id) == []
        assert list((await db.execute(select(SyncChange))).scalars()) == []


@pytest.mark.parametrize('status,alias', [('DONE', 'Completed'), (' complete ', 'CLOSED')])
async def test_completion_classification_is_case_insensitive_without_reset(clock_setup, status, alias):
    task = await create(clock_setup, status)
    completed = task['completed_at']
    assert datetime.fromisoformat(completed) == AT
    clock_setup.instant[0] += timedelta(hours=1)
    task = await update(clock_setup, task, alias)
    assert task['completed_at'] == completed
    task = await update(clock_setup, task, 'IN_PROGRESS')
    assert task['completed_at'] is None and datetime.fromisoformat(task['started_at']) == AT + timedelta(hours=1)
    clock_setup.instant[0] += timedelta(hours=1)
    task = await update(clock_setup, task, ' in_progress ')
    assert datetime.fromisoformat(task['started_at']) == AT + timedelta(hours=1)
    task = await update(clock_setup, task, 'DONE')
    assert datetime.fromisoformat(task['completed_at']) == AT + timedelta(hours=2)
    async with clock_setup.sessions() as db:
        rows = await history(db, task['id'])
        assert rows[0].metadata_json['to'] == status
        assert rows[1].metadata_json['from'] == status and rows[1].metadata_json['to'] == alias


async def test_multiple_transitions_in_one_transaction_rollback_without_leaking(clock_setup):
    task = await create(clock_setup)
    async with clock_setup.sessions() as db:
        await lock_owner(db, 'owner')
        item = await db.get(Task, task['id'])
        for status in ('done', 'todo', 'done'):
            item.status = status; item.version += 1
            await record_domain_change(db, item)
            clock_setup.instant[0] += timedelta(hours=1)
        rows = await history(db, item.id)
        assert [row.metadata_json['task_version'] for row in rows] == [2, 3, 4]
        assert datetime.fromisoformat(rows[0].metadata_json['completed_at']) == AT
        assert rows[1].metadata_json['completed_at'] is None
        assert datetime.fromisoformat(rows[2].metadata_json['completed_at']) == AT + timedelta(hours=2)
        await db.rollback()
    current = (await clock_setup.client.get(f'/api/v1/tasks/{task["id"]}')).json()
    assert current == task
    async with clock_setup.sessions() as db:
        assert await history(db, task['id']) == []
        assert len(list((await db.execute(select(SyncChange))).scalars())) == 1


async def test_ai_update_and_stale_rest_cas_use_common_clock(clock_setup):
    task = await create(clock_setup)
    async with clock_setup.sessions() as db:
        registry = personal_tool_registry(db, 'owner', 'clock-event')
        await registry.invoke(ToolCall('update_task', {'task_id': task['id'], 'version': 1, 'status': 'in_progress'}),
                              PermissionContext(actor='test', scopes=frozenset({'tasks.write'})))
        await db.commit()
    current = (await clock_setup.client.get(f'/api/v1/tasks/{task["id"]}')).json()
    assert datetime.fromisoformat(current['started_at']) == AT and current['version'] == 2
    stale = await clock_setup.client.patch(f'/api/v1/tasks/{task["id"]}', json={'title': 'Stale', 'status': 'done', 'version': 1})
    assert stale.status_code == 409
    assert (await clock_setup.client.get(f'/api/v1/tasks/{task["id"]}')).json() == current
    async with clock_setup.sessions() as db:
        assert len(await history(db, task['id'])) == 1


@pytest.mark.parametrize('old_mirror', [False, True])
async def test_legacy_index_and_title_edit_never_fabricate_clock(clock_setup, old_mirror):
    async with clock_setup.sessions() as db:
        db.add(Task(id='legacy', owner_id='owner', title='Legacy', status='in_progress', version=4))
        if old_mirror:
            db.add(SyncRecord(owner_id='owner', resource_kind='task', resource_id='legacy', version=4,
                payload={'id': 'legacy', 'version': 4, 'title': 'Legacy', 'status': 'in_progress'}))
        await db.commit()
    for _ in range(2):
        response = await clock_setup.client.get('/api/v1/sync/bootstrap')
        assert response.status_code == 200, response.text
    legacy = (await clock_setup.client.get('/api/v1/tasks/legacy')).json()
    assert legacy['started_at'] is legacy['completed_at'] is None and legacy['version'] == 4
    legacy = await update(clock_setup, legacy, 'in_progress', title='Renamed')
    assert legacy['started_at'] is legacy['completed_at'] is None
    async with clock_setup.sessions() as db:
        assert await history(db, 'legacy') == []
        assert len(list((await db.execute(select(SyncChange).where(SyncChange.resource_id == 'legacy'))).scalars())) == 2
    legacy = await update(clock_setup, legacy, 'done')
    assert legacy['started_at'] is None and datetime.fromisoformat(legacy['completed_at']) == AT


async def test_legacy_first_edit_without_index_uses_original_status(clock_setup):
    async with clock_setup.sessions() as db:
        db.add(Task(id='legacy', owner_id='owner', title='Legacy', status='in_progress', version=4))
        await db.commit()
    item = await update(clock_setup, {'id': 'legacy', 'title': 'Legacy', 'version': 4}, 'in_progress', title='Renamed')
    assert item['started_at'] is item['completed_at'] is None
    item = await update(clock_setup, item, 'done')
    assert datetime.fromisoformat(item['completed_at']) == AT
    async with clock_setup.sessions() as db:
        assert [row.metadata_json['task_version'] for row in await history(db, 'legacy')] == [6]


async def test_existing_legacy_log_is_immutable_when_index_adds_null_clocks(clock_setup):
    old_payload = {'id': 'legacy', 'version': 4, 'title': 'Legacy', 'description': '',
        'project_id': None, 'parent_task_id': None, 'status': 'in_progress', 'priority': 0,
        'due_at': None, 'due_timezone': None, 'rrule': None}
    async with clock_setup.sessions() as db:
        db.add(Task(id='legacy', owner_id='owner', title='Legacy', status='in_progress', version=4))
        db.add(SyncRecord(owner_id='owner', resource_kind='task', resource_id='legacy', version=4,
            payload=copy.deepcopy(old_payload)))
        change = SyncChange(owner_id='owner', resource_kind='task', resource_id='legacy', version=4,
            operation='update', payload=copy.deepcopy(old_payload))
        db.add(change)
        await db.commit()
        seq, committed_at = change.seq, utc(change.committed_at)
    for _ in range(2):
        response = await clock_setup.client.get('/api/v1/sync/bootstrap')
        assert response.status_code == 200, response.text
    async with clock_setup.sessions() as db:
        item = await db.get(Task, 'legacy')
        record = await db.get(SyncRecord, ('owner', 'task', 'legacy'))
        changes = list((await db.execute(select(SyncChange).where(SyncChange.resource_id == 'legacy'))).scalars())
        assert len(changes) == 1 and changes[0].seq == seq and changes[0].version == 4
        assert changes[0].payload == old_payload and utc(changes[0].committed_at) == committed_at
        assert record.payload == {**old_payload, 'started_at': None, 'completed_at': None}
        assert item.version == 4 and item.started_at is item.completed_at is None
        assert await history(db, 'legacy') == []


async def test_push_ignores_forged_clocks_and_stale_cas_never_emits(clock_setup):
    async def push(action, base, patch, operation_id=None):
        response = await clock_setup.client.post('/api/v1/sync/push', json={'device_id': 'device', 'operations': [{
            'device_id': 'device', 'operation_id': operation_id or str(uuid4()), 'resource_kind': 'task',
            'resource_id': 'pushed', 'action': action, 'base_version': base, 'patch': patch,
        }]})
        assert response.status_code == 200, response.text
        return response.json()['results'][0]
    operation_id = str(uuid4())
    payload = {'title': 'Offline', 'status': 'in_progress', 'started_at': '1999-01-01T00:00:00Z', 'completed_at': {'untrusted': True}}
    assert (await push('create', 0, payload, operation_id))['status'] == 'applied'
    await push('create', 0, payload, operation_id)
    item = (await clock_setup.client.get('/api/v1/tasks/pushed')).json()
    assert datetime.fromisoformat(item['started_at']) == AT and item['completed_at'] is None
    clock_setup.instant[0] += timedelta(hours=1)
    assert (await push('update', 0, {'status': 'done'}))['status'] == 'conflict'
    assert (await push('update', 1, {'status': 'done', 'started_at': None, 'completed_at': '1999-01-01T00:00:00Z'}))['status'] == 'applied'
    current = (await clock_setup.client.get('/api/v1/tasks/pushed')).json()
    assert current['started_at'] == item['started_at'] and datetime.fromisoformat(current['completed_at']) == AT + timedelta(hours=1)
    await assert_projection(clock_setup, current)
    async with clock_setup.sessions() as db:
        assert [row.metadata_json['task_version'] for row in await history(db, 'pushed')] == [1, 2]


async def test_clock_policy_denial_happens_before_clock_or_history_mutation(clock_setup, monkeypatch):
    task = await create(clock_setup)
    async with clock_setup.sessions() as db:
        await lock_owner(db, 'owner')
        item = await db.get(Task, task['id'])
        item.status = 'in_progress'; item.version += 1
        await db.flush()
        checks = []
        def deny(self, descriptor, call, context):
            checks.append(descriptor.required_scope)
            raise PolicyDenied('Clock denied')
        monkeypatch.setattr(ServerPolicyEngine, 'authorize', deny)
        with pytest.raises(PolicyDenied):
            await record_domain_change(db, item)
        assert checks == ['tasks.write']
        assert item.started_at is item.completed_at is None
        assert await history(db, item.id) == []
        await db.rollback()
