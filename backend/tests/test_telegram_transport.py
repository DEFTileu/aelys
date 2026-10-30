import json
import logging

import httpx
import pytest
from app.integrations.telegram_transport import TelegramClient, TelegramError

TOKEN = "12345:secret_token"


@pytest.mark.asyncio
async def test_methods_and_payloads(caplog):
    requests = []

    def handler(request):
        requests.append(request)
        method = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(200, json={"ok": True, "result": [] if method == "getUpdates" else {"id": 1}})

    with caplog.at_level(logging.DEBUG):
        async with TelegramClient(TOKEN, httpx.MockTransport(handler)) as client:
            assert await client.get_me() == {"id": 1}
            assert await client.get_webhook_info() == {"id": 1}
            assert await client.get_updates(42) == []
            assert await client.get_business_connection("bc") == {"id": 1}
            assert await client.send_message(7, "hello", business_connection_id="bc", reply_to_message_id=9) == {"id": 1}
    assert [r.url.path for r in requests] == [f"/bot{TOKEN}/{name}" for name in ("getMe", "getWebhookInfo", "getUpdates", "getBusinessConnection", "sendMessage")]
    assert all(r.method == "POST" and r.url.host == "api.telegram.org" and r.url.scheme == "https" for r in requests)
    bodies = [json.loads(r.content) for r in requests]
    assert bodies[:2] == [{}, {}]
    assert bodies[2] == {"offset": 42, "timeout": 20, "allowed_updates": ["message", "business_connection", "business_message", "edited_business_message", "deleted_business_messages"]}
    assert bodies[3] == {"business_connection_id": "bc"}
    assert bodies[4] == {"chat_id": 7, "text": "hello", "business_connection_id": "bc", "reply_parameters": {"message_id": 9}, "link_preview_options": {"is_disabled": True}}
    assert TOKEN not in caplog.text
    assert "hello" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("status,body,code", [
    (200, b"not-json", "invalid_response"),
    (200, b"[]", "invalid_response"),
    (200, b'{"ok":true,"result":null}', "invalid_response"),
    (200, b'{"ok":false,"description":"12345:secret_token"}', "api_error"),
    (500, b"12345:secret_token", 500),
    (302, b"redirect", 302),
])
async def test_sanitized_invalid_responses(status, body, code):
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda _: httpx.Response(status, content=body, headers={"location": "https://example.com"}))) as client:
        with pytest.raises(TelegramError) as exc:
            await client.get_me()
    assert exc.value.code == code
    assert TOKEN not in str(exc.value)
    assert "secret" not in repr(exc.value)


@pytest.mark.asyncio
async def test_rate_limit_and_transport_exception_redaction():
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda _: httpx.Response(429, json={"ok": False, "description": TOKEN, "parameters": {"retry_after": 8}}))) as client:
        with pytest.raises(TelegramError) as exc:
            await client.get_me()
        assert (exc.value.code, exc.value.retry_after) == (429, 8)
        assert TOKEN not in str(exc.value)

    def timeout(request):
        raise httpx.ReadTimeout(f"failure {TOKEN}", request=request)

    async with TelegramClient(TOKEN, httpx.MockTransport(timeout)) as client:
        with pytest.raises(TelegramError) as exc:
            await client.get_me()
        assert exc.value.code == "timeout"
        assert TOKEN not in str(exc.value)
        assert exc.value.__suppress_context__


@pytest.mark.asyncio
async def test_invalid_update_shapes_and_text_limits():
    async with TelegramClient(TOKEN, httpx.MockTransport(lambda _: httpx.Response(200, json={"ok": True, "result": [1]}))) as client:
        with pytest.raises(TelegramError, match="invalid_response"):
            await client.get_updates(1)
        with pytest.raises(ValueError):
            await client.get_updates(1, timeout=51)
        with pytest.raises(ValueError):
            await client.send_message(1, "x" * 4097)
        with pytest.raises(ValueError):
            await client.send_message(1, "")


def test_httpx_log_filter_suppresses_only_telegram_urls(caplog):
    logger = logging.getLogger("httpx")
    with caplog.at_level(logging.INFO):
        logger.info("HTTP Request: %s", f"https://api.telegram.org/bot{TOKEN}/getMe")
        logger.info("HTTP Request: %s", "https://example.com/resource")
    assert TOKEN not in caplog.text
    assert "example.com/resource" in caplog.text


def test_token_cannot_change_url():
    with pytest.raises(ValueError, match="invalid Telegram token"):
        TelegramClient("secret/../../elsewhere")


@pytest.mark.asyncio
async def test_unexpected_transport_error_is_sanitized():
    def fail(request):
        raise RuntimeError(f"unexpected {TOKEN}")

    async with TelegramClient(TOKEN, httpx.MockTransport(fail)) as client:
        with pytest.raises(TelegramError) as exc:
            await client.get_me()
    assert exc.value.code == "network_error"
    assert TOKEN not in str(exc.value)
    assert exc.value.__suppress_context__
