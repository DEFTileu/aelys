"""Telegram claim serialization on a real disposable PostgreSQL database."""
import asyncio
from datetime import UTC, datetime

from app.ai.crypto import encrypt_secret
from app.core import db
from app.core.models import Notification, Task, TaskReminder
from app.integrations import telegram_service
from app.integrations.telegram_models import TelegramIntegration
from app.integrations.telegram_reminders import deliver_telegram_reminders
from sqlalchemy import select

pytest_plugins = ('test_domain_sync_postgres',)


async def test_postgres_parallel_telegram_reminder_has_one_durable_claim(postgres_domain_sessions, monkeypatch):
    sessions = postgres_domain_sessions
    monkeypatch.setattr(db, 'SessionLocal', sessions)
    at = datetime(2026, 11, 5, 12, tzinfo=UTC)
    token = '123456:' + 'p' * 30
    async with sessions() as session:
        session.add(TelegramIntegration(id='telegram', owner_id='owner', bot_id=1, bot_username='test', bot_name='Test',
            business_capable=True, encrypted_token=encrypt_secret(token), owner_telegram_id=111, deadline_reminders=True))
        session.add(Task(id='task', owner_id='owner', title='Private reminder title'))
        session.add(TaskReminder(id='reminder', owner_id='owner', task_id='task', notify_at=at,
                                channel='telegram', idempotency_key='parallel-pg'))
        await session.commit()
    sent = []
    class Transport:
        def __init__(self, secret):
            assert secret == token
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def send_message(self, chat_id, content):
            async with sessions() as session:
                assert (await session.get(TaskReminder, 'reminder')).reminder_status == 'delivered'
                notice = (await session.execute(select(Notification))).scalar_one()
                assert 'Private reminder title' not in str((notice.title, notice.body, notice.data_json))
            sent.append((chat_id, content))
            return {'message_id': 1}
    monkeypatch.setattr(telegram_service, 'TelegramClient', Transport)
    await asyncio.gather(deliver_telegram_reminders('telegram', at=at), deliver_telegram_reminders('telegram', at=at))
    await deliver_telegram_reminders('telegram', at=at)
    assert len(sent) == 1 and sent[0][0] == 111
    async with sessions() as session:
        assert len(list((await session.execute(select(Notification))).scalars())) == 1
