"""Telegram history through the personal registry, real worker, and trace endpoint."""
import json
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from app.ai import api as ai_api
from app.ai.errors import PolicyDenied, ToolValidationError
from app.ai.memory import remember
from app.ai.models import PermissionContext, ProviderKind, ToolCall, Usage
from app.ai.personal_tools import personal_tool_registry
from app.core.models import AIConversation, AIMessage, AIRun, AIRunEvent, Task, now
from app.integrations import telegram_personal_dialogue as dialogue
from app.integrations import telegram_service as service
from app.integrations.telegram_models import TelegramIntegration, TelegramPersonalJob
from sqlalchemy import select
from test_telegram_answer_trace import API, event, headers, signed
from test_telegram_media_dialogue import media_update
from test_telegram_personal import bound, ordinary
from test_telegram_personal_dialogue import Service, provider

pytest_plugins = ('test_telegram_business',)

NAME = 'read_chat_history'
SCOPE = 'chat.history.read'
AT = datetime(2026, 11, 17, 12, tzinfo=UTC)
HISTORY_INSTRUCTION = 'Read chat history only when the current question depends on earlier conversation.'


async def add_turn(db, integration, update_id, *, at=AT, conversation=None, channel='personal',
                   status='completed', legacy=False, refs=None, reply='Past Telegram answer', deleted=False):
    if conversation is None:
        conversation = AIConversation(owner_id=integration.owner_id, title='Telegram assistant',
                                      deleted_at=at if deleted else None)
        db.add(conversation)
        await db.flush()
    prompt = AIMessage(conversation_id=conversation.id, role='user', content=f'{channel} question {update_id}',
                       created_at=at)
    db.add(prompt)
    await db.flush()
    run = AIRun(owner_id=integration.owner_id, conversation_id=conversation.id, prompt_message_id=prompt.id,
                provider='claude', model='test', status=status, started_at=at,
                completed_at=at + timedelta(seconds=1) if status == 'completed' else None)
    db.add(run)
    await db.flush()
    if channel == 'personal':
        db.add(TelegramPersonalJob(owner_id=integration.owner_id, integration_id=integration.id,
                                   telegram_update_id=update_id, conversation_id=conversation.id,
                                   run_id=run.id, state='done' if status == 'completed' else status))
    answer = None
    if status == 'completed':
        answer = AIMessage(conversation_id=conversation.id, role='assistant', content=reply,
                           source_refs_json=refs or [], created_at=at + timedelta(seconds=1, microseconds=1))
        db.add(answer)
        await db.flush()
        if channel == 'personal':
            completion = event(run, 1, 'ai.run.completed', {'text_length': len(reply)})
            completion.created_at = at + timedelta(seconds=1, microseconds=2)
            if not legacy:
                completion.payload['reply_message_id'] = answer.id
            db.add(completion)
    await db.flush()
    return conversation, prompt, answer


def registry(db, integration, current=None, **kwargs):
    return personal_tool_registry(db, integration.owner_id, 'test', telegram_integration_id=integration.id,
                                  current_prompt_id=current.id if current else 'current', **kwargs)


async def read(tools, args, *, scopes=frozenset({SCOPE})):
    return await tools.invoke(ToolCall(NAME, args), PermissionContext(actor='test', scopes=scopes))


def period(start=AT, end=AT + timedelta(days=1)):
    return {'start_at': start.isoformat(), 'end_at': end.isoformat()}


async def test_history_checks_message_provenance_and_keeps_legacy_replies(setup):
    _, sessions, _, integration_id = await bound(setup)
    async with sessions.begin() as db:
        item = await db.get(TelegramIntegration, integration_id)
        old, legacy_prompt, legacy_reply = await add_turn(db, item, 1, legacy=True)
        _, web_question, _ = await add_turn(db, item, 2, at=AT + timedelta(seconds=2), conversation=old,
                                           channel='web', reply='Injected Web reply in Telegram conversation')
        db.add(AIMessage(conversation_id=old.id, role='assistant', content='Direct Web append'))
        _, modern_prompt, modern_reply = await add_turn(db, item, 3, at=AT + timedelta(hours=7))
        _, other_web, _ = await add_turn(db, item, 4, channel='web')
        _, business, _ = await add_turn(db, item, 5, channel='business')
        _, unfinished, _ = await add_turn(db, item, 6, status='running')
        _, deleted, _ = await add_turn(db, item, 7, deleted=True)
        _, current, _ = await add_turn(db, item, 8, at=AT + timedelta(hours=8), status='running')
        tools = registry(db, item, current)
        output = await read(tools, period())
        assert output['untrusted'] is True
        assert current.id not in [m['id'] for m in output['messages']]
        assert [m['id'] for m in output['messages'] if m['role'] == 'assistant'] == [modern_reply.id, legacy_reply.id]
        assert {modern_prompt.id, legacy_prompt.id} <= {m['id'] for m in output['messages']}
        missing = await read(tools, {'before_message_id': str(uuid4())})
        for prompt in (web_question, other_web, business, unfinished, deleted, current):
            assert await read(tools, {'before_message_id': prompt.id}) == missing
        assert 'error' in missing


