"""The actual database unique constraint coordinates simultaneous manual sends."""

import asyncio
from uuid import uuid4

from ai_automation import conftest as ai_contracts
from app.ai.crypto import encrypt_secret
from app.core.models import User, now
from app.integrations import telegram_chat, telegram_service
from app.integrations.telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramChatSend,
    TelegramIntegration,
)
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

chat_engine = ai_contracts.ai_test_engine


async def test_same_key_parallel_claim_and_success_replay_on_real_database(
    chat_engine, monkeypatch
):
    sessions = async_sessionmaker(chat_engine, expire_on_commit=False)
    async with sessions() as db:
        db.add(User(id="chat-owner"))
        await db.flush()
        db.add(
            TelegramIntegration(
                id="chat-integration",
                owner_id="chat-owner",
                bot_id=1,
                bot_username="test",
                bot_name="test",
                business_capable=True,
                owner_telegram_id=111,
                encrypted_token=encrypt_secret("123456:synthetic"),
            )
        )
        await db.flush()
        db.add(
            TelegramBusinessConnection(
                id="chat-connection",
                integration_id="chat-integration",
                owner_id="chat-owner",
                telegram_user_id=111,
                user_chat_id=111,
                enabled=True,
                rights={"can_reply": True},
                connected_at=now(),
                updated_at=now(),
            )
        )
        await db.flush()
        db.add(
            TelegramBusinessMessage(
                id="incoming",
                owner_id="chat-owner",
                integration_id="chat-integration",
                business_connection_id="chat-connection",
                chat_id=222,
                telegram_message_id=1,
                chat_title="Customer",
                text="Hello",
                sent_at=now(),
            )
        )
        await db.commit()
    barrier = asyncio.Event()
    arrived = 0
    sends = []

    class FakeTelegram:
        def __init__(self, token):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get_business_connection(self, connection_id):
            nonlocal arrived
            arrived += 1
            if arrived >= 2:
                barrier.set()
            await asyncio.wait_for(barrier.wait(), 5)
            return {
                "id": "chat-connection",
                "user": {"id": 111},
                "user_chat_id": 111,
                "is_enabled": True,
                "rights": {"can_reply": True},
            }

        async def send_message(self, chat_id, body, **kwargs):
            sends.append(body)
            async with sessions() as db:
                claims = (await db.execute(select(TelegramChatSend))).scalars().all()
                assert any(row.send_status == "sending" for row in claims)
            return {"message_id": 500 + len(sends)}

    monkeypatch.setattr(telegram_service, "TelegramClient", FakeTelegram)
    key = str(uuid4())

    async def send(content="First", request_key=key):
        async with sessions() as db:
            item = await db.get(TelegramIntegration, "chat-integration")
            try:
                return await telegram_chat.send_chat(
                    db, item, "chat-connection", 222, content, request_key
                )
            except HTTPException as exc:
                return exc

    results = await asyncio.gather(send(), send())
    assert sum(isinstance(result, TelegramBusinessMessage) for result in results) >= 1
    assert all(
        isinstance(result, TelegramBusinessMessage)
        or result.detail["code"] == "TELEGRAM_SEND_IN_PROGRESS"
        for result in results
    )
    assert sends == ["First"]
    replay = await send()
    assert isinstance(replay, TelegramBusinessMessage)
    second = await send("Second", str(uuid4()))
    assert isinstance(second, TelegramBusinessMessage)
    assert sends == ["First", "Second"]
    async with sessions() as db:
        receipts = (await db.execute(select(TelegramChatSend))).scalars().all()
        messages = (
            (
                await db.execute(
                    select(TelegramBusinessMessage).where(
                        TelegramBusinessMessage.direction == "owner"
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(receipts) == len(messages) == 2
        assert all(row.send_status == "sent" for row in receipts)
