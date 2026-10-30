"""Offline integration coverage for the Telegram Business connector."""
import asyncio
from datetime import timedelta
from typing import ClassVar
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from app.ai.crypto import decrypt_secret
from app.core import db
from app.core.db import Base
from app.core.models import now
from app.integrations import telegram_ai, telegram_api
from app.integrations import telegram_service as service
from app.integrations.telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramIntegration,
    TelegramUpdateReceipt,
)
from app.integrations.telegram_transport import TelegramError
from app.main import app
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

PREFIX = "/api/v1/integrations/telegram"
TOKEN = "123456:" + "z" * 30  # Synthetic credential, never sent over the network.
OWNER = 111
CUSTOMER = 222


def connection(owner=OWNER, can_reply=True):
    return {"id": "business-1", "user": {"id": owner}, "user_chat_id": owner,
            "is_enabled": True, "rights": {"can_reply": can_reply, "can_read_messages": True}}


def message(update_id, content="hello", *, kind="business_message", message_id=7, sender=CUSTOMER, age=0):
    return {"update_id": update_id, kind: {"business_connection_id": "business-1", "message_id": message_id,
        "date": int((now() - timedelta(seconds=age)).timestamp()), "from": {"id": sender, "is_bot": False},
        "chat": {"id": CUSTOMER, "type": "private", "first_name": "Customer"}, "text": content}}


@pytest.fixture
async def setup(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/telegram.db")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", sessions)

    class FakeTelegramClient:
        updates: ClassVar[list] = []
        hook = ""
        remote_connection = connection()
        sent: ClassVar[list] = []
        calls: ClassVar[list] = []
        send_error = None
        gate = None

        def __init__(self, token):
            assert token == TOKEN

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get_me(self):
            return {"id": 1, "is_bot": True, "username": "aelys_test_bot", "first_name": "Test", "can_connect_to_business": True}

        async def get_webhook_info(self):
            self.calls.append("webhook")
            return {"url": self.hook}

        async def get_updates(self, offset, timeout=20):
            self.calls.append(("updates", offset, timeout))
            if self.gate:
                await self.gate.wait()
            return list(self.updates)

        async def get_business_connection(self, id):
            self.calls.append(("connection", id))
            return self.remote_connection

        async def send_message(self, chat_id, content, **kwargs):
            self.sent.append((chat_id, content, kwargs))
            if self.send_error:
                raise self.send_error
            return {"message_id": 500}

    monkeypatch.setattr(service, "TelegramClient", FakeTelegramClient)
    monkeypatch.setattr(telegram_api, "TelegramClient", FakeTelegramClient)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        boot = await client.post("/api/v1/auth/bootstrap", json={"email": "owner@example.test", "password": "correct horse battery staple"})
        assert boot.status_code == 200
        client.headers["Authorization"] = "Bearer " + boot.json()["access_token"]
        yield client, sessions, FakeTelegramClient
    await engine.dispose()


async def connect(client):
    response = await client.post(PREFIX + "/connect", json={"bot_token": TOKEN})
    assert response.status_code == 200, response.text
    assert TOKEN not in response.text
    return response.json()


async def set_bound(sessions, integration_id):
    async with sessions() as session:
        item = await session.get(TelegramIntegration, integration_id)
        item.owner_telegram_id = OWNER
        await session.commit()


async def ingest(sessions, item_id, update, fake):
    async with sessions() as session:
        item = await session.get(TelegramIntegration, item_id)
        await service.ingest_update(session, item, update, fake(TOKEN))
        await session.commit()


async def seed_message(client, sessions, fake):
    item = await connect(client)
    await set_bound(sessions, item["id"])
    fake.updates = [{"update_id": 1, "business_connection": connection()}, message(2)]
    response = await client.post(PREFIX + "/sync")
    assert response.status_code == 200, response.text
    rows = (await client.get(PREFIX + "/messages")).json()
    assert len(rows) == 1
    return item, rows[0]


