"""Answer trace coverage at the personal Telegram worker's delivery and event boundaries."""
import json
from datetime import timedelta
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from app.ai import api as ai_api
from app.ai.memory import forget, remember
from app.core.models import AIConversation, AIMessage, AIRun, AIRunEvent, now
from app.integrations import telegram_personal_dialogue as dialogue
from app.integrations import telegram_service as service
from app.integrations.telegram_models import TelegramIntegration
from app.integrations.telegram_transport import TelegramClient
from sqlalchemy import select
from test_telegram_answer_trace import headers, signed
from test_telegram_business import OWNER, TOKEN
from test_telegram_personal import bound, ordinary
from test_telegram_personal_dialogue import Service, provider

pytest_plugins = ('test_telegram_business',)


async def _finish_turn(integration_id):
    await dialogue.personal_iteration(integration_id)
    await dialogue.wait_for_personal_turns()


@pytest.mark.parametrize('answer', ['Ответ', 'x' * 9000, 'x' * 4075], ids=['short', 'split', 'full-tail'])
async def test_answer_trace_link_is_delivered_whole_with_previews_disabled(setup, monkeypatch, answer):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    async with sessions() as db:
        integration = await db.get(TelegramIntegration, integration_id)
        integration.bot_username = 'trace_delivery_test_bot'
        await db.commit()

    model = Service()
    model.requests = []
    model.response = SimpleNamespace(text=answer, tool_calls=())
    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: model)
    fake.updates = [ordinary(1, 'Первый вопрос')]
    await service.poll_once(integration_id, timeout=0)
    sent = []

    async def telegram(request):
        if request.url.path.endswith('/sendMessage'):
            async with sessions() as db:
                run = (await db.scalars(select(AIRun))).one()
                saved = (await db.scalars(select(AIMessage).where(AIMessage.role == 'assistant'))).one()
                assert run.status == 'completed'
                assert saved.content == answer
            sent.append(json.loads(request.content))
        return httpx.Response(200, json={'ok': True, 'result': {'message_id': 1}})

    with monkeypatch.context() as send_mock:
        send_mock.setattr(service, 'TelegramClient', lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
        await _finish_turn(integration_id)

    async with sessions() as db:
        run = (await db.scalars(select(AIRun))).one()
    link = f'https://t.me/trace_delivery_test_bot?startapp=run__{run.id}'
    texts = [payload['text'] for payload in sent]
    assert texts[-1].splitlines()[-1] == link
    assert all(1 <= len(text) <= 4096 for text in texts)
    assert all(payload['link_preview_options'] == {'is_disabled': True} for payload in sent)
    assert ''.join(texts).removesuffix(link).rstrip('\n') == answer
    if len(answer) < 4096 - len(link) - 2:
        assert texts == [f'{answer}\n\n{link}']

    fake.updates = [ordinary(2, 'Следующий вопрос')]
    await service.poll_once(integration_id, timeout=0)
    await _finish_turn(integration_id)
    assert [message.content for message in model.requests[1][0] if message.role == 'assistant'] == [answer]
    assert all(link not in message.content for message in model.requests[1][0])


async def test_sent_trace_resolves_memory_inherited_from_the_exact_saved_reply(setup, monkeypatch):
    client, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    fact_text = 'Предпочитаю капучино'
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        fact = await remember(db, item.owner_id, fact_text)
        fact_id, version = fact.id, fact.version
        conversation = AIConversation(owner_id=item.owner_id, title='Telegram assistant')
        db.add(conversation)
        await db.flush()
        item.personal_conversation_id = conversation.id
        db.add_all([
            AIMessage(conversation_id=conversation.id, role='user', content='Что выбрать?',
                      created_at=now() - timedelta(minutes=2)),
            AIMessage(conversation_id=conversation.id, role='assistant', content='Выбери капучино',
                      source_refs_json=[{'kind': 'owner_memory_fact', 'id': fact_id, 'version': version}],
                      created_at=now() - timedelta(minutes=1)),
        ])
        await db.commit()

    model = Service()
    model.requests = []
    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: model)
    fake.updates = [ordinary(1, 'Продолжим?')]
    await service.poll_once(integration_id, timeout=0)
    await _finish_turn(integration_id)

    async with sessions() as db:
        run = (await db.scalars(select(AIRun))).one()
        prompt = await db.get(AIMessage, run.prompt_message_id)
        reply = (await db.scalars(select(AIMessage).where(
            AIMessage.role == 'assistant', AIMessage.content == 'Ответ',
        ))).one()
        completed = (await db.scalars(select(AIRunEvent).where(
            AIRunEvent.run_id == run.id, AIRunEvent.event_type == 'ai.run.completed',
        ))).one()
    assert all(ref['kind'] != 'owner_memory_fact' for ref in prompt.source_refs_json)
    assert reply.source_refs_json == [{'kind': 'owner_memory_fact', 'id': fact_id, 'version': version}]
    reply_text, link = fake.sent[-1][1].rsplit('\n\n', 1)
    assert reply_text == reply.content
    start_param, = parse_qs(urlsplit(link).query)['startapp']
    assert start_param == f'run__{run.id}'
    response = await client.get(
        f'/api/v1/telegram/answer-trace/{start_param.removeprefix("run__")}',
        headers=headers(signed(token=TOKEN, user_id=OWNER, start_param=start_param)),
    )
    assert response.status_code == 200
    assert response.json()['memory_facts'] == [{'id': fact_id, 'text': fact_text, 'version': version}]
    assert completed.payload['reply_message_id'] == reply.id


