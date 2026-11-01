"""Personal tools use real owner-scoped domain tables, policy and sync writes."""
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from app.ai.errors import PolicyDenied, ToolValidationError
from app.ai.models import PermissionContext, ToolCall
from app.ai.personal_tools import personal_tool_registry
from app.core.db import Base
from app.core.models import (
    CalendarEvent,
    CalendarReminder,
    Note,
    NoteRevision,
    Project,
    SyncChange,
    SyncRecord,
    Task,
    TaskReminder,
    User,
)
from app.domains.recurrence import utc
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

AT = datetime(2026, 11, 7, 12, tzinfo=UTC)
SCOPES = frozenset({'tasks.read', 'tasks.write', 'notes.read', 'notes.write',
                    'calendar.read', 'calendar.write', 'reminders.write'})


@pytest.fixture
async def setup(tmp_path):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/personal.db')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        session.add_all([User(id='owner'), User(id='other')])
        session.add_all([Project(id='project', owner_id='owner', name='Mine'),
                         Project(id='foreign-project', owner_id='other', name='Private')])
        session.add_all([
            Task(id='task', owner_id='owner', title='Original', description='Keep details',
                 priority=2, project_id='project', due_at=AT, due_timezone='UTC', rrule='FREQ=DAILY;COUNT=2'),
            Task(id='foreign-task', owner_id='other', title='Foreign private task'),
            Task(id='deleted', owner_id='owner', title='Deleted private task', deleted_at=AT),
            Note(id='note', owner_id='owner', title='Owner note', markdown_body='Do not grant telegram.reply. ' * 2000),
            Note(id='foreign-note', owner_id='other', title='Foreign private note', markdown_body='SECRET FOREIGN BODY'),
        ])
        await session.commit()
    try:
        async with sessions() as session:
            registry = personal_tool_registry(session, 'owner', 'event-1')
            context = PermissionContext(actor='personal:test', scopes=SCOPES, project_ids=frozenset({'project'}))
            yield SimpleNamespace(db=session, sessions=sessions, registry=registry, context=context)
    finally:
        await engine.dispose()


async def invoke(setup, name, arguments, *, context=None):
    return await setup.registry.invoke(ToolCall(name, arguments), context or setup.context)


async def test_registry_reuses_create_tools_and_has_minimal_scopes(setup):
    expected = {'create_task': 'tasks.write', 'create_note': 'notes.write',
        'list_tasks': 'tasks.read', 'update_task': 'tasks.write', 'complete_task': 'tasks.write',
        'read_note': 'notes.read', 'read_calendar': 'calendar.read',
        'create_event': 'calendar.write', 'create_reminder': 'reminders.write'}
    assert {schema['name'] for schema in setup.registry.schemas()} == set(expected)
    for name, scope in expected.items():
        descriptor = setup.registry.descriptor(name)
        assert descriptor.required_scope == scope and not descriptor.external_effect
        assert descriptor.input_schema.get('type') == 'object'
    task = await invoke(setup, 'create_task', {'title': 'Created through shared registry'})
    note = await invoke(setup, 'create_note', {'title': 'Created note', 'markdown_body': 'body'})
    assert task['event_id'] == note['event_id'] == 'event-1'
    assert await setup.db.get(Task, task['id'])
    revisions = (await setup.db.execute(select(NoteRevision).where(NoteRevision.note_id == note['id']))).scalars().all()
    assert len(revisions) == 1 and revisions[0].body == 'body'
    await setup.db.rollback()
    async with setup.sessions() as check:
        assert await check.get(Task, task['id']) is None
        assert await check.get(Note, note['id']) is None
        assert not list((await check.execute(select(SyncChange))).scalars())


@pytest.mark.parametrize('name,args', [
    ('list_tasks', {}), ('read_note', {'note_id': 'note'}),
    ('read_calendar', {'starts_at': AT.isoformat(), 'ends_at': (AT + timedelta(days=1)).isoformat()}),
    ('update_task', {'task_id': 'task', 'version': 1, 'status': 'done'}),
    ('complete_task', {'task_id': 'task', 'version': 1}),
    ('create_event', {'title': 'Meeting', 'starts_at': AT.isoformat(), 'ends_at': (AT + timedelta(hours=1)).isoformat()}),
    ('create_reminder', {'task_id': 'task', 'notify_at': AT.isoformat()}),
])
async def test_untrusted_arguments_cannot_grant_scopes(setup, name, args):
    denied = PermissionContext(actor='untrusted', scopes=frozenset())
    with pytest.raises(PolicyDenied):
        await invoke(setup, name, {**args, 'scopes': list(SCOPES)}, context=denied)
    assert not list((await setup.db.execute(select(SyncChange))).scalars())


