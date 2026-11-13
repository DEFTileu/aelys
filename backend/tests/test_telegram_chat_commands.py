"""Owner-issued ask/search commands use the existing Business send boundary."""
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from app.ai import api as ai_api
from app.ai.crypto import encrypt_secret
from app.ai.models import ProviderKind
from app.core.models import AIMessage, AIProvider, AIProviderSecret, AIRun
from app.integrations import telegram_models
from app.integrations import telegram_service as service
from sqlalchemy import select, text
from test_telegram_business import CUSTOMER, OWNER, PREFIX, ingest, message
from test_telegram_chat_send import ready

pytest_plugins = ('test_telegram_business',)


def command_update(content='/ask что такое Elasticsearch', *, update_id=3, message_id=21, quote=None, reply=None, **patch):
    update = message(update_id, content, sender=OWNER, message_id=message_id)
    raw = update['business_message']
    if quote is not None:
        raw['quote'] = {'text': quote, 'position': 0, 'is_manual': True}
    if reply is not None:
        raw['reply_to_message'] = {'message_id': 7, 'from': {'id': CUSTOMER}, 'chat': raw['chat'], 'text': reply}
    raw.update(patch)
    return update


async def configured(setup, monkeypatch):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    async with sessions() as db:
        integration = await db.get(telegram_models.TelegramIntegration, integration_id)
        db.add(AIProvider(id='commands-provider', owner_id=integration.owner_id, kind='claude', enabled=True,
                          model_policy_json={'monthly_budget': '20'}))
        db.add(AIProviderSecret(provider_id='commands-provider', owner_id=integration.owner_id,
                                encrypted_value=encrypt_secret('synthetic-command-provider-key')))
        integration.provider_id = 'commands-provider'
        integration.model = 'test-model'
        integration.auto_reply = False
        await db.commit()
    calls = []
    result = SimpleNamespace(provider=ProviderKind.CLAUDE, model='test-model',
        response=SimpleNamespace(text='Elasticsearch — поисковый движок для быстрого поиска и анализа данных.',
                                 tool_calls=(), sources=(), search_used=False),
        usage=SimpleNamespace(usage=SimpleNamespace(input_tokens=20, output_tokens=15), estimated_cost=Decimal('0.01')))

    class FakeService:
        async def complete(self, run_id, routing, messages, **kwargs):
            calls.append((messages, kwargs))
            return result

    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: FakeService())
    return client, sessions, fake, integration_id, calls, result


async def jobs(sessions):
    async with sessions() as db:
        return list((await db.execute(select(telegram_models.TelegramBusinessCommand))).scalars())


async def run_command(integration_id):
    from app.integrations.telegram_commands import command_iteration
    await command_iteration(integration_id)


async def test_ask_queue_is_durable_and_sends_once_as_owner_with_auto_reply_off(setup, monkeypatch):
    client, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    update = command_update()
    await ingest(sessions, integration_id, update, fake)
    await ingest(sessions, integration_id, update, fake)
    assert len(await jobs(sessions)) == 1 and not calls and not fake.sent
    await run_command(integration_id)
    assert len(calls) == len(fake.sent) == 1
    assert fake.sent[0][0] == CUSTOMER
    assert fake.sent[0][2] == {'business_connection_id': 'business-1', 'reply_to_message_id': 21}
    assert 'Elasticsearch' in fake.sent[0][1]
    assert (await jobs(sessions))[0].state == 'sent'
    await run_command(integration_id)
    assert len(fake.sent) == 1
    async with sessions() as db:
        assert (await db.execute(select(AIMessage))).scalars().all() == []
        assert (await db.execute(select(AIRun))).scalar_one().cost_estimate == Decimal('0.01')
        outgoing = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
            telegram_models.TelegramBusinessMessage.telegram_message_id == 501))).scalar_one()
        assert outgoing.direction == 'outbound'
    assert (await client.get(PREFIX + '/status')).json()['auto_reply'] is False


async def test_selected_quote_overrides_full_reply_and_stays_untrusted(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='Proxmox', reply='I worked with Proxmox and unrelated private words'), fake)
    await run_command(integration_id)
    assert len(fake.sent) == 1 and fake.sent[0][2]['reply_to_message_id'] == 7
    messages, kwargs = calls[0]
    assert 'Proxmox' in repr(messages) and 'unrelated private words' not in repr(messages)
    assert any(m.untrusted and 'Proxmox' in m.content for m in messages)
    assert not kwargs.get('tools') and not kwargs.get('web_search')
    assert 'owner memory' not in repr(messages).lower()


