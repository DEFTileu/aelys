"""Shared action service preserves generic tools, atomic outcomes and expiry."""
from datetime import UTC, datetime, timedelta

import pytest
from app.core.models import (
    AIAction,
    AIConversation,
    AIRun,
    CalendarEvent,
    Note,
    Task,
    TaskReminder,
    User,
)
from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker


async def seed(factory, *, tool='create_task', arguments=None, expires_at=None, sourced=False):
    async with factory() as db:
        owner = User(email='actions@example.test', password_hash='test')
        db.add(owner)
        await db.flush()
        conversation = AIConversation(owner_id=owner.id)
        db.add(conversation)
        await db.flush()
        run = AIRun(owner_id=owner.id, conversation_id=conversation.id, provider='claude', model='test', status='completed')
        db.add(run)
        await db.flush()
        action = AIAction(owner_id=owner.id, conversation_id=conversation.id, run_id=run.id,
                          tool=tool, arguments_json=arguments or {'title': 'Review document'}, title='Proposed change')
        if sourced:
            action.source_kind = 'telegram_business'
            action.source_id = '00000000-0000-0000-0000-000000000001'
        if expires_at is not None:
            action.expires_at = expires_at
        db.add(action)
        await db.commit()
        return owner.id, action.id


async def test_service_creates_once_and_returns_same_stored_result(ai_test_engine):
    from app.ai.actions import approve_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, sourced=True)
    async with factory() as db:
        before = await db.scalar(select(func.count()).select_from(Task))
        assert before == 0
        first = await approve_action(db, owner_id, action_id)
        task_id = first.result_json['id']
        second = await approve_action(db, owner_id, action_id)
        assert first.status == second.status == 'approved'
        assert second.result_json['id'] == task_id
        assert await db.scalar(select(func.count()).select_from(Task)) == 1
        assert (await db.get(Task, task_id)).title == 'Review document'


@pytest.mark.parametrize('tool', ['create_note', 'update_task', 'complete_task', 'create_reminder', 'create_event'])
async def test_service_supports_existing_non_creation_tools(ai_test_engine, tool):
    from app.ai.actions import approve_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, tool=tool)
    async with factory() as db:
        task = Task(owner_id=owner_id, title='Original')
        db.add(task)
        await db.flush()
        args = {'title': 'Owner note', 'markdown_body': 'A useful note'}
        if tool in ('update_task', 'complete_task'):
            args = {'task_id': task.id, 'version': task.version}
            if tool == 'update_task':
                args['title'] = 'Updated'
        elif tool == 'create_reminder':
            args = {'task_id': task.id, 'notify_at': (datetime.now(UTC)+timedelta(hours=2)).isoformat()}
        elif tool == 'create_event':
            args = {'title': 'Meeting', 'starts_at': '2026-11-14T10:00:00+05:00',
                    'ends_at': '2026-11-14T11:00:00+05:00', 'timezone': 'Asia/Almaty'}
        action = await db.get(AIAction, action_id)
        action.arguments_json = args
        await db.commit()
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'approved', result.result_json
        if tool == 'create_note':
            assert (await db.get(Note, result.result_json['id'])).markdown_body == 'A useful note'
        elif tool == 'update_task':
            await db.refresh(task)
            assert task.title == 'Updated'
        elif tool == 'complete_task':
            await db.refresh(task)
            assert task.status == 'completed'
        elif tool == 'create_reminder':
            assert await db.scalar(select(func.count()).select_from(TaskReminder)) == 1
        else:
            assert (await db.get(CalendarEvent, result.result_json['id'])).title == 'Meeting'


async def test_expired_action_fails_durably_without_creating_task(ai_test_engine):
    from app.ai.actions import approve_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, expires_at=datetime.now(UTC)-timedelta(seconds=1), sourced=True)
    async with factory() as db:
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'failed' and result.result_json['error']['code'] == 'ACTION_EXPIRED'
        assert await db.scalar(select(func.count()).select_from(Task)) == 0
        assert (await approve_action(db, owner_id, action_id)).result_json == result.result_json


