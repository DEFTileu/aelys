"""Manual chat messages are independent, durable and permission checked."""

import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from app.integrations import telegram_service as service
from app.integrations.telegram_models import (
    TelegramBusinessMessage,
    TelegramIntegration,
)
from app.integrations.telegram_transport import TelegramError
from sqlalchemy import select, text
from test_telegram_business import CUSTOMER, OWNER, PREFIX, ingest, message
from test_telegram_personal import bound

pytest_plugins = ("test_telegram_business",)


async def ready(setup, monkeypatch):
    client, sessions, fake, integration_id = await bound(setup)
    await ingest(sessions, integration_id, message(1), fake)

    async def send(self, chat_id, content, **kwargs):
        fake.sent.append((chat_id, content, kwargs))
        if fake.send_error:
            raise fake.send_error
        return {"message_id": 500 + len(fake.sent)}

    monkeypatch.setattr(fake, "send_message", send)
    return client, sessions, fake, integration_id


async def send(client, content="First message", key=None, **patch):
    return await client.post(
        PREFIX + "/chats/send",
        json={
            "business_connection_id": "business-1",
            "chat_id": CUSTOMER,
            "text": content,
            **patch,
        },
        headers={"Idempotency-Key": key or str(uuid4())},
    )


async def test_two_manual_sends_after_sent_reply_are_separate_encrypted_owner_messages(
    setup, monkeypatch
):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    async with sessions() as db:
        incoming = (await db.execute(select(TelegramBusinessMessage))).scalar_one()
        incoming.draft_status = "sent"
        incoming.draft_text = "Already answered"
        await db.commit()
        original_id = incoming.id
    first = await send(client, "First message")
    second = await send(client, "Second message")
    assert first.status_code == second.status_code == 200, (first.text, second.text)
    assert first.json()["id"] != second.json()["id"]
    assert (
        first.json()["direction"] == "owner"
        and first.json()["telegram_message_id"] == 501
    )
    assert [entry[1] for entry in fake.sent] == ["First message", "Second message"]
    assert all(
        entry[2] == {"business_connection_id": "business-1"} for entry in fake.sent
    )
    async with sessions() as db:
        original = await db.get(TelegramBusinessMessage, original_id)
        assert (
            original.draft_status == "sent"
            and original.draft_text == "Already answered"
        )
        with pytest.raises(Exception) as denied:
            await service.check_automatic_reply_current(
                db, await db.get(TelegramIntegration, integration_id), original
            )
        assert denied.value.detail["code"] == "OWNER_ALREADY_REPLIED"
        ciphertext = (
            await db.execute(
                text("SELECT text FROM telegram_business_messages WHERE id=:id"),
                {"id": first.json()["id"]},
            )
        ).scalar_one()
        assert "First message" not in ciphertext


async def test_same_key_replays_success_but_changed_payload_conflicts(
    setup, monkeypatch
):
    client, _, fake, _ = await ready(setup, monkeypatch)
    key = str(uuid4())
    first = await send(client, key=key)
    retry = await send(client, key=key)
    assert (
        first.status_code == retry.status_code == 200 and first.json() == retry.json()
    )
    assert len(fake.sent) == 1
    conflict = await send(client, "Different text", key=key)
    assert (
        conflict.status_code == 409
        and conflict.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
    )


@pytest.mark.parametrize(
    "mode,code",
    [
        ("expired", "TELEGRAM_REPLY_WINDOW_EXPIRED"),
        ("denied", "TELEGRAM_REPLY_DENIED"),
        ("paused", "TELEGRAM_PAUSED"),
    ],
)
async def test_availability_and_send_enforce_window_permissions_pause(
    setup, monkeypatch, mode, code
):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    async with sessions() as db:
        incoming = (await db.execute(select(TelegramBusinessMessage))).scalar_one()
        if mode == "expired":
            incoming.sent_at = service.now() - timedelta(hours=24)
        if mode == "paused":
            (await db.get(TelegramIntegration, integration_id)).enabled = False
        if mode == "denied":
            from app.integrations.telegram_models import TelegramBusinessConnection

            (await db.get(TelegramBusinessConnection, "business-1")).rights = {
                "can_reply": False
            }
            fake.remote_connection = {
                **fake.remote_connection,
                "rights": {"can_reply": False},
            }
        await db.commit()
    chats = await client.get(PREFIX + "/chats")
    assert chats.status_code == 200, chats.text
    assert (
        chats.json()[0]["can_send"] is False
        and chats.json()[0]["send_disabled_code"] == code
    )
    result = await send(client)
    assert result.status_code in (403, 409) and result.json()["detail"]["code"] == code
    assert fake.sent == []


