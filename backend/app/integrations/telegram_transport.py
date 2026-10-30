"""Minimal Telegram Bot API transport. Credentials never enter application logs."""

import asyncio
import logging
import re
from types import TracebackType
from typing import Any, Self

import httpx

_ALLOWED_UPDATES = (
    "message",
    "business_connection",
    "business_message",
    "edited_business_message",
    "deleted_business_messages",
)


class _TelegramLogFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        # Suppress the whole record: URLs, errors and bodies may contain secrets.
        return not re.search(r"api\.telegram\.org/bot", message, re.IGNORECASE)


# HTTPX client INFO logging is avoided below; these filters also protect against
# request URLs emitted by HTTPX/httpcore diagnostics enabled by the host app.
_log_filter = _TelegramLogFilter()
for _name in ("httpx", "httpcore", "httpcore.connection", "httpcore.http11", "httpcore.http2", "httpcore.proxy", "httpcore.socks_proxy"):
    logging.getLogger(_name).addFilter(_log_filter)


class TelegramError(Exception):
    """A sanitized failure; provider descriptions and request URLs are discarded."""

    def __init__(self, code: int | str, retry_after: int | None = None) -> None:
        # Only locally chosen strings or HTTP status codes should reach this class.
        self.code = code
        self.retry_after = retry_after
        super().__init__(f"Telegram request failed ({code})")


class TelegramClient:
    def __init__(
        self, token: str, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        if not re.fullmatch(r"[A-Za-z0-9_:-]+", token):
            raise ValueError("invalid Telegram token")
        self._token = token
        self._transport = transport if transport is not None else httpx.AsyncHTTPTransport(retries=0)

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._transport.aclose()

    async def _request(self, method: str, payload: dict[str, Any], *, read_timeout: float = 30.0) -> Any:
        # Going directly through the transport avoids HTTPX's INFO request log,
        # which otherwise includes the bot token in the URL. It also never follows redirects.
        request = httpx.Request(
            "POST",
            f"https://api.telegram.org/bot{self._token}/{method}",
            json=payload,
            extensions={"timeout": {"connect": 10.0, "read": read_timeout, "write": 10.0, "pool": 10.0}},
        )
        try:
            async with asyncio.timeout(read_timeout + 30.0):
                response = await self._transport.handle_async_request(request)
                try:
                    await response.aread()
                finally:
                    await response.aclose()
        except (httpx.TimeoutException, TimeoutError):
            raise TelegramError("timeout") from None
        except httpx.HTTPError:
            raise TelegramError("network_error") from None
        except Exception:  # noqa: BLE001 - custom transport errors may contain bot URLs
            raise TelegramError("network_error") from None

        status = response.status_code
        try:
            data = response.json()
        except (ValueError, UnicodeDecodeError):
            raise TelegramError(status if status >= 300 else "invalid_response") from None
        if not isinstance(data, dict):
            raise TelegramError(status if status >= 300 else "invalid_response")
        if status < 200 or status >= 300 or data.get("ok") is False:
            retry_after = None
            params = data.get("parameters")
            if status == 429 and isinstance(params, dict):
                value = params.get("retry_after")
                if type(value) is int and value >= 0:
                    retry_after = value
            # Never trust arbitrary error_code values or descriptions from the provider.
            provider_code = data.get("error_code")
            code = status if status >= 300 else provider_code if type(provider_code) is int and 400 <= provider_code <= 599 else "api_error"
            raise TelegramError(code, retry_after)
        if data.get("ok") is not True or "result" not in data:
            raise TelegramError("invalid_response")
        return data["result"]

    async def _object(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        result = await self._request(method, payload)
        if not isinstance(result, dict):
            raise TelegramError("invalid_response")
        return result

    async def get_me(self) -> dict[str, Any]:
        return await self._object("getMe", {})

    async def get_webhook_info(self) -> dict[str, Any]:
        return await self._object("getWebhookInfo", {})

    async def get_updates(self, offset: int, timeout: int = 20) -> list[dict[str, Any]]:
        if type(timeout) is not int or not 0 <= timeout <= 50:
            raise ValueError("timeout must be between 0 and 50 seconds")
        result = await self._request(
            "getUpdates",
            {"offset": offset, "timeout": timeout, "allowed_updates": list(_ALLOWED_UPDATES)},
            read_timeout=float(timeout + 10),
        )
        if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
            raise TelegramError("invalid_response")
        return result

    async def get_business_connection(self, id: str) -> dict[str, Any]:
        return await self._object("getBusinessConnection", {"business_connection_id": id})

    async def send_message(
        self, chat_id: int, text: str, *, business_connection_id: str | None = None,
        reply_to_message_id: int | None = None,
    ) -> dict[str, Any]:
        if not 1 <= len(text) <= 4096:
            raise ValueError("message text must contain 1 to 4096 characters")
        payload: dict[str, Any] = {
            "chat_id": chat_id, "text": text, "link_preview_options": {"is_disabled": True}
        }
        if business_connection_id is not None:
            payload["business_connection_id"] = business_connection_id
        if reply_to_message_id is not None:
            payload["reply_parameters"] = {"message_id": reply_to_message_id}
        return await self._object("sendMessage", payload)