async def test_invalidated_source_status_is_not_reexecuted(ai_test_engine):
    from app.ai.actions import approve_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, sourced=True)
    async with factory() as invalidator:
        await invalidator.execute(update(AIAction).where(AIAction.id == action_id, AIAction.status == 'pending').values(
            status='failed', result_json={'error': {'code': 'ACTION_SOURCE_STALE'}}))
        await invalidator.commit()
    async with factory() as db:
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'failed' and result.result_json['error']['code'] == 'ACTION_SOURCE_STALE'
        assert await db.scalar(select(func.count()).select_from(Task)) == 0


async def test_rejection_and_foreign_owner_keep_action_unexecuted(ai_test_engine):
    from app.ai.actions import approve_action, reject_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory)
    async with factory() as db:
        for operation in (approve_action, reject_action):
            with pytest.raises(HTTPException) as denied:
                await operation(db, 'foreign-owner', action_id)
            assert denied.value.status_code == 404
        assert (await reject_action(db, owner_id, action_id)).status == 'rejected'
        assert (await reject_action(db, owner_id, action_id)).status == 'rejected'
        with pytest.raises(HTTPException) as denied:
            await approve_action(db, owner_id, action_id)
        assert denied.value.detail['code'] == 'ACTION_REJECTED'
        assert await db.scalar(select(func.count()).select_from(Task)) == 0


async def test_invalid_tool_arguments_fail_without_partial_mutation(ai_test_engine):
    from app.ai.actions import approve_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, arguments={'title': ''})
    async with factory() as db:
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'failed' and result.result_json['error']['code'] == 'VALIDATION_ERROR'
        assert await db.scalar(select(func.count()).select_from(Task)) == 0


async def test_partial_domain_write_rolls_back_with_failed_action(ai_test_engine, monkeypatch):
    from app.ai import personal_tools
    from app.ai.actions import approve_action
    from app.ai.personal_tools import personal_tool_registry
    from app.core.models import SyncChange
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory)

    def failing_registry(*args, **kwargs):
        registry = personal_tool_registry(*args, **kwargs)
        original = registry.descriptor('create_task').handler

        async def fail_after_flush(arguments):
            await original(arguments)
            raise RuntimeError('simulated failure after domain flush')

        registry.descriptor('create_task').handler = fail_after_flush
        return registry

    monkeypatch.setattr(personal_tools, 'personal_tool_registry', failing_registry)
    async with factory() as db:
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'failed' and result.result_json['error']['code'] == 'TOOL_ERROR'
        assert await db.scalar(select(func.count()).select_from(Task)) == 0
        assert await db.scalar(select(func.count()).select_from(SyncChange).where(SyncChange.resource_kind == 'task')) == 0


async def test_parallel_postgres_approvals_create_one_domain_result(ai_test_engine):
    import asyncio

    from app.ai.actions import approve_action
    from app.core.models import SyncChange
    if ai_test_engine.dialect.name != 'postgresql':
        pytest.skip('Real PostgreSQL row-lock contention contract')
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory)

    async def approve():
        async with factory() as db:
            result = await approve_action(db, owner_id, action_id)
            return result.status, result.result_json

    results = await asyncio.gather(approve(), approve(), approve())
    assert all(status == 'approved' for status, _ in results)
    assert len({result['id'] for _, result in results}) == 1
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(Task)) == 1
        assert await db.scalar(select(func.count()).select_from(SyncChange).where(SyncChange.resource_kind == 'task')) == 1


@pytest.mark.parametrize('first', ['reject', 'invalidate'])
async def test_postgres_terminal_action_wins_against_waiting_approval(ai_test_engine, first, monkeypatch):
    import asyncio

    from app.ai.actions import approve_action
    if ai_test_engine.dialect.name != 'postgresql':
        pytest.skip('Real PostgreSQL row-lock contention contract')
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, sourced=True)
    async with factory() as blocker:
        await blocker.execute(update(AIAction).where(AIAction.id == action_id, AIAction.status == 'pending').values(
            status='rejected' if first == 'reject' else 'failed',
            result_json={} if first == 'reject' else {'error': {'code': 'ACTION_SOURCE_STALE'}}))
        started = asyncio.Event()
        from sqlalchemy.ext.asyncio import AsyncSession
        from sqlalchemy.sql.dml import Update
        original_execute = AsyncSession.execute

        async def execute(db, statement, *args, **kwargs):
            if isinstance(statement, Update) and statement.table.name == 'ai_actions' and statement.compile().params.get('status') == 'approved':
                started.set()
            return await original_execute(db, statement, *args, **kwargs)

        monkeypatch.setattr(AsyncSession, 'execute', execute)

        async def approve():
            async with factory() as db:
                # Read committed sees the prior pending action before it waits on CAS.
                row = await db.get(AIAction, action_id)
                assert row.status == 'pending'
                return await approve_action(db, owner_id, action_id)

        waiting = asyncio.create_task(approve())
        await asyncio.wait_for(started.wait(), 5)
        await blocker.commit()
        result = await asyncio.wait_for(waiting, 10)
        assert result.status == ('rejected' if first == 'reject' else 'failed')
        if first == 'invalidate':
            assert result.result_json['error']['code'] == 'ACTION_SOURCE_STALE'
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(Task)) == 0