@pytest.mark.parametrize(
    "remote_error", [TelegramError("timeout"), TelegramError(500), TelegramError(403)]
)
async def test_failed_or_ambiguous_same_key_never_replays_transport(
    setup, monkeypatch, remote_error
):
    client, _, fake, _ = await ready(setup, monkeypatch)
    fake.send_error = remote_error
    key = str(uuid4())
    first = await send(client, key=key)
    retry = await send(client, key=key)
    assert first.status_code == retry.status_code == 503
    assert first.json()["detail"]["code"] == retry.json()["detail"]["code"]
    assert len(fake.sent) == 1


async def test_unknown_foreign_chat_and_missing_key_are_rejected(setup, monkeypatch):
    client, _, fake, _ = await ready(setup, monkeypatch)
    assert (await send(client, chat_id=999)).status_code == 404
    assert (await send(client, business_connection_id="foreign")).status_code == 404
    missing = await client.post(
        PREFIX + "/chats/send",
        json={
            "business_connection_id": "business-1",
            "chat_id": CUSTOMER,
            "text": "No key",
        },
    )
    assert missing.status_code == 422 and fake.sent == []


async def test_parallel_identical_key_has_durable_claim_before_one_transport(
    setup, monkeypatch
):
    client, sessions, fake, _ = await ready(setup, monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()
    original = fake.send_message

    async def waiting(self, *args, **kwargs):
        async with sessions() as db:
            state = (
                await db.execute(text("SELECT send_status FROM telegram_chat_sends"))
            ).scalar_one()
            assert state == "sending"
        entered.set()
        await release.wait()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(fake, "send_message", waiting)
    key = str(uuid4())
    pending = asyncio.create_task(send(client, key=key))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        retry = await send(client, key=key)
        assert (
            retry.status_code == 409
            and retry.json()["detail"]["code"] == "TELEGRAM_SEND_IN_PROGRESS"
        )
        release.set()
        assert (await pending).status_code == 200
        assert len(fake.sent) == 1
    finally:
        release.set()
        await pending


async def test_simultaneous_claim_insertion_uses_one_request_receipt(
    setup, monkeypatch
):
    client, _, fake, _ = await ready(setup, monkeypatch)
    original = fake.get_business_connection
    count = 0
    both = asyncio.Event()

    async def together(self, connection_id):
        nonlocal count
        count += 1
        if count == 2:
            both.set()
        await asyncio.wait_for(both.wait(), 5)
        return await original(self, connection_id)

    monkeypatch.setattr(fake, "get_business_connection", together)
    key = str(uuid4())
    results = await asyncio.gather(send(client, key=key), send(client, key=key))
    assert sorted(response.status_code for response in results) in (
        [200, 200],
        [200, 409],
    )
    assert len(fake.sent) == 1


async def test_manual_send_refreshes_remote_permission_before_transport(
    setup, monkeypatch
):
    client, _, fake, _ = await ready(setup, monkeypatch)
    assert (await client.get(PREFIX + "/chats")).json()[0]["can_send"] is True
    fake.remote_connection = {**fake.remote_connection, "rights": {"can_reply": False}}
    result = await send(client)
    assert (
        result.status_code == 403
        and result.json()["detail"]["code"] == "TELEGRAM_REPLY_DENIED"
    )
    assert fake.sent == []
    assert (await client.get(PREFIX + "/chats")).json()[0]["can_send"] is False


async def test_owner_echo_during_send_is_adopted_without_duplicate_line(
    setup, monkeypatch
):
    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    original = fake.send_message

    async def echoed(self, chat_id, body, **kwargs):
        await ingest(
            sessions,
            integration_id,
            message(3, body, sender=OWNER, message_id=501),
            fake,
        )
        return await original(self, chat_id, body, **kwargs)

    monkeypatch.setattr(fake, "send_message", echoed)
    assert (await send(client)).status_code == 200
    async with sessions() as db:
        rows = (
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
        assert len(rows) == 1 and rows[0].telegram_message_id == 501
    assert len(fake.sent) == 1


async def test_paused_or_disconnected_during_send_does_not_restore_purged_history(
    setup, monkeypatch
):
    client, sessions, fake, _ = await ready(setup, monkeypatch)

    async def disconnected(self, *args, **kwargs):
        assert (await client.post(PREFIX + "/disconnect")).status_code == 200
        return {"message_id": 501}

    monkeypatch.setattr(fake, "send_message", disconnected)
    result = await send(client)
    assert (
        result.status_code == 503
        and result.json()["detail"]["code"] == "TELEGRAM_DELIVERY_UNKNOWN"
    )
    async with sessions() as db:
        assert (await db.execute(select(TelegramBusinessMessage))).scalars().all() == []


async def test_policy_denial_never_claims_or_sends(setup, monkeypatch):
    from app.ai.errors import PolicyDenied
    from app.ai.policy import ServerPolicyEngine

    client, sessions, fake, _ = await ready(setup, monkeypatch)

    def denied(*args, **kwargs):
        raise PolicyDenied("not allowed")

    monkeypatch.setattr(ServerPolicyEngine, "authorize", denied)
    result = await send(client)
    assert result.status_code == 403, result.text
    assert fake.sent == []
    async with sessions() as db:
        assert (
            await db.execute(text("SELECT count(*) FROM telegram_chat_sends"))
        ).scalar_one() == 0


async def test_stale_claim_recovery_never_sends_and_keeps_unknown_receipt(
    setup, monkeypatch
):
    from app.integrations import telegram_chat
    from app.integrations.telegram_models import TelegramChatSend

    client, sessions, fake, integration_id = await ready(setup, monkeypatch)
    key = str(uuid4())
    async with sessions() as db:
        receipt = TelegramChatSend(
            owner_id=(await db.get(TelegramIntegration, integration_id)).owner_id,
            integration_id=integration_id,
            business_connection_id="business-1",
            chat_id=CUSTOMER,
            idempotency_key=key,
            request_hash=telegram_chat.fingerprint(
                "business-1", CUSTOMER, "First message"
            ),
            send_status="sending",
            updated_at=service.now() - timedelta(minutes=4),
        )
        db.add(receipt)
        await db.commit()
        await telegram_chat.recover_stale_sends(db)
        await db.commit()
        await db.refresh(receipt)
        assert (
            receipt.send_status == "unknown"
            and receipt.error_code == "TELEGRAM_DELIVERY_UNKNOWN"
        )
    assert (await send(client, key=key)).json()["detail"][
        "code"
    ] == "TELEGRAM_DELIVERY_UNKNOWN"
    assert fake.sent == []


async def test_manual_message_time_and_window_are_timezone_aware_on_sqlite(
    setup, monkeypatch
):
    from datetime import datetime

    client, _, _, _ = await ready(setup, monkeypatch)
    sent = await send(client)
    assert datetime.fromisoformat(sent.json()["sent_at"]).tzinfo is not None
    messages = (await client.get(PREFIX + "/messages")).json()
    assert all(
        datetime.fromisoformat(row["sent_at"]).tzinfo is not None for row in messages
    )
    expires = (await client.get(PREFIX + "/chats")).json()[0]["reply_window_expires_at"]
    assert datetime.fromisoformat(expires).tzinfo is not None


async def test_unconfigured_chat_list_is_empty_instead_of_hiding_connect_screen(setup):
    client,_,fake=setup
    response=await client.get(PREFIX+'/chats')
    assert response.status_code==200 and response.json()==[]
    assert fake.sent==[]