async def test_history_stable_pages_across_filtered_records_and_timestamp_ties(setup):
    _, sessions, _, integration_id = await bound(setup)
    async with sessions.begin() as db:
        item = await db.get(TelegramIntegration, integration_id)
        _, tied_one, _ = await add_turn(db, item, 1)
        _, tied_two, _ = await add_turn(db, item, 2, reply='z' * 9000)
        refs = [{'kind': 'owner_memory_fact', 'id': 'missing', 'version': 1}]
        _, _, stale_reply = await add_turn(db, item, 3, at=AT + timedelta(hours=1), refs=refs)
        tools = registry(db, item)
        args = {**period(end=AT + timedelta(hours=2)), 'limit': 1}
        page = await read(tools, args)
        assert page['messages'] == []
        assert page['next_before_message_id'] == stale_reply.id
        seen = []
        for _ in range(6):
            cursor = page['next_before_message_id']
            if not cursor:
                break
            page = await read(tools, {**args, 'before_message_id': cursor})
            seen.extend(page['messages'])
        assert [m['id'] for m in seen if m['role'] == 'user'] == sorted([tied_one.id, tied_two.id], reverse=True)
        assert len(seen) == 4
        assert all(len(m['content']) <= 1200 for m in seen)
        excluded = await read(tools, period(start=AT - timedelta(days=1), end=AT))
        assert excluded['messages'] == []


@pytest.mark.parametrize('args', [
    {}, {'start_at': AT.isoformat()}, {'end_at': AT.isoformat(), 'before_message_id': 'abc'},
    {'start_at': '2026-11-17T01:00:00', 'end_at': AT.isoformat()}, period(end=AT),
    {**period(), 'limit': True}, {**period(), 'limit': 101}, {**period(), 'limit': 0},
])
async def test_history_rejects_invalid_arguments(setup, args):
    _, sessions, _, integration_id = await bound(setup)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        with pytest.raises(ToolValidationError):
            await read(registry(db, item), args)


async def test_history_requires_telegram_opt_in_and_policy_scope(setup):
    _, sessions, _, integration_id = await bound(setup)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        shared = personal_tool_registry(db, item.owner_id, 'web', memory_source='app_ai')
        assert NAME not in {schema['name'] for schema in shared.schemas()}
        tools = registry(db, item)
        with pytest.raises(PolicyDenied):
            await read(tools, period(), scopes=frozenset({'tasks.read'}))
        foreign = personal_tool_registry(db, 'another-owner', 'foreign', telegram_integration_id=item.id,
                                         current_prompt_id='current')
        assert 'error' in await read(foreign, period())


async def test_file_turn_omits_history_tool_and_instruction(setup, monkeypatch):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)

    async def get_file(self, file_id):
        return {'file_path': 'documents/input.txt'}

    async def download_file(self, path, max_bytes):
        return b'Test file content'

    monkeypatch.setattr(fake, 'get_file', get_file, raising=False)
    monkeypatch.setattr(fake, 'download_file', download_file, raising=False)
    model = Service()
    model.requests = []
    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: model)
    fake.updates = [media_update(kind='text')]
    await service.poll_once(integration_id, timeout=0)
    await dialogue.personal_iteration(integration_id)
    await dialogue.wait_for_personal_turns()
    [(messages, kwargs)] = model.requests
    assert not kwargs['tools']
    assert HISTORY_INSTRUCTION not in messages[0].content