async def test_postgres_expiry_during_claim_lock_wait_blocks_execution(ai_test_engine, monkeypatch):
    import asyncio

    from app.ai.actions import approve_action
    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.sql.dml import Update
    if ai_test_engine.dialect.name != 'postgresql':
        pytest.skip('Real PostgreSQL row-lock expiry contract')
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    expires_at = datetime.now(UTC) + timedelta(seconds=1)
    owner_id, action_id = await seed(factory, expires_at=expires_at)
    original_execute = AsyncSession.execute
    claim_started = asyncio.Event()

    async def execute(db, statement, *args, **kwargs):
        if isinstance(statement, Update) and statement.table.name == 'ai_actions' and statement.compile().params.get('status') == 'approved':
            claim_started.set()
        return await original_execute(db, statement, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, 'execute', execute)
    async with factory() as blocker:
        await blocker.execute(update(AIAction).where(AIAction.id == action_id).values(status='pending'))

        async def approve():
            async with factory() as db:
                return await approve_action(db, owner_id, action_id)

        waiting = asyncio.create_task(approve())
        await asyncio.wait_for(claim_started.wait(), 5)
        # Hold only this fixture's row lock beyond the known expiry boundary.
        await asyncio.sleep(max(0, (expires_at-datetime.now(UTC)).total_seconds())+0.05)
        await blocker.commit()
        result = await asyncio.wait_for(waiting, 10)
        assert result.status == 'failed' and result.result_json['error']['code'] == 'ACTION_EXPIRED'
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(Task)) == 0


async def test_unexpired_action_executes_before_deadline(ai_test_engine):
    from app.ai.actions import approve_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, expires_at=datetime.now(UTC)+timedelta(hours=24))
    async with factory() as db:
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'approved'
        assert (await db.get(Task, result.result_json['id'])).title == 'Review document'


async def test_unregistered_tool_fails_without_domain_write(ai_test_engine):
    from app.ai.actions import approve_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, tool='unregistered_write')
    async with factory() as db:
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'failed' and result.result_json['error']['code'] == 'VALIDATION_ERROR'
        assert await db.scalar(select(func.count()).select_from(Task)) == 0


async def test_policy_denial_cannot_execute_action(ai_test_engine, monkeypatch):
    from app.ai import personal_tools
    from app.ai.actions import approve_action
    from app.ai.personal_tools import personal_tool_registry
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory)

    def external_registry(*args, **kwargs):
        registry = personal_tool_registry(*args, **kwargs)
        # The real server policy must refuse external effects even on approval.
        registry.descriptor('create_task').external_effect = True
        return registry

    monkeypatch.setattr(personal_tools, 'personal_tool_registry', external_registry)
    async with factory() as db:
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'failed' and result.result_json['error']['code'] == 'POLICY_DENIED'
        assert await db.scalar(select(func.count()).select_from(Task)) == 0


async def test_unavailable_project_cannot_create_task(ai_test_engine):
    from app.ai.actions import approve_action
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    owner_id, action_id = await seed(factory, arguments={'title': 'Blocked', 'project_id': 'missing-project'})
    async with factory() as db:
        result = await approve_action(db, owner_id, action_id)
        assert result.status == 'failed' and result.result_json['error']['code'] == 'TOOL_ERROR'
        assert await db.scalar(select(func.count()).select_from(Task)) == 0