async def test_search_requires_actual_search_evidence_and_adds_sources(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, result = await configured(setup, monkeypatch)
    result.response.search_used = True
    result.response.sources = ('https://www.proxmox.com/en/',)
    await ingest(sessions, integration_id, command_update('/search Proxmox'), fake)
    await run_command(integration_id)
    assert calls[0][1]['web_search'] is True
    assert len(fake.sent) == 1 and 'https://www.proxmox.com/en/' in fake.sent[0][1]


async def test_search_without_evidence_only_notifies_owner_and_accounts_usage(setup, monkeypatch):
    _, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/search Proxmox'), fake)
    await run_command(integration_id)
    assert fake.sent and all(row[0] == OWNER for row in fake.sent)
    assert (await jobs(sessions))[0].state == 'failed'
    async with sessions() as db:
        assert (await db.execute(select(AIRun))).scalar_one().cost_estimate == Decimal('0.01')


@pytest.mark.parametrize('patch', [
    {'from': {'id': CUSTOMER}}, {'from': {'id': OWNER, 'is_bot': True}},
    {'sender_business_bot': {'id': 1}}, {'forward_origin': {'type': 'user'}},
    {'chat': {'id': CUSTOMER, 'type': 'group'}},
])
async def test_contact_bot_forward_group_cannot_queue_command(setup, monkeypatch, patch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(**patch), fake)
    assert not await jobs(sessions) and not calls and not fake.sent


@pytest.mark.parametrize('mutation', ['edit', 'delete', 'disable', 'rights', 'expired'])
async def test_stale_or_unauthorized_command_never_calls_provider(setup, monkeypatch, mutation):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    async with sessions() as db:
        row = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
            telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one()
        if mutation == 'edit':
            row.text = '/ask changed'; row.version += 1
        elif mutation == 'delete':
            row.deleted_at = service.now()
        elif mutation == 'disable':
            (await db.get(telegram_models.TelegramIntegration, integration_id)).enabled = False
        elif mutation == 'expired':
            incoming = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
                telegram_models.TelegramBusinessMessage.telegram_message_id == 7))).scalar_one()
            incoming.sent_at = service.now() - timedelta(hours=25)
        await db.commit()
    if mutation == 'rights':
        fake.remote_connection = {**fake.remote_connection, 'rights': {'can_reply': False}}
    await run_command(integration_id)
    assert not calls and all(row[0] == OWNER for row in fake.sent)


async def test_edit_during_generation_suppresses_customer_send(setup, monkeypatch):
    _, sessions, fake, integration_id, _calls, result = await configured(setup, monkeypatch)

    class EditingService:
        async def complete(self, *args, **kwargs):
            async with sessions() as db:
                row = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
                    telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one()
                row.text = '/ask edited'; row.version += 1
                await db.commit()
            return result

    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: EditingService())
    await ingest(sessions, integration_id, command_update(), fake)
    await run_command(integration_id)
    assert all(row[0] == OWNER for row in fake.sent)


async def test_interrupted_claim_is_failed_without_replay(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    async with sessions() as db:
        job = (await db.execute(select(telegram_models.TelegramBusinessCommand))).scalar_one()
        job.state = 'running'
        job.started_at = service.now() - timedelta(minutes=5)
        await db.commit()
    await run_command(integration_id)
    assert (await jobs(sessions))[0].state == 'failed' and not calls
    assert all(row[0] == OWNER for row in fake.sent)


async def test_command_quote_is_encrypted_and_purged_on_disconnect(setup, monkeypatch):
    client, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='private-untrusted-quote'), fake)
    async with sessions() as db:
        raw = (await db.execute(text('SELECT quote FROM telegram_business_commands'))).scalar_one()
        assert 'private-untrusted-quote' not in raw
    assert (await client.post(PREFIX + '/disconnect')).status_code == 200
    assert not await jobs(sessions)


async def test_empty_command_usage_is_private_and_never_customer_reply(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask'), fake)
    await run_command(integration_id)
    assert not calls and all(row[0] == OWNER for row in fake.sent)


async def test_send_timeout_is_terminal_and_never_replayed(setup, monkeypatch):
    from app.integrations.telegram_transport import TelegramError
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    fake.send_error = TelegramError('timeout')
    await run_command(integration_id)
    assert (await jobs(sessions))[0].state == 'unknown'
    sends = [row for row in fake.sent if row[0] == CUSTOMER]
    assert len(sends) == 1
    await run_command(integration_id)
    assert len([row for row in fake.sent if row[0] == CUSTOMER]) == 1 and len(calls) == 1


async def test_revoke_clears_queued_command_content(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='private-contact-quote'), fake)
    async with sessions() as db:
        item = await db.get(telegram_models.TelegramIntegration, integration_id)
        await service.accept_connection(db, item, {**fake.remote_connection, 'is_enabled': False})
        await db.commit()
    rows = await jobs(sessions)
    assert not rows or all(not row.query and not row.quote and row.state == 'failed' for row in rows)
    await run_command(integration_id)
    assert not calls and all(row[0] == OWNER for row in fake.sent)


