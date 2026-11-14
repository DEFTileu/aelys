"""Regression: failed Web turns must not enter the next model request."""

import pytest
from test_ai_chat_design import chat, payloads, run


@pytest.mark.asyncio
async def test_failed_web_prompt_is_excluded_from_next_model_request(tmp_path, monkeypatch):
    async with chat(tmp_path, monkeypatch, [[{"type": "text", "text": "ok"}]]) as (client, script, _):
        conversation = await client.post('/api/v1/ai/conversations', json={'title': 'History'})
        conversation_id = conversation.json()['id']
        original_stream = script.stream

        async def failing_stream(*args, **kwargs):
            raise RuntimeError('provider unavailable')
            yield  # pragma: no cover

        script.stream = failing_stream
        failed = await run(client, conversation_id, 'Unanswered question', 'history-failed')
        assert payloads(failed, 'ai.run.failed')
        saved = await client.get(f'/api/v1/ai/conversations/{conversation_id}/messages')
        assert [(m['role'], m['content']) for m in saved.json()] == [('user', 'Unanswered question')]
        script.stream = original_stream
        completed = await run(client, conversation_id, 'New question', 'history-next')
        assert payloads(completed, 'ai.run.completed')
        sent = script.requests[-1]['messages']
        assert [(message['role'], message['content']) for message in sent] == [('user', 'New question')]


@pytest.mark.asyncio
async def test_tool_completion_race_does_not_save_answer_or_link_action(tmp_path, monkeypatch):
    from app.core.models import AIAction, AIMessage, AIRun
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession
    from test_ai_chat_design import tool_use

    async with chat(tmp_path, monkeypatch, [[tool_use('create_task', 't1', title='Proposed')], [{'type': 'text', 'text': 'Ready'}]]) as (client, _, factory):
        conversation = await client.post('/api/v1/ai/conversations', json={'title': 'Race', 'tool_scope': {'scopes': ['tasks.read']}})
        original = AsyncSession.execute
        async def race(db, statement, *args, **kwargs):
            if getattr(getattr(statement, 'table', None), 'name', None) == 'ai_runs' and hasattr(statement, '_values') and statement._values:
                values = {getattr(k, 'key', k): getattr(v, 'value', None) for k, v in statement._values.items()}
                if values.get('status') == 'completed':
                    await original(db, AIRun.__table__.update().where(AIRun.id == run_id).values(status='cancelled'))
                    await db.commit()
            return await original(db, statement, *args, **kwargs)
        created = await client.post('/api/v1/ai/runs', json={'conversation_id': conversation.json()['id'], 'message': 'Create a task', 'idempotency_key': 'race', 'routing': {'provider': 'claude', 'model': 'chat-model'}})
        run_id = created.json()['id']
        monkeypatch.setattr(AsyncSession, 'execute', race)
        events = await client.get(f'/api/v1/ai/runs/{run_id}/events')
        assert 'ai.run.cancelled' in events.text and 'ai.run.completed' not in events.text
        async with factory() as db:
            assert not (await db.scalars(select(AIMessage).where(AIMessage.role == 'assistant'))).all()
            actions = (await db.scalars(select(AIAction).where(AIAction.run_id == run_id))).all()
            assert actions and all(action.message_id is None for action in actions)


@pytest.mark.asyncio
@pytest.mark.parametrize('old_status,keep', [('running', False), ('failed', False), ('completed', True), (None, True)])
async def test_web_history_filters_prior_runs(tmp_path, monkeypatch, old_status, keep):
    from datetime import timedelta

    from app.core.models import AIConversation, AIMessage, AIRun, now

    async with chat(tmp_path, monkeypatch, [[{'type': 'text', 'text': 'ok'}]]) as (client, script, factory):
        conversation = (await client.post('/api/v1/ai/conversations', json={'title': 'History'})).json()
        async with factory() as db:
            owner = (await db.get(AIConversation, conversation['id'])).owner_id
            old = AIMessage(conversation_id=conversation['id'], role='user', content='Old prompt', created_at=now()-timedelta(minutes=1))
            db.add(old); await db.flush()
            if old_status:
                db.add(AIRun(owner_id=owner, conversation_id=conversation['id'], prompt_message_id=old.id, provider='claude', model='test', status=old_status))
            await db.commit()
        await run(client, conversation['id'], 'New prompt', 'next')
        contents = [m['content'] for m in script.requests[-1]['messages']]
        assert ('Old prompt' in contents) is keep
        assert contents[-1] == 'New prompt'


@pytest.mark.asyncio
async def test_retry_and_regenerate_keep_completed_prompt(tmp_path, monkeypatch):
    async with chat(tmp_path, monkeypatch, [[{'type': 'text', 'text': 'answer'}]]) as (client, script, _):
        conversation = (await client.post('/api/v1/ai/conversations', json={'title': 'History'})).json()['id']
        original = script.stream
        async def failing(*args, **kwargs):
            raise RuntimeError('unavailable')
            yield
        script.stream = failing
        assert payloads(await run(client, conversation, 'Question', 'fail'), 'ai.run.failed')
        script.stream = original
        assert payloads(await run(client, conversation, 'Question', 'retry'), 'ai.run.completed')
        assert [m['content'] for m in script.requests[-1]['messages']] == ['Question']
        assert payloads(await run(client, conversation, 'Question', 'regenerate'), 'ai.run.completed')
        assert [m['content'] for m in script.requests[-1]['messages']] == ['Question', 'answer', 'Question']


@pytest.mark.asyncio
async def test_history_keeps_completed_and_unlinked_turns_and_trust_flags(tmp_path, monkeypatch):
    from datetime import timedelta

    from app.ai.chat_support import conversation_history
    from app.core.models import AIConversation, AIMessage, AIRun, now

    async with chat(tmp_path, monkeypatch, [[{'type': 'text', 'text': 'ok'}]]) as (client, _, factory):
        cid = (await client.post('/api/v1/ai/conversations', json={'title': 'History'})).json()['id']
        async with factory() as db:
            owner = (await db.get(AIConversation, cid)).owner_id
            old = AIMessage(conversation_id=cid, role='user', content='earlier', source_refs_json=[{'untrusted': True}], created_at=now()-timedelta(seconds=4))
            answer = AIMessage(conversation_id=cid, role='assistant', content='answer', created_at=now()-timedelta(seconds=3))
            pending = AIMessage(conversation_id=cid, role='user', content='pending', created_at=now()-timedelta(seconds=2))
            current = AIMessage(conversation_id=cid, role='user', content='current', created_at=now()-timedelta(seconds=1))
            db.add_all([old, answer, pending, current]); await db.flush()
            db.add(AIRun(owner_id=owner, conversation_id=cid, prompt_message_id=pending.id, provider='claude', model='test', status='running'))
            await db.commit()
            web = await conversation_history(db, owner, cid, current, limit=100)
            telegram = await conversation_history(db, owner, cid, current, limit=20)
            assert web == telegram
            assert [(m.role, m.content, m.untrusted) for m in web] == [('user', 'earlier', True), ('assistant', 'answer', False), ('user', 'current', False)]