@pytest.mark.asyncio
async def test_connect_secret_and_webhook_conflict(setup):
    client, sessions, fake = setup
    fake.hook = "https://example.test/hook"
    conflict = await client.post(PREFIX + "/connect", json={"bot_token": TOKEN})
    assert conflict.status_code == 409
    assert "TELEGRAM_WEBHOOK_CONFLICT" in conflict.text and TOKEN not in conflict.text
    fake.hook = ""
    status = await connect(client)
    assert status["configured"] and status["business_capable"] and not status["auto_reply"]
    assert TOKEN not in (await client.get(PREFIX + "/status")).text
    async with sessions() as session:
        stored = (await session.execute(text("SELECT encrypted_token FROM telegram_integrations"))).scalar_one()
        assert stored != TOKEN and decrypt_secret(stored) == TOKEN


@pytest.mark.asyncio
async def test_binding_one_use_expiry_and_private_identity(setup):
    client, sessions, fake = setup
    item = await connect(client)
    binding = (await client.post(PREFIX + "/binding")).json()
    code = parse_qs(urlparse(binding["url"]).query)["start"][0]
    def update(sender, chat, typ="private"):
        return {"message": {"text": "/start " + code, "from": {"id": sender}, "chat": {"id": chat, "type": typ}}}
    await ingest(sessions, item["id"], update(OWNER, CUSTOMER), fake)
    await ingest(sessions, item["id"], update(OWNER, OWNER, "group"), fake)
    assert (await client.get(PREFIX + "/status")).json()["owner_telegram_id"] is None
    await ingest(sessions, item["id"], update(OWNER, OWNER), fake)
    await ingest(sessions, item["id"], update(CUSTOMER, CUSTOMER), fake)
    assert (await client.get(PREFIX + "/status")).json()["owner_telegram_id"] == OWNER
    binding = (await client.post(PREFIX + "/binding")).json()
    code = parse_qs(urlparse(binding["url"]).query)["start"][0]
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        obj.binding_expires_at = now() - timedelta(seconds=1)
        await session.commit()
    await ingest(sessions, item["id"], update(OWNER, OWNER), fake)
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        assert obj.binding_code_hash is not None


@pytest.mark.asyncio
async def test_poll_deduplicates_and_ignores_other_owner(setup):
    client, sessions, fake = setup
    item = await connect(client)
    await set_bound(sessions, item["id"])
    fake.remote_connection = connection(owner=999)
    fake.updates = [{"update_id": 1, "business_connection": connection(owner=999)}, message(2)]
    assert (await client.post(PREFIX + "/sync")).json()["processed"] == 2
    assert (await client.get(PREFIX + "/messages")).json() == []
    fake.remote_connection = connection()
    fake.updates = [{"update_id": 3, "business_connection": connection()}, message(4), message(4), message(5)]
    assert (await client.post(PREFIX + "/sync")).json()["processed"] == 3
    assert (await client.post(PREFIX + "/sync")).json()["processed"] == 0
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        receipts = (await session.execute(select(TelegramUpdateReceipt))).scalars().all()
        messages = (await session.execute(select(TelegramBusinessMessage))).scalars().all()
        assert obj.last_update_id == 5 and len(receipts) == 5 and len(messages) == 1


@pytest.mark.asyncio
async def test_edit_and_delete_erase_draft_and_content(setup):
    client, sessions, fake = setup
    item, row = await seed_message(client, sessions, fake)
    async with sessions() as session:
        obj = await session.get(TelegramBusinessMessage, row["id"])
        obj.draft_text = "draft"; obj.draft_status = "ready"
        await session.commit()
    await ingest(sessions, item["id"], message(3, "changed", kind="edited_business_message"), fake)
    async with sessions() as session:
        obj = await session.get(TelegramBusinessMessage, row["id"])
        assert obj.text == "changed" and obj.draft_text is None and obj.draft_status == "none"
    await ingest(sessions, item["id"], {"deleted_business_messages": {"business_connection_id": "business-1", "chat": {"id": CUSTOMER, "type": "private"}, "message_ids": [7]}}, fake)
    async with sessions() as session:
        obj = await session.get(TelegramBusinessMessage, row["id"])
        assert obj.deleted_at and obj.text == "" and obj.chat_title == "" and obj.draft_text is None