async def test_real_adapter_ask_reaches_telegram_without_private_history(setup, monkeypatch):
    from app.ai.providers import HttpResponse
    _client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    requests = []

    class Transport:
        def __init__(self, **kwargs):
            pass

        async def post(self, url, *, headers, json):
            requests.append(json)
            return HttpResponse(200, {'id': 'provider-r', 'content': [{'type': 'text', 'text': 'Proxmox — платформа для виртуальных машин и контейнеров.'}], 'usage': {'input_tokens': 10, 'output_tokens': 10}})

    monkeypatch.setattr(ai_api, 'HttpxTransport', Transport)
    async with sessions() as db:
        item = await db.get(telegram_models.TelegramIntegration, integration_id)
        db.add(AIProvider(id='real', owner_id=item.owner_id, kind='claude', enabled=True,
            model_policy_json={'monthly_budget': '20', 'models': [{'name': 'test', 'capabilities': ['streaming'], 'input_cost_per_1k': '0.001', 'output_cost_per_1k': '0.002'}]}))
        db.add(AIProviderSecret(provider_id='real', owner_id=item.owner_id, encrypted_value=encrypt_secret('test-opaque-key')))
        item.provider_id = 'real'; item.model = 'test'
        await db.commit()
    await ingest(sessions, integration_id, command_update('/ask', quote='Proxmox'), fake)
    await run_command(integration_id)
    assert len(requests) == 1 and 'Proxmox' in requests[0]['messages'][0]['content']
    assert 'untrusted_data' in requests[0]['messages'][0]['content']
    assert 'tools' not in requests[0]
    assert len(fake.sent) == 1 and fake.sent[0][0] == CUSTOMER and 'Proxmox' in fake.sent[0][1]


async def test_edit_at_final_send_permission_refresh_prevents_publishing(setup, monkeypatch):
    _, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    checks = 0
    original = fake.get_business_connection

    async def fresh(self, connection_id):
        nonlocal checks
        checks += 1
        if checks == 3:
            async with sessions() as db:
                row = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
                    telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one()
                row.version += 1
                row.text = '/ask edited after generation'
                await db.commit()
        return await original(self, connection_id)

    monkeypatch.setattr(fake, 'get_business_connection', fresh)
    await run_command(integration_id)
    assert checks == 3
    assert all(row[0] == OWNER for row in fake.sent)


async def test_deleted_update_erases_command_quote_immediately(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='sensitive-quote'), fake)
    await ingest(sessions, integration_id, {'deleted_business_messages': {
        'business_connection_id': 'business-1', 'chat': {'type': 'private', 'id': CUSTOMER}, 'message_ids': [21],
    }}, fake)
    rows = await jobs(sessions)
    assert not rows or all(not job.query and not job.quote for job in rows)
    await run_command(integration_id)
    assert not calls and all(row[0] == OWNER for row in fake.sent)


async def test_message_ids_are_scoped_to_chat_not_integration(setup, monkeypatch):
    _, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    second = message(4, 'other chat', message_id=7, sender=333)
    second['business_message']['chat']['id'] = 333
    await ingest(sessions, integration_id, second, fake)
    next_command = command_update(update_id=5)
    next_command['business_message']['chat']['id'] = 333
    await ingest(sessions, integration_id, next_command, fake)
    assert len(await jobs(sessions)) == 2


async def test_quote_only_edit_cancels_existing_command(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='Proxmox'), fake)
    edited = command_update('/ask', update_id=4, quote='different quote')
    edited['edited_business_message'] = edited.pop('business_message')
    await ingest(sessions, integration_id, edited, fake)
    await run_command(integration_id)
    assert not calls and all(row[0] == OWNER for row in fake.sent)


async def test_deleted_quoted_message_cancels_pending_explanation(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='Proxmox', reply='Proxmox'), fake)
    await ingest(sessions, integration_id, {'deleted_business_messages': {
        'business_connection_id': 'business-1', 'chat': {'type': 'private', 'id': CUSTOMER}, 'message_ids': [7],
    }}, fake)
    rows = await jobs(sessions)
    assert not rows or all(not job.query and not job.quote for job in rows)
    await run_command(integration_id)
    assert not calls and all(row[0] == OWNER for row in fake.sent)