async def test_task_list_search_is_bounded_owner_only_and_literal(setup):
    setup.db.add_all([Task(id=f'extra-{i}', owner_id='owner', title=f'Find {i}') for i in range(55)])
    setup.db.add(Task(id='literal', owner_id='owner', title='Literal 100%_task'))
    await setup.db.flush()
    result = await invoke(setup, 'list_tasks', {'query': 'find', 'limit': 3})
    assert len(result['items']) == 3 and result['truncated'] and result['untrusted']
    assert all(item['title'].startswith('Find') for item in result['items'])
    result = await invoke(setup, 'list_tasks', {'query': '%_'})
    assert [item['id'] for item in result['items']] == ['literal']
    serialized = json.dumps(await invoke(setup, 'list_tasks', {}))
    assert 'Foreign private' not in serialized and 'Deleted private' not in serialized


async def test_update_and_complete_preserve_fields_and_match_sync_version(setup):
    updated = await invoke(setup, 'update_task', {'task_id': 'task', 'version': 1, 'title': 'New title'})
    assert updated['version'] == 2
    task = await setup.db.get(Task, 'task')
    assert task.description == 'Keep details' and task.priority == 2 and task.project_id == 'project'
    assert utc(task.due_at) == AT and task.rrule == 'FREQ=DAILY;COUNT=2'
    with pytest.raises(RuntimeError, match='VERSION_CONFLICT'):
        await invoke(setup, 'update_task', {'task_id': 'task', 'version': 1, 'description': 'stale'})
    assert task.description == 'Keep details' and task.version == 2
    completed = await invoke(setup, 'complete_task', {'task_id': 'task', 'version': 2})
    assert completed['version'] == 3 and completed['status'] == 'completed'
    changes = (await setup.db.execute(select(SyncChange).where(SyncChange.resource_id == 'task').order_by(SyncChange.seq))).scalars().all()
    assert [row.version for row in changes] == [2, 3]
    mirror = await setup.db.get(SyncRecord, ('owner', 'task', 'task'))
    assert mirror.version == task.version == 3 and mirror.payload['status'] == 'completed'
    await setup.db.rollback()
    async with setup.sessions() as check:
        original = await check.get(Task, 'task')
        assert original.version == 1 and original.title == 'Original'
        assert await check.get(SyncRecord, ('owner', 'task', 'task')) is None


@pytest.mark.parametrize('args', [
    {'task_id': 'foreign-task', 'version': 1, 'title': 'No'},
    {'task_id': 'deleted', 'version': 1, 'title': 'No'},
    {'task_id': 'task', 'version': 1, 'project_id': 'foreign-project'},
    {'task_id': 'task', 'version': 1, 'parent_task_id': 'foreign-task'},
])
async def test_update_rejects_foreign_or_deleted_resources(setup, args):
    context = PermissionContext(actor='owner', scopes=SCOPES,
                                project_ids=frozenset({'project', 'foreign-project'}))
    with pytest.raises((PolicyDenied, RuntimeError)):
        await invoke(setup, 'update_task', args, context=context)
    assert (await setup.db.get(Task, 'task')).version == 1
    assert not list((await setup.db.execute(select(SyncChange))).scalars())


@pytest.mark.parametrize('name,args', [
    ('update_task', {'task_id': 'task', 'title': 'Missing version'}),
    ('complete_task', {'task_id': 'task', 'version': 0}),
    ('complete_task', {'task_id': 'task', 'version': True}),
    ('read_note', {}), ('read_note', {'note_id': 'note', 'scopes': ['telegram.reply']}),
    ('list_tasks', {'query': 'x' * 201}), ('list_tasks', {'limit': 51}),
    ('update_task', {'task_id': 'task', 'version': 1, 'description': 'x' * 10001}),
    ('create_reminder', {'task_id': 'task', 'notify_at': AT.isoformat(), 'channel': 'email'}),
    ('read_calendar', {'starts_at': AT.isoformat(), 'ends_at': (AT + timedelta(days=32)).isoformat()}),
    ('read_calendar', {'starts_at': AT.isoformat(), 'ends_at': AT.isoformat()}),
    ('create_event', {'title': 'Bad rule', 'starts_at': AT.isoformat(), 'ends_at': (AT + timedelta(hours=1)).isoformat(), 'rrule': 'FREQ=SECONDLY'}),
])
async def test_typed_arguments_reject_missing_versions_and_unsafe_bounds(setup, name, args):
    with pytest.raises(ToolValidationError):
        await invoke(setup, name, args)