@pytest.mark.asyncio
async def test_reply_rights_and_window_are_enforced(setup):
    client, sessions, fake = setup
    _item, row = await seed_message(client, sessions, fake)
    fake.remote_connection = connection(can_reply=False)
    denied = await client.post(f"{PREFIX}/messages/{row['id']}/send", json={"version": row["version"], "text": "reply"})
    assert denied.status_code == 403 and "TELEGRAM_REPLY_DENIED" in denied.text
    assert not fake.sent
    fake.remote_connection = connection()
    async with sessions() as session:
        obj = await session.get(TelegramBusinessMessage, row["id"])
        obj.sent_at = now() - timedelta(hours=25)
        await session.commit()
    denied = await client.post(f"{PREFIX}/messages/{row['id']}/send", json={"version": row["version"], "text": "reply"})
    assert denied.status_code == 403 and "TELEGRAM_REPLY_WINDOW_EXPIRED" in denied.text
    assert not fake.sent


@pytest.mark.asyncio
async def test_auto_reply_off_and_on_end_to_end(setup, monkeypatch):
    client, sessions, fake = setup
    item, row = await seed_message(client, sessions, fake)
    generated = []
    async def generate(session, integration, message):
        generated.append(message.id)
        return "generated answer"
    monkeypatch.setattr(telegram_ai, "generate_business_draft", generate)
    fake.calls.clear()
    await service.auto_reply_once(item["id"])
    assert not fake.calls and not fake.sent and not generated
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        obj.auto_reply = True
        await session.commit()
    await service.auto_reply_once(item["id"])
    assert generated == [row["id"]]
    assert len(fake.sent) == 1 and fake.sent[0][1] == "generated answer"
    async with sessions() as session:
        obj = await session.get(TelegramBusinessMessage, row["id"])
        assert obj.draft_status == "sent" and obj.reply_message_id == 500


@pytest.mark.asyncio
async def test_timeout_is_unknown_and_cannot_be_resent(setup):
    client, sessions, fake = setup
    _item, row = await seed_message(client, sessions, fake)
    fake.send_error = TelegramError("timeout")
    response = await client.post(f"{PREFIX}/messages/{row['id']}/send", json={"version": row["version"], "text": "answer"})
    assert response.status_code == 503 and "TELEGRAM_DELIVERY_UNKNOWN" in response.text
    current = (await client.get(PREFIX + "/messages")).json()[0]
    assert current["draft_status"] == "unknown"
    response = await client.post(f"{PREFIX}/messages/{row['id']}/send", json={"version": current["version"], "text": "answer"})
    assert response.status_code == 409 and len(fake.sent) == 1


@pytest.mark.asyncio
async def test_poll_lease_prevents_concurrent_fetch(setup):
    client, _sessions, fake = setup
    item = await connect(client)
    fake.gate = asyncio.Event()
    first = asyncio.create_task(service.poll_once(item["id"], timeout=0))
    for _ in range(200):
        if any(isinstance(call, tuple) and call[0] == "updates" for call in fake.calls):
            break
        await asyncio.sleep(0.005)
    else:
        fake.gate.set()
        await first
        pytest.fail("first poll never reached get_updates")
    second = await service.poll_once(item["id"], timeout=0)
    fake.gate.set()
    assert await first == 0 and second == 0
    assert len([call for call in fake.calls if isinstance(call, tuple) and call[0] == "updates"]) == 1


