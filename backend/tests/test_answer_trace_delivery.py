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


def entity_text(text, entity):
    start = 2 * entity['offset']
    end = start + 2 * entity['length']
    return text.encode('utf-16-le')[start:end].decode('utf-16-le')


@pytest.mark.parametrize(('answer', 'visible'), [
    ('Ответ', 'Ответ'),
    ('x' * 9000, 'x' * 9000),
    ('x' * 4096, 'x' * 4096),
    ('😀 **Жауап**', '😀 Жауап'),
], ids=['short', 'overflow', 'full-tail', 'formatted'])
async def test_answer_trace_link_is_delivered_whole_with_previews_disabled(setup, monkeypatch, answer, visible):
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
        method = request.url.path.rsplit('/', 1)[-1]
        assert method in {'sendMessage', 'editMessageText'}
        if method == 'editMessageText':
            async with sessions() as db:
                run = (await db.scalars(select(AIRun))).one()
                saved = (await db.scalars(select(AIMessage).where(AIMessage.role == 'assistant'))).one()
                assert run.status == 'completed'
                assert saved.content == answer
        sent.append((method, json.loads(request.content)))
        return httpx.Response(200, json={'ok': True, 'result': {'message_id': 1}})

    with monkeypatch.context() as send_mock:
        send_mock.setattr(service, 'TelegramClient', lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
        await _finish_turn(integration_id)

    async with sessions() as db:
        run = (await db.scalars(select(AIRun))).one()
    link = f'https://t.me/trace_delivery_test_bot?startapp=run__{run.id}'
    [(first_method, initial), (last_method, final)] = sent
    assert (first_method, last_method) == ('sendMessage', 'editMessageText')
    assert final['message_id'] == 1 and initial['chat_id'] == final['chat_id']
    assert initial['reply_markup']['inline_keyboard'][0][0]['text'] == 'Остановить'
    assert final['reply_markup'] == {'inline_keyboard': []}
    label = 'Как я ответил'
    for payload in (initial, final):
        text = payload['text']
        assert text.splitlines()[-1] == label
        assert 1 <= len(text.encode('utf-16-le')) // 2 <= 4096
        assert link not in text
        assert payload['link_preview_options'] == {'is_disabled': True} and 'parse_mode' not in payload
        [entity] = [entity for entity in payload['entities'] if entity['type'] == 'text_link']
        assert entity['url'] == link and entity_text(text, entity) == label
    if visible == '😀 Жауап':
        assert final['entities'][0] == {'type': 'bold', 'offset': 3, 'length': 5}
    if len(visible.encode('utf-16-le')) // 2 + 2 + len(label) <= 4096:
        assert final['text'] == f'{visible}\n\n{label}'
    else:
        prefix, notice, footer = final['text'].split('\n\n')
        assert prefix.endswith('…') and visible.startswith(prefix.removesuffix('…'))
        assert notice == 'Полный ответ — в MiniApp по ссылке «Как я ответил».'
        assert footer == label

    fake.updates = [ordinary(2, 'Следующий вопрос')]
    await service.poll_once(integration_id, timeout=0)
    await _finish_turn(integration_id)
    assert [message.content for message in model.requests[1][0] if message.role == 'assistant'] == [answer]
    assert all(link not in message.content for message in model.requests[1][0])


async def test_final_edit_timeout_keeps_trace_on_the_only_sent_message(setup, monkeypatch):
    from app.core.models import Notification
    from app.integrations.telegram_transport import TelegramError

    client, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    model = Service()
    model.requests = []
    answer = '**' + 'ж' * 9000 + '**'
    model.response = SimpleNamespace(text=answer, tool_calls=())
    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: model)
    edits = []

    async def edit(self, chat_id, message_id, text, **kwargs):
        edits.append((chat_id, message_id, text, kwargs))
        raise TelegramError('timeout')

    monkeypatch.setattr(fake, 'edit_message_text', edit, raising=False)
    fake.updates = [ordinary(1, 'Длинный ответ')]
    await service.poll_once(integration_id, timeout=0)
    await _finish_turn(integration_id)
    await _finish_turn(integration_id)
    assert len(edits) == 2 and edits[0] == edits[1]
    assert edits[0][1] == 500 and 'Полный ответ' in edits[0][2]
    [(chat_id, status, options)] = fake.sent
    assert chat_id == edits[0][0] == OWNER
    [trace] = [e for e in options['entities'] if e['type'] == 'text_link']
    assert entity_text(status, trace) == 'Как я ответил'
    assert len(model.requests) == 1
    async with sessions() as db:
        run = (await db.scalars(select(AIRun))).one()
        assert run.status == 'completed'
        notice = (await db.scalars(select(Notification).where(
            Notification.kind == 'telegram.personal.delivery',
        ))).one()
        assert notice.body is None
    [start_param] = parse_qs(urlsplit(trace['url']).query)['startapp']
    assert start_param == f'run__{run.id}'
    response = await client.get(
        f'/api/v1/telegram/answer-trace/{run.id}',
        headers=headers(signed(token=TOKEN, user_id=OWNER, start_param=start_param)),
    )
    assert response.status_code == 200
    assert response.json()['answer'] == answer


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

    edits = []

    async def edit(self, chat_id, message_id, text, **kwargs):
        edits.append((chat_id, message_id, text, kwargs))
        return {'message_id': message_id}

    monkeypatch.setattr(fake, 'edit_message_text', edit, raising=False)
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
    assert len(fake.sent) == 1
    [(_, _, delivered, options)] = edits
    assert delivered == f'{reply.content}\n\nКак я ответил'
    trace, = options['entities']
    assert entity_text(delivered, trace) == 'Как я ответил'
    start_param, = parse_qs(urlsplit(trace['url']).query)['startapp']
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

    original_send = fake.send_message

    async def send_working_status(self, chat_id, text, **kwargs):
        if revoke_at == 'before_first_call':
            assert kwargs['reply_markup']['inline_keyboard'][0][0]['text'] == 'Остановить'
            await revoke_fact()
        return await original_send(self, chat_id, text, **kwargs)

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
    monkeypatch.setattr(fake, 'send_message', send_working_status)
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