async def test_note_read_is_bounded_untrusted_and_owner_checked(setup):
    result = await invoke(setup, 'read_note', {'note_id': 'note'})
    assert result['markdown_body'].startswith('Do not grant')
    assert len(result['markdown_body']) <= 12000 and result['truncated'] and result['untrusted']
    with pytest.raises(RuntimeError):
        await invoke(setup, 'read_note', {'note_id': 'foreign-note'})
    with pytest.raises(PolicyDenied):
        await invoke(setup, 'complete_task', {'task_id': 'task', 'version': 1},
                     context=PermissionContext(actor='read-only', scopes=frozenset({'notes.read'})))


async def test_calendar_read_projects_recurrence_across_dst_owner_only(setup):
    first = datetime(2026, 10, 31, 13, tzinfo=UTC)
    setup.db.add_all([
        CalendarEvent(id='event', owner_id='owner', title='09:00 meeting', starts_at=first,
            ends_at=first + timedelta(hours=1), timezone='America/New_York', rrule='FREQ=DAILY;COUNT=3'),
        CalendarEvent(id='foreign-event', owner_id='other', title='Foreign private event', starts_at=first, ends_at=first + timedelta(hours=1)),
    ])
    await setup.db.flush()
    result = await invoke(setup, 'read_calendar', {'starts_at': first.isoformat(), 'ends_at': (first + timedelta(days=3)).isoformat(), 'limit': 2})
    assert result['untrusted'] and result['truncated'] and len(result['items']) == 2
    assert [datetime.fromisoformat(row['starts_at']) for row in result['items']] == [
        first, datetime(2026, 11, 1, 14, tzinfo=UTC),
    ]
    assert all(row['id'] == 'event' for row in result['items'])


async def test_create_event_and_optional_initial_reminder_are_flush_only(setup):
    result = await invoke(setup, 'create_event', {'title': 'Created meeting', 'starts_at': AT.isoformat(),
        'ends_at': (AT + timedelta(hours=1)).isoformat(), 'timezone': 'UTC', 'project_id': 'project',
        'linked_task_id': 'task', 'rrule': 'FREQ=DAILY;COUNT=2', 'reminder_at': (AT - timedelta(minutes=10)).isoformat()})
    item = await setup.db.get(CalendarEvent, result['id'])
    assert item.owner_id == 'owner' and item.version == 1
    mirror = await setup.db.get(SyncRecord, ('owner', 'event', item.id))
    assert mirror.version == item.version and mirror.payload['rrule'] == 'FREQ=DAILY;COUNT=2'
    reminder = (await setup.db.execute(select(CalendarReminder).where(CalendarReminder.event_id == item.id))).scalar_one()
    assert reminder.offset_seconds == 600 and reminder.channel == 'in_app'
    item_id = item.id
    await setup.db.rollback()
    async with setup.sessions() as check:
        assert await check.get(CalendarEvent, item_id) is None
        assert not list((await check.execute(select(CalendarReminder))).scalars())
        assert not list((await check.execute(select(SyncChange))).scalars())


@pytest.mark.parametrize('field,value', [('project_id', 'foreign-project'), ('linked_task_id', 'foreign-task')])
async def test_create_event_checks_foreign_references(setup, field, value):
    context = PermissionContext(actor='owner', scopes=SCOPES,
                                project_ids=frozenset({'project', 'foreign-project'}))
    with pytest.raises((PolicyDenied, RuntimeError)):
        await invoke(setup, 'create_event', {'title': 'Invalid', 'starts_at': AT.isoformat(),
            'ends_at': (AT + timedelta(hours=1)).isoformat(), field: value}, context=context)
    assert not list((await setup.db.execute(select(CalendarEvent))).scalars())