@pytest.mark.parametrize('revoke_at,first_count,final_count', [
    ('never', 2, 2),
    ('before_first_call', 0, 0),
    ('between_calls', 2, 0),
])
async def test_started_and_completed_count_only_prior_messages_used_by_model(
    setup, monkeypatch, revoke_at, first_count, final_count,
):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        owner_id = item.owner_id
        fact = await remember(db, owner_id, 'Предпочитаю капучино')
        fact_id, fact_version = fact.id, fact.version
        conversation = AIConversation(owner_id=owner_id, title='Telegram assistant')
        db.add(conversation)
        await db.flush()
        item.personal_conversation_id = conversation.id
        db.add_all([
            AIMessage(conversation_id=conversation.id, role='user', content='Что выбрать?',
                      created_at=now() - timedelta(minutes=2)),
            AIMessage(conversation_id=conversation.id, role='assistant', content='Выбери капучино',
                      source_refs_json=[{'kind': 'owner_memory_fact', 'id': fact_id, 'version': fact_version}],
                      created_at=now() - timedelta(minutes=1)),
        ])
        await db.commit()

    async def revoke_fact():
        async with sessions() as db:
            await forget(db, owner_id, fact_id=fact_id)
            await db.commit()

    async def send_chat_action(self, chat_id, action):
        if revoke_at == 'before_first_call':
            await revoke_fact()

    class Model(Service):
        async def complete(self, *args, **kwargs):
            if not self.requests:
                self.response = SimpleNamespace(
                    text='', tool_calls=({'id': 'list', 'name': 'list_tasks', 'input': {}},),
                )
                if revoke_at == 'between_calls':
                    await revoke_fact()
            else:
                self.response = SimpleNamespace(text='Ответ', tool_calls=())
            return await super().complete(*args, **kwargs)

    model = Model()
    model.requests = []
    monkeypatch.setattr(fake, 'send_chat_action', send_chat_action, raising=False)
    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: model)
    fake.updates = [ordinary(1, 'Что насчёт капучино?', reply_to_message={'text': 'Цитата'})]
    await service.poll_once(integration_id, timeout=0)
    await _finish_turn(integration_id)

    first_messages, final_messages = (request[0] for request in model.requests)
    assert any(message.content == 'Что насчёт капучино?' for message in first_messages)
    assert any(message.content == 'Цитата' for message in first_messages)
    # Revoking memory used by a completion removes its tool request and matching result.
    expected_tool_ids = [] if revoke_at == 'between_calls' else ['list']
    assert [call.call_id for message in final_messages for call in message.tool_calls] == expected_tool_ids
    assert [message.tool_call_id for message in final_messages if message.role == 'tool'] == expected_tool_ids
    for messages, expected_count in ((first_messages, first_count), (final_messages, final_count)):
        prior = [message.content for message in messages if message.content in {'Что выбрать?', 'Выбери капучино'}]
        assert prior == (['Что выбрать?', 'Выбери капучино'] if expected_count == 2 else [])

    async with sessions() as db:
        events = {event.event_type: event.payload for event in (await db.scalars(select(AIRunEvent))).all()}
        if revoke_at == 'never':
            reply = (await db.scalars(select(AIMessage).where(AIMessage.content == 'Ответ'))).one()
            assert reply.source_refs_json == [{'kind': 'owner_memory_fact', 'id': fact_id, 'version': fact_version}]
    assert events['ai.run.started']['history_message_count'] == first_count
    completed = events['ai.run.completed']
    if first_count != final_count:
        assert completed['history_message_count'] == final_count
    else:
        assert 'history_message_count' not in completed
