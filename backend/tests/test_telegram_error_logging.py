"""Verify that caught Telegram errors are always logged with context and without secrets."""
from __future__ import annotations

import asyncio
import logging

import httpx
import pytest
from app.ai import api as ai_api
from app.core.models import now
from app.integrations import telegram_answer_trace as trace_mod
from app.integrations import telegram_guest as guest
from app.integrations import telegram_service as service
from app.integrations.telegram_models import (
    TelegramBusinessMessage,
    TelegramIntegration,
)
from app.integrations.telegram_transport import TelegramClient, TelegramError
from test_telegram_answer_trace import headers, signed
from test_telegram_business import OWNER, TOKEN
from test_telegram_guest import guest_update
from test_telegram_personal import bound
from test_telegram_personal_dialogue import Service, provider

pytest_plugins = ("test_telegram_business",)


async def test_guest_delivery_and_turn_failures_log_traceback_without_secrets(setup, monkeypatch, caplog):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)

    class FailingModel(Service):
        async def complete(self, run_id, request, messages, **kwargs):
            raise RuntimeError("synthetic model crash")

    monkeypatch.setattr(ai_api, "_service", lambda *args, **kwargs: FailingModel())

    async def failing_telegram(request):
        raise httpx.ReadTimeout("timeout")

    fake.updates = [guest_update(201, "@aelys_ibot проверь ошибку", query_id="gq-secret-201")]
    await service.poll_once(integration_id, timeout=0)

    with caplog.at_level(logging.WARNING), monkeypatch.context() as mock:
        mock.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(failing_telegram)))
        await guest.guest_iteration(integration_id)
        await guest.wait_for_guest_turns()

    turn_errors = [r for r in caplog.records if r.message == "Telegram guest turn failed"]
    assert len(turn_errors) == 1
    assert turn_errors[0].levelno == logging.ERROR
    assert turn_errors[0].exc_info is not None and turn_errors[0].exc_info[0] is RuntimeError

    delivery_errors = [r for r in caplog.records if r.message == "Telegram guest reply delivery failed"]
    assert len(delivery_errors) == 1
    assert delivery_errors[0].levelno == logging.ERROR
    assert delivery_errors[0].exc_info is not None and delivery_errors[0].exc_info[0] is TelegramError

    assert TOKEN not in caplog.text
    assert "gq-secret-201" not in caplog.text


async def test_guest_timeout_and_background_task_crash_are_logged(setup, monkeypatch, caplog):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)

    async def slow_process(job_id: str) -> None:
        await asyncio.sleep(5)

    monkeypatch.setattr(guest, "_process", slow_process)
    monkeypatch.setattr(guest, "GUEST_TIMEOUT_SECONDS", 0.01)

    fake.updates = [guest_update(202, "@aelys_ibot таймаут", query_id="gq-timeout")]
    await service.poll_once(integration_id, timeout=0)

    with caplog.at_level(logging.ERROR):
        await guest.guest_iteration(integration_id)
        await guest.wait_for_guest_turns()

    timeout_logs = [r for r in caplog.records if r.message == "Telegram guest turn timed out"]
    assert len(timeout_logs) == 1
    assert timeout_logs[0].exc_info is not None

    # Now verify unhandled background task crash logs immediately via done_callback
    caplog.clear()

    async def exploding_bounded(job_id: str) -> None:
        raise RuntimeError("background boom")

    monkeypatch.setattr(guest, "_bounded_process", exploding_bounded)
    fake.updates = [guest_update(203, "@aelys_ibot краш", query_id="gq-crash")]
    await service.poll_once(integration_id, timeout=0)

    with caplog.at_level(logging.ERROR):
        await guest.guest_iteration(integration_id)
        task = guest._active_guest_turns[integration_id]
        with pytest.raises(RuntimeError, match="background boom"):
            await task
        await asyncio.sleep(0)

    bg_logs = [r for r in caplog.records if r.message == "Unhandled exception in Telegram guest background task"]
    assert len(bg_logs) == 1
    assert bg_logs[0].exc_info is not None and bg_logs[0].exc_info[0] is RuntimeError
    guest._active_guest_turns.clear()
    guest._active_guest_jobs.clear()


