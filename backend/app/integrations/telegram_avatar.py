"""Chat avatars: fetched from Telegram on demand and cached in server memory only.

Nothing is written to the database or disk; entries expire and the cache is bounded,
so a restart or an owner disconnect leaves no profile pictures behind.
"""
from __future__ import annotations

import time
from collections import OrderedDict

from app.ai.crypto import decrypt_secret

from . import telegram_service as service
from .telegram_business_media import content_type
from .telegram_models import TelegramIntegration
from .telegram_transport import TelegramClient, TelegramError

AVATAR_TTL = 6 * 3600
MISSING_TTL = 3600
MAX_ENTRIES = 256
MAX_BYTES = 512 * 1024
# (integration_id, chat_id) -> (expires_at, bytes | None, content_type)
_cache: OrderedDict[tuple[str, int], tuple[float, bytes | None, str]] = OrderedDict()


def forget(integration_id: str) -> None:
    for key in [k for k in _cache if k[0] == integration_id]:
        _cache.pop(key, None)


async def chat_avatar(item: TelegramIntegration, chat_id: int) -> tuple[bytes, str]:
    if not item.enabled or item.deleted_at or not item.encrypted_token:
        raise service.error(409, "TELEGRAM_PAUSED", "Подключение приостановлено.")
    key = (item.id, chat_id)
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        _cache.move_to_end(key)
        if hit[1] is None:
            raise service.error(404, "NOT_FOUND", "Аватар недоступен.")
        return hit[1], hit[2]
    data: bytes | None = None
    try:
        async with TelegramClient(decrypt_secret(item.encrypted_token)) as client:
            photos = await client.get_user_profile_photos(chat_id)
            groups = photos.get("photos") if isinstance(photos, dict) else None
            sizes = groups[0] if isinstance(groups, list) and groups and isinstance(groups[0], list) else []
            # Smallest rendition that is at least 100px wide; fall back to the first one.
            pick = next((s for s in sizes if isinstance(s, dict) and (s.get("width") or 0) >= 100), sizes[0] if sizes else None)
            if isinstance(pick, dict) and isinstance(pick.get("file_id"), str):
                meta = await client.get_file(pick["file_id"])
                path = meta.get("file_path")
                if isinstance(path, str):
                    data = await client.download_file(path, MAX_BYTES)
    except TelegramError:
        raise service.error(503, "TELEGRAM_UNAVAILABLE", "Telegram недоступен.") from None
    kind = None
    if data:
        try:
            kind = content_type("photo", data)
        except Exception:  # noqa: BLE001 - unrecognised bytes are treated as no avatar
            data = None
    ttl = AVATAR_TTL if data else MISSING_TTL
    _cache[key] = (time.monotonic() + ttl, data, kind or "")
    _cache.move_to_end(key)
    while len(_cache) > MAX_ENTRIES:
        _cache.popitem(last=False)
    if data is None or kind is None:
        raise service.error(404, "NOT_FOUND", "Аватар недоступен.")
    return data, kind
