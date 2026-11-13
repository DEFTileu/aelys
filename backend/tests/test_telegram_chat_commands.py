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
    fake.edits = []

    async def edit(self, chat_id, message_id, content, **kwargs):
        fake.edits.append((chat_id, content, {'message_id': message_id, **kwargs}))
        if fake.send_error:
            raise fake.send_error
        return {'message_id': message_id, 'chat': {'id': chat_id}, 'text': content}

    monkeypatch.setattr(fake, 'edit_message_text', edit, raising=False)
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
    assert len(calls) == len(fake.edits) == 1
    assert not fake.sent
    assert fake.edits[0][0] == CUSTOMER
    assert fake.edits[0][2] == {'business_connection_id': 'business-1', 'message_id': 21}
    assert fake.edits[0][1] == '/ask что такое Elasticsearch\n\nElasticsearch — поисковый движок для быстрого поиска и анализа данных.'
    assert (await jobs(sessions))[0].state == 'sent'
    await run_command(integration_id)
    assert len(fake.edits) == 1 and not fake.sent
    async with sessions() as db:
        assert (await db.execute(select(AIMessage))).scalars().all() == []
        assert (await db.execute(select(AIRun))).scalar_one().cost_estimate == Decimal('0.01')
        outgoing = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
            telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one()
        assert outgoing.direction == 'outbound'
    assert (await client.get(PREFIX + '/status')).json()['auto_reply'] is False


async def test_selected_quote_overrides_full_reply_and_stays_untrusted(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='Proxmox', reply='I worked with Proxmox and unrelated private words'), fake)
    await run_command(integration_id)
    assert len(fake.edits) == 1 and fake.edits[0][2]['message_id'] == 21
    assert fake.edits[0][1].startswith('/ask\n\n') and not fake.sent
    async with sessions() as db:
        contact = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(telegram_models.TelegramBusinessMessage.telegram_message_id == 7))).scalar_one()
        assert contact.text == 'hello' and contact.direction == 'inbound'
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
    assert len(fake.edits) == 1 and 'https://www.proxmox.com/en/' in fake.edits[0][1]
    assert fake.edits[0][1].startswith('/search Proxmox\n\n') and not fake.sent


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
    assert not calls and all(row[0] == OWNER for row in fake.sent) and not fake.edits


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
    assert all(row[0] == OWNER for row in fake.sent) and not fake.edits


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
    assert all(row[0] == OWNER for row in fake.sent) and not fake.edits


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
    assert not calls and all(row[0] == OWNER for row in fake.sent) and not fake.edits


async def test_send_timeout_is_terminal_and_never_replayed(setup, monkeypatch):
    from app.integrations.telegram_transport import TelegramError
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    fake.send_error = TelegramError('timeout')
    await run_command(integration_id)
    assert (await jobs(sessions))[0].state == 'unknown'
    sends = fake.edits
    assert len(sends) == 1
    await run_command(integration_id)
    assert len(fake.edits) == 1 and len(calls) == 1
    assert all(row[0] == OWNER for row in fake.sent)


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
    assert not calls and all(row[0] == OWNER for row in fake.sent) and not fake.edits


async def test_real_adapter_ask_reaches_telegram_without_private_history(setup, monkeypatch):
    from app.ai.providers import HttpResponse
    original_service = ai_api._service
    _client, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    monkeypatch.setattr(ai_api, '_service', original_service)
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
    assert len(fake.edits) == 1 and fake.edits[0][0] == CUSTOMER and 'Proxmox' in fake.edits[0][1]
    assert not fake.sent


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
    assert all(row[0] == OWNER for row in fake.sent) and not fake.edits


async def test_deleted_update_erases_command_quote_immediately(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='sensitive-quote'), fake)
    await ingest(sessions, integration_id, {'deleted_business_messages': {
        'business_connection_id': 'business-1', 'chat': {'type': 'private', 'id': CUSTOMER}, 'message_ids': [21],
    }}, fake)
    rows = await jobs(sessions)
    assert not rows or all(not job.query and not job.quote for job in rows)
    await run_command(integration_id)
    assert not calls and all(row[0] == OWNER for row in fake.sent) and not fake.edits


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
    assert not calls and all(row[0] == OWNER for row in fake.sent) and not fake.edits


async def test_deleted_quoted_message_cancels_pending_explanation(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update('/ask', quote='Proxmox', reply='Proxmox'), fake)
    await ingest(sessions, integration_id, {'deleted_business_messages': {
        'business_connection_id': 'business-1', 'chat': {'type': 'private', 'id': CUSTOMER}, 'message_ids': [7],
    }}, fake)
    rows = await jobs(sessions)
    assert not rows or all(not job.query and not job.quote for job in rows)
    await run_command(integration_id)
    assert not calls and all(row[0] == OWNER for row in fake.sent) and not fake.edits


@pytest.mark.parametrize('failure', [400, 403, 500, 'invalid_response'])
async def test_edit_failure_never_falls_back_to_customer_send(setup, monkeypatch, failure):
    from app.integrations.telegram_transport import TelegramError
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    fake.send_error = TelegramError(failure)
    await run_command(integration_id)
    assert len(fake.edits) == 1 and all(row[0] == OWNER for row in fake.sent)
    assert (await jobs(sessions))[0].state == ('unknown' if failure in (500, 'invalid_response') else 'failed')
    await run_command(integration_id)
    assert len(fake.edits) == 1 and len(calls) == 1


