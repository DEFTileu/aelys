"""Real PostgreSQL contention for the opt-in extractor's durable daily budget."""
import asyncio
import json
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from app.ai import api as ai_api
from app.ai.crypto import encrypt_secret
from app.core import db as database
from app.core.models import (
    AIAction,
    AIProvider,
    AIProviderSecret,
    AIRun,
    Task,
    User,
    now,
)
from app.integrations import telegram_service as service
from app.integrations.telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramIntegration,
)
from app.integrations.telegram_task_suggestions import (
    invalidate_suggestions,
    suggestion_iteration,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker


async def seed(engine, monkeypatch, count=1):
    if engine.dialect.name != 'postgresql':
        pytest.skip('Real PostgreSQL row-lock contract')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(database, 'SessionLocal', sessions)
    async with sessions() as db:
        db.add(User(id='owner', email='suggestion@example.test'))
        await db.flush()
        db.add(AIProvider(id='provider', owner_id='owner', kind='claude', enabled=True,
                          model_policy_json={'monthly_budget': '20'}))
        await db.flush()
        db.add(AIProviderSecret(provider_id='provider', owner_id='owner', encrypted_value=encrypt_secret('synthetic-key')))
        db.add(TelegramIntegration(id='integration', owner_id='owner', bot_id=1, bot_username='bot', bot_name='Bot',
            business_capable=True, enabled=True, encrypted_token=encrypt_secret('123456:synthetic'),
            owner_telegram_id=111, provider_id='provider', task_suggestions_chat_id=222,
            task_suggestions_enabled_at=now()-timedelta(minutes=1)))
        await db.flush()
        db.add(TelegramBusinessConnection(id='connection', owner_id='owner', integration_id='integration',
            telegram_user_id=111, user_chat_id=111, enabled=True, rights={'can_reply': True, 'can_read_messages': True},
            connected_at=now(), updated_at=now()))
        await db.flush()
        for index in range(count):
            db.add(TelegramBusinessMessage(owner_id='owner', integration_id='integration', business_connection_id='connection',
                chat_id=222, sender_id=222, telegram_message_id=index+1, text='Please prepare the report',
                sent_at=now(), direction='inbound', task_suggestion_state='queued'))
        await db.commit()
    deliveries = []

    class Transport:
        def __init__(self, token):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def send_message(self, chat_id, text, **kwargs):
            deliveries.append((chat_id, text, kwargs))
            return {'message_id': len(deliveries)}

    monkeypatch.setattr(service, 'TelegramClient', Transport)
    return sessions, deliveries


def response():
    return SimpleNamespace(model='test', response=SimpleNamespace(text=json.dumps({'title': 'Prepare report'}), tool_calls=()),
        usage=SimpleNamespace(estimated_cost=Decimal('0.01'), usage=SimpleNamespace(input_tokens=10, output_tokens=5)))


async def test_postgres_parallel_workers_reserve_no_more_than_twenty_calls(ai_test_engine, monkeypatch):
    sessions, deliveries = await seed(ai_test_engine, monkeypatch, count=25)
    calls = 0
    all_reserved = asyncio.Event()
    release = asyncio.Event()

    class Runtime:
        async def complete(self, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 20:
                all_reserved.set()
            await release.wait()
            return response()

    monkeypatch.setattr(ai_api, '_service', lambda *_: Runtime())
    workers = [asyncio.create_task(suggestion_iteration('integration')) for _ in range(25)]
    try:
        await asyncio.wait_for(all_reserved.wait(), 20)
        # All 20 reservations are durable before the first result is available.
        async with sessions() as db:
            assert await db.scalar(select(func.count()).select_from(AIRun)) == 20
        release.set()
        await asyncio.wait_for(asyncio.gather(*workers), 30)
    finally:
        release.set()
        await asyncio.gather(*workers)
    assert calls == 20
    async with sessions() as db:
        assert await db.scalar(select(func.count()).select_from(AIRun)) == 20
        assert await db.scalar(select(func.count()).select_from(AIAction)) == 20
        assert await db.scalar(select(func.count()).select_from(Task)) == 0
        assert await db.scalar(select(func.count()).select_from(TelegramBusinessMessage).where(
            TelegramBusinessMessage.task_suggestion_state == 'skipped_limit')) == 5
    assert all(delivery[0] == 111 for delivery in deliveries)


async def test_postgres_off_during_model_prevents_proposal(ai_test_engine, monkeypatch):
    sessions, deliveries = await seed(ai_test_engine, monkeypatch)
    started, release = asyncio.Event(), asyncio.Event()

    class Runtime:
        async def complete(self, *args, **kwargs):
            started.set()
            await release.wait()
            return response()

    monkeypatch.setattr(ai_api, '_service', lambda *_: Runtime())
    worker = asyncio.create_task(suggestion_iteration('integration'))
    try:
        await asyncio.wait_for(started.wait(), 10)
        async with sessions() as db:
            await invalidate_suggestions(db, integration_id='integration', at=now())
            item = await db.get(TelegramIntegration, 'integration')
            item.task_suggestions_chat_id = None
            item.task_suggestions_enabled_at = None
            await db.commit()
        release.set()
        await asyncio.wait_for(worker, 15)
    finally:
        release.set()
        await worker
    assert not deliveries
    async with sessions() as db:
        assert await db.scalar(select(func.count()).select_from(AIAction)) == 0
        assert await db.scalar(select(func.count()).select_from(Task)) == 0
        assert (await db.execute(select(AIRun))).scalar_one().cost_estimate == Decimal('0.01')