@pytest.mark.asyncio
async def test_api_auth_version_pause_and_disconnect(setup):
    client, sessions, fake = setup
    item, _row = await seed_message(client, sessions, fake)
    authorization = client.headers.pop("Authorization")
    for method, path in [("GET", "/status"), ("GET", "/messages"), ("POST", "/binding"), ("POST", "/disconnect")]:
        assert (await client.request(method, PREFIX + path)).status_code == 401
    client.headers["Authorization"] = authorization
    current = (await client.get(PREFIX + "/status")).json()
    pause = await client.patch(PREFIX + "/settings", json={"version": current["version"], "enabled": False})
    assert pause.status_code == 200 and not pause.json()["enabled"]
    conflict = await client.patch(PREFIX + "/settings", json={"version": current["version"], "enabled": True})
    assert conflict.status_code == 409 and "VERSION_CONFLICT" in conflict.text
    assert (await client.post(PREFIX + "/sync")).status_code == 409
    assert (await client.post(PREFIX + "/disconnect")).status_code == 200
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        assert obj.encrypted_token is None and not obj.enabled and not obj.auto_reply
        assert not (await session.execute(select(TelegramBusinessConnection))).scalars().all()
        assert not (await session.execute(select(TelegramBusinessMessage))).scalars().all()
        assert not (await session.execute(select(TelegramUpdateReceipt))).scalars().all()


@pytest.mark.asyncio
async def test_poll_failure_rolls_back_message_and_receipt_together(setup, monkeypatch):
    client, sessions, fake = setup
    item = await connect(client)
    await set_bound(sessions, item["id"])
    fake.updates = [{"update_id": 1, "business_connection": connection()}]
    assert await service.poll_once(item["id"], timeout=0) == 1
    fake.updates = [message(2)]
    original = service.ingest_update
    async def fail_after_write(session, integration, payload, telegram):
        await original(session, integration, payload, telegram)
        raise RuntimeError("injected failure")
    monkeypatch.setattr(service, "ingest_update", fail_after_write)
    with pytest.raises(RuntimeError):
        await service.poll_once(item["id"], timeout=0)
    async with sessions() as session:
        current = await session.get(TelegramIntegration, item["id"])
        assert current.last_update_id == 1
        assert await session.get(TelegramUpdateReceipt, (item["id"], 2)) is None
        assert not (await session.execute(select(TelegramBusinessMessage))).scalars().all()


@pytest.mark.asyncio
async def test_reply_rejects_connection_owned_by_another_telegram_user(setup):
    client, sessions, fake = setup
    _, row = await seed_message(client, sessions, fake)
    fake.remote_connection = connection(owner=999)
    result = await client.post(f"{PREFIX}/messages/{row['id']}/send", json={"version": row["version"], "text": "answer"})
    assert result.status_code == 403 and "TELEGRAM_REPLY_DENIED" in result.text
    assert not fake.sent


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", [
    {"update_id": "not-an-integer", "message": {}},
    {"update_id": 1, "business_connection": {"id": "business-1", "user": "invalid", "user_chat_id": OWNER}},
    {"update_id": 1, "message": {"text": "/start aelys_" + "x" * 30, "from": "invalid", "chat": {"type": "private"}}},
    {"update_id": 1, "business_message": {"business_connection_id": "business-1", "chat": "invalid"}},
    {"update_id": 1, "business_message": {"business_connection_id": "business-1", "chat": {"id": CUSTOMER, "type": "private"}, "from": "invalid", "message_id": 9, "date": 1}},
])
async def test_malformed_update_does_not_block_following_updates(setup, bad):
    client, sessions, fake = setup
    item = await connect(client)
    await set_bound(sessions, item["id"])
    fake.updates = [bad, {"update_id": 2, "business_connection": connection()}, message(3)]
    await service.poll_once(item["id"], timeout=0)
    async with sessions() as session:
        current = await session.get(TelegramIntegration, item["id"])
        assert current.last_update_id == 3
        assert len((await session.execute(select(TelegramBusinessMessage))).scalars().all()) == 1


@pytest.mark.asyncio
async def test_concurrent_auto_reply_generates_and_sends_once(setup, monkeypatch):
    client, sessions, fake = setup
    item, row = await seed_message(client, sessions, fake)
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        obj.auto_reply = True
        await session.commit()
    entered = asyncio.Event()
    release = asyncio.Event()
    generated = []
    async def generate(session, integration, message):
        generated.append(message.id)
        entered.set()
        await release.wait()
        return "automatic answer"
    monkeypatch.setattr(telegram_ai, "generate_business_draft", generate)
    first = asyncio.create_task(service.auto_reply_once(item["id"]))
    await asyncio.wait_for(entered.wait(), 2)
    await service.auto_reply_once(item["id"])
    release.set()
    await first
    assert generated == [row["id"]] and len(fake.sent) == 1