async def test_long_command_is_preserved_and_refused_privately_if_answer_wont_fit(setup, monkeypatch):
    _, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    original = '/ask ' + 'x' * 4090
    await ingest(sessions, integration_id, command_update(original), fake)
    await run_command(integration_id)
    assert not fake.edits and all(row[0] == OWNER for row in fake.sent)
    async with sessions() as db:
        row = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one()
        assert row.text == original and row.direction == 'owner'


async def test_command_older_than_edit_window_never_calls_provider(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(date=int((service.now() - timedelta(hours=49)).timestamp())), fake)
    await run_command(integration_id)
    assert not calls and not fake.edits


async def test_generated_edit_echo_does_not_requeue_or_invalidate_success(setup, monkeypatch):
    _, sessions, fake, integration_id, calls, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    await run_command(integration_id)
    echo = command_update(fake.edits[0][1], update_id=4)
    echo['edited_business_message'] = echo.pop('business_message')
    await ingest(sessions, integration_id, echo, fake)
    await run_command(integration_id)
    assert len(await jobs(sessions)) == 1 and (await jobs(sessions))[0].state == 'sent'
    assert len(calls) == len(fake.edits) == 1


@pytest.mark.parametrize('mutation', ['delete', 'edit', 'disconnect', 'rights'])
async def test_changes_during_remote_edit_preserve_newer_owner_state(setup, monkeypatch, mutation):
    _, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    original_edit = fake.edit_message_text

    async def mutate(self, *args, **kwargs):
        remote = await original_edit(self, *args, **kwargs)
        async with sessions() as db:
            row = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
                telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one()
            item = await db.get(telegram_models.TelegramIntegration, integration_id)
            if mutation == 'delete':
                row.text = ''; row.deleted_at = service.now(); row.version += 1
            elif mutation == 'edit':
                row.text = 'My newer manual message'; row.version += 1
            elif mutation == 'disconnect':
                await service.purge_integration(db, item)
            else:
                connection = await db.get(telegram_models.TelegramBusinessConnection, 'business-1')
                connection.enabled = False
            await db.commit()
        return remote

    monkeypatch.setattr(fake, 'edit_message_text', mutate)
    await run_command(integration_id)
    assert len(fake.edits) == 1
    async with sessions() as db:
        row = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
            telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one_or_none()
        if mutation == 'delete':
            assert row.deleted_at and not row.text
        elif mutation == 'edit':
            assert row.text == 'My newer manual message' and row.direction == 'owner'
        elif mutation == 'disconnect':
            assert row is None
        else:
            assert (await jobs(sessions))[0].state == 'unknown'


@pytest.mark.parametrize('bad_target', [7, 99])
async def test_delivery_boundary_refuses_contact_or_unknown_edit_target(setup, monkeypatch, bad_target):
    from app.integrations.telegram_chat import send_chat
    from fastapi import HTTPException
    _, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    async with sessions() as db:
        item = await db.get(telegram_models.TelegramIntegration, integration_id)
        with pytest.raises(HTTPException):
            await send_chat(db, item, 'business-1', CUSTOMER, 'replacement', 'bad-target',
                            edit_message_id=bad_target, edit_source_version=1, direction='outbound')
    assert not fake.edits and not fake.sent


async def test_edit_receipt_replays_without_another_remote_edit(setup, monkeypatch):
    from app.integrations.telegram_chat import send_chat
    from fastapi import HTTPException
    _, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    await run_command(integration_id)
    job = (await jobs(sessions))[0]
    async with sessions() as db:
        item = await db.get(telegram_models.TelegramIntegration, integration_id)
        result = await send_chat(db, item, 'business-1', CUSTOMER, fake.edits[0][1],
                                 f'business-command:{job.id}', edit_message_id=21,
                                 edit_source_version=job.source_version, direction='outbound')
        assert result.telegram_message_id == 21 and result.direction == 'outbound'
        with pytest.raises(HTTPException) as conflict:
            await send_chat(db, item, 'business-1', CUSTOMER, 'different',
                            f'business-command:{job.id}', edit_message_id=21,
                            edit_source_version=job.source_version, direction='outbound')
        assert conflict.value.detail['code'] == 'IDEMPOTENCY_CONFLICT'
    assert len(fake.edits) == 1 and not fake.sent


async def test_delete_after_post_edit_read_is_not_restored_at_commit(setup, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession
    _, sessions, fake, integration_id, _, _ = await configured(setup, monkeypatch)
    await ingest(sessions, integration_id, command_update(), fake)
    original_execute = AsyncSession.execute
    deleted = False

    async def delete_after_read(db, statement, *args, **kwargs):
        nonlocal deleted
        result = await original_execute(db, statement, *args, **kwargs)
        sql = str(statement)
        # This is the post-I/O message lookup, not a pre-send source guard.
        if (not deleted and fake.edits and sql.startswith('SELECT telegram_business_messages.')
                and 'telegram_business_messages.telegram_message_id' in sql
                and 'ORDER BY' not in sql):
            deleted = True
            async with sessions() as concurrent:
                row = (await concurrent.execute(select(telegram_models.TelegramBusinessMessage).where(
                    telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one()
                row.text = ''; row.deleted_at = service.now(); row.version += 1
                await concurrent.commit()
        return result

    monkeypatch.setattr(AsyncSession, 'execute', delete_after_read)
    await run_command(integration_id)
    assert deleted and len(fake.edits) == 1
    async with sessions() as db:
        row = (await db.execute(select(telegram_models.TelegramBusinessMessage).where(
            telegram_models.TelegramBusinessMessage.telegram_message_id == 21))).scalar_one()
        assert row.deleted_at and not row.text
        assert (await jobs(sessions))[0].state == 'unknown'