async def test_answer_trace_route_500_and_decrypt_and_initdata_errors_are_logged(setup, monkeypatch, caplog):
    client, sessions, _, integration_id = await bound(setup)
    bad_init_data = "user=not-json&auth_date=1&hash=" + "a" * 64

    with caplog.at_level(logging.WARNING):
        res_bad = await client.get(
            "/api/v1/telegram/answer-trace/00000000-0000-0000-0000-000000000000",
            headers=headers(bad_init_data),
        )
    assert res_bad.status_code == 401
    assert any(r.message == "Rejected invalid Telegram Mini App initData" for r in caplog.records)
    assert bad_init_data not in caplog.text

    # Corrupt encrypted token to trigger decrypt_secret failure log
    caplog.clear()
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        original = item.encrypted_token
        item.encrypted_token = "corrupted-ciphertext"
        await db.commit()

    with caplog.at_level(logging.ERROR):
        res_corrupt = await client.get(
            "/api/v1/telegram/answer-trace/00000000-0000-0000-0000-000000000000",
            headers=headers(signed(token=TOKEN, user_id=OWNER)),
        )
    assert res_corrupt.status_code == 401
    decrypt_logs = [
        r
        for r in caplog.records
        if r.message == "Failed to decrypt Telegram integration token during answer trace authentication"
    ]
    assert len(decrypt_logs) == 1 and decrypt_logs[0].exc_info is not None

    # Restore token and force an unexpected 500 inside _TraceRoute
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        item.encrypted_token = original
        await db.commit()

    caplog.clear()
    monkeypatch.setattr(trace_mod, "authorize", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("trace boom")))
    auth_header = signed(token=TOKEN, user_id=OWNER)
    with caplog.at_level(logging.ERROR):
        res_500 = await client.get(
            "/api/v1/telegram/answer-trace/00000000-0000-0000-0000-000000000000",
            headers=headers(auth_header),
        )
    assert res_500.status_code == 500
    assert res_500.json() == {"detail": {"code": "INTERNAL_ERROR", "message": "Answer trace unavailable"}}
    err_logs = [r for r in caplog.records if r.message == "Unhandled error while serving Telegram answer trace"]
    assert len(err_logs) == 1 and err_logs[0].exc_info is not None and err_logs[0].exc_info[0] is RuntimeError
    assert auth_header not in caplog.text
    assert TOKEN not in caplog.text


async def test_service_poll_integration_safely_and_transport_and_media_log_errors(setup, monkeypatch, caplog):
    _, _, _, integration_id = await bound(setup)

    async def boom(_integration_id: str):
        raise RuntimeError("poll boom")

    monkeypatch.setattr(service, "poll_once", boom)
    with caplog.at_level(logging.ERROR):
        ok = await service.poll_integration_safely(integration_id)
    assert ok is False
    poll_logs = [r for r in caplog.records if r.message == "Telegram integration poll iteration failed"]
    assert len(poll_logs) == 1 and poll_logs[0].exc_info is not None

    # Transport errors log warning/error with method and error_type, never leaking token
    caplog.clear()

    def failing_handler(request):
        raise httpx.ConnectError(f"failed connecting to https://api.telegram.org/bot{TOKEN}/getMe")

    with caplog.at_level(logging.WARNING):
        async with TelegramClient(TOKEN, httpx.MockTransport(failing_handler)) as tg_client:
            with pytest.raises(TelegramError):
                await tg_client.get_me()
    assert any(r.message == "Telegram API HTTP transport error" for r in caplog.records)
    assert TOKEN not in caplog.text

    # Corrupted TelegramBusinessMessage.media_metadata logs exception before returning None
    caplog.clear()
    msg = TelegramBusinessMessage(
        id="msg-1",
        owner_id="owner",
        integration_id=integration_id,
        business_connection_id="bc-1",
        chat_id=1,
        telegram_message_id=1,
        sent_at=now(),
        media_metadata="{not-valid-json",
    )
    with caplog.at_level(logging.ERROR):
        assert msg.media is None
    media_logs = [
        r for r in caplog.records if r.message == "Failed to parse persisted TelegramBusinessMessage.media_metadata"
    ]
    assert len(media_logs) == 1 and media_logs[0].exc_info is not None