@pytest.mark.asyncio
async def test_old_future_and_forwarded_messages_are_ignored(setup):
    client, sessions, fake = setup
    item = await connect(client)
    await set_bound(sessions, item["id"])
    await ingest(sessions, item["id"], {"business_connection": connection()}, fake)
    old = message(1, age=8 * 86400)
    future = message(2, message_id=8, age=-600)
    forwarded = message(3, message_id=9)
    forwarded["business_message"]["forward_origin"] = {"type": "hidden_user", "date": 1, "sender_user_name": "X"}
    for candidate in (old, future, forwarded):
        await ingest(sessions, item["id"], candidate, fake)
    async with sessions() as session:
        assert not (await session.execute(select(TelegramBusinessMessage))).scalars().all()


@pytest.mark.asyncio
async def test_poll_rate_limit_persists_retry_after(setup, monkeypatch):
    client, sessions, fake = setup
    item = await connect(client)
    calls = []
    async def rate_limited(self, offset, timeout=20):
        calls.append(offset)
        raise TelegramError(429, retry_after=30)
    monkeypatch.setattr(fake, "get_updates", rate_limited)
    result = await client.post(PREFIX + "/sync")
    assert result.status_code == 503 and "TELEGRAM_RATE_LIMITED" in result.text
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        assert obj.lease_owner is None and service.utc(obj.lease_expires_at) > now() + timedelta(seconds=20)
        assert obj.last_error_code == "TELEGRAM_RATE_LIMITED" and obj.last_update_id == -1
    assert await service.poll_once(item["id"], timeout=0) == 0
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_send_rate_limit_prevents_immediate_retry(setup):
    client, sessions, fake = setup
    _, row = await seed_message(client, sessions, fake)
    fake.send_error = TelegramError(429, retry_after=30)
    path = f"{PREFIX}/messages/{row['id']}/send"
    result = await client.post(path, json={"version": row["version"], "text": "answer"})
    assert result.status_code == 503 and "TELEGRAM_RATE_LIMITED" in result.text
    current = (await client.get(PREFIX + "/messages")).json()[0]
    await client.post(path, json={"version": current["version"], "text": "answer"})
    assert len(fake.sent) == 1


@pytest.mark.asyncio
async def test_pause_during_generation_prevents_send(setup, monkeypatch):
    client, sessions, fake = setup
    item, row = await seed_message(client, sessions, fake)
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        obj.auto_reply = True
        await session.commit()
    entered, release = asyncio.Event(), asyncio.Event()
    async def generate(session, integration, message):
        entered.set()
        await release.wait()
        return "answer"
    monkeypatch.setattr(telegram_ai, "generate_business_draft", generate)
    task = asyncio.create_task(service.auto_reply_once(item["id"]))
    await asyncio.wait_for(entered.wait(), 2)
    current = (await client.get(PREFIX + "/status")).json()
    result = await client.patch(PREFIX + "/settings", json={"version": current["version"], "enabled": False, "auto_reply": False})
    assert result.status_code == 200
    release.set()
    await task
    assert not fake.sent
    async with sessions() as session:
        obj = await session.get(TelegramBusinessMessage, row["id"])
        assert obj.draft_status == "failed" and obj.draft_error_code == "TELEGRAM_PAUSED"