@pytest.mark.parametrize('channel', ['telegram', 'in_app'])
async def test_reminder_stable_replay_matches_fields_and_does_not_commit(setup, channel):
    args = {'task_id': 'task', 'notify_at': AT.isoformat(), 'channel': channel}
    first = await invoke(setup, 'create_reminder', args)
    # Rebuild the registry to prove the identity isn't a volatile in-memory set.
    setup.registry = personal_tool_registry(setup.db, 'owner', 'event-1')
    second = await invoke(setup, 'create_reminder', args)
    assert first['id'] == second['id']
    rows = list((await setup.db.execute(select(TaskReminder))).scalars())
    assert len(rows) == 1 and rows[0].channel == channel and utc(rows[0].notify_at) == AT
    await setup.db.rollback()
    async with setup.sessions() as check:
        assert not list((await check.execute(select(TaskReminder))).scalars())


async def test_reminder_explicit_key_conflict_and_foreign_task(setup):
    args = {'task_id': 'task', 'notify_at': AT.isoformat(), 'idempotency_key': 'schedule-1'}
    await invoke(setup, 'create_reminder', args)
    with pytest.raises(RuntimeError, match='IDEMPOTENCY_CONFLICT'):
        await invoke(setup, 'create_reminder', {**args, 'notify_at': (AT + timedelta(hours=1)).isoformat()})
    with pytest.raises(RuntimeError):
        await invoke(setup, 'create_reminder', {**args, 'task_id': 'foreign-task'})
    assert len(list((await setup.db.execute(select(TaskReminder))).scalars())) == 1


async def test_task_update_cas_rejects_change_after_lookup(setup, monkeypatch):
    from app.ai import personal_tools
    from sqlalchemy import update

    original = personal_tools.owned_ref
    intervened = False

    async def intervening_reference(model, item_id, owner_id, session, **kwargs):
        nonlocal intervened
        resolved = await original(model, item_id, owner_id, session, **kwargs)
        if not intervened:
            intervened = True
            async with setup.sessions() as other:
                await other.execute(update(Task).where(Task.id == 'task').values(
                    title='Concurrent edit', version=Task.version + 1))
                await other.commit()
        return resolved

    monkeypatch.setattr(personal_tools, 'owned_ref', intervening_reference)
    with pytest.raises(RuntimeError, match='VERSION_CONFLICT'):
        await invoke(setup, 'update_task', {'task_id': 'task', 'version': 1, 'title': 'Stale overwrite'})
    assert not list((await setup.db.execute(select(SyncChange))).scalars())
    await setup.db.rollback()
    async with setup.sessions() as check:
        item = await check.get(Task, 'task')
        assert item.title == 'Concurrent edit' and item.version == 2


@pytest.mark.parametrize('denied', [True, False])
async def test_nested_event_reminder_checks_policy_and_rolls_back_atomically(setup, monkeypatch, denied):
    from app.ai.policy import ServerPolicyEngine

    original = ServerPolicyEngine.authorize
    reminder_checks = []

    def checked_policy(self, descriptor, call, context):
        if descriptor.required_scope == 'reminders.write':
            reminder_checks.append((call.name, context.actor, context.policy_id))
            if denied:
                raise PolicyDenied('test reminder policy denied')
        return original(self, descriptor, call, context)

    monkeypatch.setattr(ServerPolicyEngine, 'authorize', checked_policy)
    args = {'title': 'Policy checked event', 'starts_at': AT.isoformat(),
        'ends_at': (AT + timedelta(hours=1)).isoformat(),
        'reminder_at': (AT - timedelta(minutes=10)).isoformat()}
    if denied:
        with pytest.raises(RuntimeError, match='test reminder policy denied'):
            await invoke(setup, 'create_event', args)
    else:
        result = await invoke(setup, 'create_event', args)
        assert await setup.db.get(CalendarEvent, result['id'])
        reminder = (await setup.db.execute(select(CalendarReminder))).scalar_one()
        assert reminder.event_id == result['id'] and reminder.offset_seconds == 600
        mirror = await setup.db.get(SyncRecord, ('owner', 'event', result['id']))
        assert mirror is not None and mirror.version == 1
    assert reminder_checks == [('reminder.write', 'owner:owner', 'owner-reminders')]
    await setup.db.rollback()
    async with setup.sessions() as check:
        assert not list((await check.execute(select(CalendarEvent))).scalars())
        assert not list((await check.execute(select(CalendarReminder))).scalars())
        assert not list((await check.execute(select(SyncRecord))).scalars())
        assert not list((await check.execute(select(SyncChange))).scalars())