@pytest.mark.parametrize('revoked,question_only', [(False, False), (True, False), (True, True)])
async def test_worker_history_provenance_trace_and_write(setup, monkeypatch, revoked, question_only):
    client, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    async with sessions.begin() as db:
        item = await db.get(TelegramIntegration, integration_id)
        fact = await remember(db, item.owner_id, 'Synthetic preference for cappuccino', source='api')
        fact_id, version, owner_id = fact.id, fact.version, item.owner_id
        _, question, answer = await add_turn(db, item, 10,
                                             refs=[{'kind': 'owner_memory_fact', 'id': fact_id, 'version': version}])
        past_prompt_id, past_question, past_reply_id = question.id, question.content, answer.id

    args = period(AT.astimezone(timezone(timedelta(hours=5))))
    if question_only:
        args.update(before_message_id=past_reply_id, limit=1)
    seen_context = []

    class Model(Service):
        calls = 0

        async def complete(self, run_id, request, messages, **kwargs):
            self.calls += 1
            seen_context.append(messages)
            assert NAME in {tool['name'] for tool in kwargs['tools']}
            assert messages[0].content.count(HISTORY_INSTRUCTION) == 1
            calls = ()
            if self.calls == 1:
                assert all(not message.memory_refs for message in messages)
                calls = ({'id': 'history', 'name': NAME, 'input': args},)
            elif self.calls == 2:
                history = next(m for m in messages if m.tool_call_id == 'history')
                assert history.untrusted
                assert fact_id not in history.content
                expected_ids = [past_prompt_id] if question_only else [past_reply_id, past_prompt_id]
                assert [m['id'] for m in json.loads(history.content)['messages']] == expected_ids
                if revoked:
                    from app.ai.memory_models import OwnerMemoryFact
                    async with sessions.begin() as db:
                        forgotten = await db.get(OwnerMemoryFact, fact_id)
                        forgotten.deleted_at = now()
                calls = ({'id': 'task', 'name': 'create_task', 'input': {'title': 'Follow up on earlier chat'}},)
            return SimpleNamespace(provider=ProviderKind.CLAUDE, model='test',
                                   response=SimpleNamespace(text='' if calls else 'Task created', tool_calls=calls),
                                   usage=SimpleNamespace(usage=Usage(), estimated_cost=Decimal(0)))

    model = Model()
    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: model)
    fake.updates = [ordinary(1, 'Create a task from what we discussed earlier')]
    await service.poll_once(integration_id, timeout=0)
    await dialogue.personal_iteration(integration_id)
    await dialogue.wait_for_personal_turns()
    assert model.calls == 3
    final_context = seen_context[2]
    expected_calls = [] if revoked else ['history', 'task']
    assert [call.call_id for message in final_context for call in message.tool_calls] == expected_calls
    assert [message.tool_call_id for message in final_context if message.role == 'tool'] == expected_calls
    if revoked:
        assert all(past_question not in message.content and 'Past Telegram answer' not in message.content
                   for message in final_context)
    history_context = next(message for message in seen_context[1] if message.tool_call_id == 'history')
    assert history_context.memory_refs == ((fact_id, version),)
    async with sessions() as db:
        task = await db.scalar(select(Task).where(Task.owner_id == owner_id))
        assert task and task.title == 'Follow up on earlier chat'
        job = await db.scalar(select(TelegramPersonalJob).where(TelegramPersonalJob.telegram_update_id == 1))
        assert job.state == 'done'
        events = (await db.scalars(select(AIRunEvent).where(AIRunEvent.run_id == job.run_id)
                                   .order_by(AIRunEvent.sequence))).all()
        history_events = [entry for entry in events if entry.payload.get('tool') == NAME]
        result = next(entry.payload['result'] for entry in history_events if entry.event_type == 'ai.tool.result')
        count = 1 if question_only else 2
        assert result == {'status': 'ok', 'count': count}
        wire = json.dumps([entry.payload for entry in history_events])
        assert 'Past Telegram answer' not in wire and past_question not in wire and fact_id not in wire
        assert past_prompt_id not in wire
        completed = events[-1].payload
        answer = await db.get(AIMessage, completed['reply_message_id'])
        assert {'kind': 'owner_memory_fact', 'id': fact_id, 'version': version} in answer.source_refs_json

        integration = await db.get(TelegramIntegration, integration_id)
        integration_token = service.decrypt_secret(integration.encrypted_token)
        telegram_id = integration.owner_telegram_id
    response = await client.get(f'{API}/{job.run_id}', headers=headers(signed(
        token=integration_token, user_id=telegram_id)))
    assert response.status_code == 200, response.text
    steps = response.json()['steps']
    history = next(step for step in steps if step['kind'] == NAME)
    assert history['status'] == 'completed'
    assert f'сообщений: {count}' in history['label']
    assert '2026-11-17T12:00:00' in history['query']
    assert 'Past Telegram answer' not in response.text
    assert bool(response.json()['memory_facts']) is not revoked