@pytest.mark.asyncio
async def test_pause_during_permission_check_prevents_send(setup, monkeypatch):
    client, sessions, fake = setup
    _, row = await seed_message(client, sessions, fake)
    entered, release = asyncio.Event(), asyncio.Event()
    async def connection_wait(self, id):
        entered.set()
        await release.wait()
        return connection()
    monkeypatch.setattr(fake, "get_business_connection", connection_wait)
    task = asyncio.create_task(client.post(f"{PREFIX}/messages/{row['id']}/send", json={"version": row["version"], "text": "answer"}))
    await asyncio.wait_for(entered.wait(), 2)
    current = (await client.get(PREFIX + "/status")).json()
    pause = await client.patch(PREFIX + "/settings", json={"version": current["version"], "enabled": False})
    assert pause.status_code == 200
    release.set()
    response = await task
    assert response.status_code == 409 and "TELEGRAM_PAUSED" in response.text
    assert not fake.sent


@pytest.mark.asyncio
async def test_automatic_reply_is_not_repeated_on_next_cycle(setup, monkeypatch):
    client, sessions, fake = setup
    item, row = await seed_message(client, sessions, fake)
    async with sessions() as session:
        obj = await session.get(TelegramIntegration, item["id"])
        obj.auto_reply = True
        await session.commit()
    generated = []
    async def generate(session, integration, message):
        generated.append(message.id)
        return "answer"
    monkeypatch.setattr(telegram_ai, "generate_business_draft", generate)
    await service.auto_reply_once(item["id"])
    await service.auto_reply_once(item["id"])
    assert generated == [row["id"]] and len(fake.sent) == 1


@pytest.mark.asyncio
async def test_auto_reply_uses_real_ai_harness_and_records_usage(setup, monkeypatch):
    from app.ai import api as ai_api
    from app.ai.crypto import encrypt_secret
    from app.ai.providers import HttpResponse
    from app.core.models import AIProvider, AIProviderSecret, AIRun

    client, sessions, fake = setup
    item, row = await seed_message(client, sessions, fake)
    async with sessions() as session:
        integration = await session.get(TelegramIntegration, item["id"])
        provider = AIProvider(
            owner_id=integration.owner_id, kind="openrouter", enabled=True,
            model_policy_json={"default_model": "test-model", "monthly_budget": "20"},
        )
        session.add(provider)
        await session.flush()
        session.add(AIProviderSecret(provider_id=provider.id, owner_id=integration.owner_id,
                                     encrypted_value=encrypt_secret("synthetic-provider-secret")))
        integration.provider_id = provider.id
        integration.auto_reply = True
        await session.commit()

    provider_requests = []
    async def post(self, url, *, headers, json):
        provider_requests.append(json)
        return HttpResponse(200, {"id": "response", "choices": [{"message": {"content": "Thank you for your message."}}],
                                  "usage": {"prompt_tokens": 11, "completion_tokens": 7}})
    monkeypatch.setattr(ai_api.HttpxTransport, "post", post)
    await service.auto_reply_once(item["id"])
    assert len(provider_requests) == 1
    assert len(fake.sent) == 1 and fake.sent[0][1] == "Thank you for your message."
    async with sessions() as session:
        run = (await session.execute(select(AIRun))).scalar_one()
        assert run.status == "completed" and run.token_counts == {"input": 11, "output": 7}
        obj = await session.get(TelegramBusinessMessage, row["id"])
        assert obj.draft_status == "sent" and obj.reply_message_id == 500


@pytest.mark.asyncio
async def test_identical_reconnect_preserves_assistant_state(setup):
    client, sessions, fake = setup
    item, row = await seed_message(client, sessions, fake)
    async with sessions() as session:
        integration = await session.get(TelegramIntegration, item["id"])
        integration.auto_reply = True
        await session.commit()
    before = (await client.get(PREFIX + "/status")).json()
    result = await client.post(PREFIX + "/connect", json={"bot_token": TOKEN})
    assert result.status_code == 200 and TOKEN not in result.text
    status = result.json()
    assert status["id"] == item["id"] and status["owner_telegram_id"] == OWNER
    assert status["auto_reply"] is True and status["version"] == before["version"]
    assert status["connections"] == before["connections"]
    assert [message["id"] for message in (await client.get(PREFIX + "/messages")).json()] == [row["id"]]
    async with sessions() as session:
        assert len((await session.execute(select(TelegramUpdateReceipt))).scalars().all()) == 2
