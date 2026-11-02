"""On-demand private Business photo/audio viewing, with transient bounded bytes."""

from __future__ import annotations

import json
from datetime import timedelta

from app.ai.errors import PolicyDenied
from app.core.models import now
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import telegram_service as service
from .telegram_media import (
    TelegramMedia,
    TelegramMediaError,
    download_media,
    parse_owner_media,
)
from .telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramIntegration,
)


def parse_business_media(raw: dict) -> TelegramMedia | None:
    if any(
        raw.get(key)
        for key in (
            "forward_origin",
            "forward_from",
            "forward_from_chat",
            "sender_business_bot",
        )
    ):
        return None
    media = parse_owner_media(
        {key: raw[key] for key in ("voice", "audio", "photo") if key in raw}
    )
    return (
        media
        if media is not None and media.kind in {"photo", "voice", "audio"}
        else None
    )


def content_type(kind: str, data: bytes) -> str:
    if kind == "photo":
        if data.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if data[:6] in {b"GIF87a", b"GIF89a"}:
            return "image/gif"
        if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            return "image/webp"
    elif kind in {"voice", "audio"}:
        if data.startswith(b"OggS"):
            return "audio/ogg"
        if data.startswith(b"ID3") or (
            len(data) > 1 and data[0] == 255 and data[1] & 224 == 224
        ):
            return "audio/mpeg"
        if data[4:8] == b"ftyp":
            return "audio/mp4"
        if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
            return "audio/wav"
        if data.startswith(b"fLaC"):
            return "audio/flac"
        if data.startswith(b"\x1a\x45\xdf\xa3"):
            return "audio/webm"
    raise service.error(
        415,
        "TELEGRAM_MEDIA_UNSUPPORTED",
        "Этот формат нельзя безопасно показать в чате.",
    )


async def preview_media(
    db: AsyncSession, item: TelegramIntegration, message: TelegramBusinessMessage
) -> tuple[bytes, str]:
    if not item.enabled or not item.owner_telegram_id:
        raise service.error(409, "TELEGRAM_PAUSED", "Подключение приостановлено.")
    if not message.media_metadata or service.utc(message.sent_at) < now() - timedelta(
        days=7
    ):
        raise service.error(404, "NOT_FOUND", "Медиа недоступно.")
    connection = await db.get(
        TelegramBusinessConnection, message.business_connection_id
    )
    if (
        not connection
        or not connection.enabled
        or connection.owner_id != item.owner_id
        or connection.integration_id != item.id
        or connection.telegram_user_id != item.owner_telegram_id
    ):
        raise service.error(403, "TELEGRAM_REPLY_DENIED", "Подключение недоступно.")
    original = message.media_metadata
    token = item.encrypted_token
    message_id, owner_id = message.id, item.owner_id
    try:
        metadata = json.loads(original)
        media = TelegramMedia(**metadata)
        if media.kind not in {"photo", "voice", "audio"}:
            raise ValueError("unsupported")
    except (ValueError, TypeError):
        raise service.error(
            422, "TELEGRAM_MEDIA_INVALID", "Медиа недоступно."
        ) from None
    try:
        data = await download_media(item, media)
    except PolicyDenied:
        raise service.error(
            403, "POLICY_DENIED", "Просмотр запрещён политикой."
        ) from None
    except TelegramMediaError as exc:
        code = (
            "TELEGRAM_MEDIA_TOO_LARGE"
            if exc.code == "MEDIA_TOO_LARGE"
            else "TELEGRAM_MEDIA_UNAVAILABLE"
        )
        raise service.error(
            413 if exc.code == "MEDIA_TOO_LARGE" else 422,
            code,
            "Не удалось загрузить медиа Telegram.",
        ) from None
    current = (
        await db.execute(
            select(TelegramBusinessMessage)
            .where(
                TelegramBusinessMessage.id == message_id,
                TelegramBusinessMessage.owner_id == owner_id,
            )
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    current_item = await db.get(TelegramIntegration, item.id, populate_existing=True)
    current_connection = await db.get(
        TelegramBusinessConnection,
        message.business_connection_id,
        populate_existing=True,
    )
    if (
        current is None
        or current.deleted_at
        or current.media_metadata != original
        or current_item is None
        or current_item.deleted_at
        or not current_item.enabled
        or current_item.encrypted_token != token
        or not current_connection
        or not current_connection.enabled
        or current_connection.owner_id != owner_id
        or current_connection.integration_id != current_item.id
        or current_connection.telegram_user_id != current_item.owner_telegram_id
    ):
        raise service.error(404, "NOT_FOUND", "Медиа больше недоступно.")
    return data, content_type(media.kind, data)
