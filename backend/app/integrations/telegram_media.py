"""Untrusted Telegram metadata and ephemeral, bounded media bytes.

No content, download paths, or decrypted credentials are persisted or logged.
The caller verifies the private owner identity before parsing/queuing metadata.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.ai.crypto import decrypt_secret

from .telegram_models import TelegramIntegration
from .telegram_personal import authorize
from .telegram_transport import TelegramError

LIMITS = {'voice': 20 * 1024 * 1024, 'audio': 20 * 1024 * 1024,
          'photo': 10 * 1024 * 1024, 'pdf': 20 * 1024 * 1024, 'text': 80_000, 'sticker': 512 * 1024}


@dataclass(frozen=True)
class TelegramMedia:
    kind: str
    file_id: str
    file_size: int | None = None
    mime_type: str | None = None
    filename: str | None = None
    emoji: str | None = None


class TelegramMediaError(Exception):
    """Locally chosen error codes only; never echo untrusted provider content."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _size(value: Any) -> int | None:
    return value if type(value) is int and 0 <= value <= 2**52 else None


def _metadata(kind: str, raw: Any) -> TelegramMedia:
    if not isinstance(raw, dict):
        return TelegramMedia('unsupported', '')
    file_id = raw.get('file_id')
    if not isinstance(file_id, str) or not 1 <= len(file_id) <= 512 or any(char.isspace() for char in file_id):
        return TelegramMedia('unsupported', '')
    mime, filename = raw.get('mime_type'), raw.get('file_name')
    return TelegramMedia(kind, file_id, _size(raw.get('file_size')),
                         mime[:100] if isinstance(mime, str) else None,
                         filename[:128] if isinstance(filename, str) else None)


def parse_owner_media(message: dict[str, Any]) -> TelegramMedia | None:
    """Classify verified owner media without downloading or trusting filenames."""
    if any(message.get(key) for key in ('forward_origin', 'forward_from', 'forward_from_chat',
                                       'sender_business_bot', 'business_connection_id')):
        return None
    for kind in ('voice', 'audio'):
        if kind in message:
            return _metadata(kind, message[kind])
    if 'photo' in message:
        photos = message['photo']
        if not isinstance(photos, list) or not photos:
            return TelegramMedia('unsupported', '')
        candidates = [photo for photo in photos if isinstance(photo, dict)]
        if not candidates:
            return TelegramMedia('unsupported', '')
        def resolution(photo: dict[str, Any]) -> tuple[int, int]:
            width, height = _size(photo.get('width')), _size(photo.get('height'))
            return (width or 0) * (height or 0), _size(photo.get('file_size')) or 0
        return _metadata('photo', max(candidates, key=resolution))
    if 'document' in message:
        document = message['document']
        mime = document.get('mime_type') if isinstance(document, dict) else None
        kind = {'application/pdf': 'pdf', 'text/plain': 'text'}.get(mime, 'unsupported') if isinstance(mime, str) else 'unsupported'
        return _metadata(kind, document)
    if any(key in message for key in ('video', 'video_note', 'animation', 'sticker', 'paid_media', 'live_photo')):
        return TelegramMedia('unsupported', '')
    return None


async def download_media(item: TelegramIntegration, media: TelegramMedia) -> bytes:
    """Fetch bytes only through owner policy, bounded before and during transfer."""
    from . import telegram_service as service

    limit = LIMITS.get(media.kind)
    if limit is None:
        raise TelegramMediaError('MEDIA_UNSUPPORTED')
    if (not isinstance(media.file_id, str) or not 1 <= len(media.file_id) <= 512
            or any(char.isspace() for char in media.file_id)
            or (media.file_size is not None and _size(media.file_size) is None)
            or (media.mime_type is not None and (not isinstance(media.mime_type, str) or len(media.mime_type) > 100))
            or (media.filename is not None and (not isinstance(media.filename, str) or len(media.filename) > 128))):
        raise TelegramMediaError('MEDIA_INVALID')
    if media.file_size is not None and media.file_size > limit:
        raise TelegramMediaError('MEDIA_TOO_LARGE')
    if not item.enabled or item.deleted_at or not item.encrypted_token or not item.owner_telegram_id:
        raise TelegramMediaError('MEDIA_NOT_CONFIGURED')
    authorize(item, 'telegram.download', external=True)
    try:
        async with service.TelegramClient(decrypt_secret(item.encrypted_token)) as client:
            metadata = await client.get_file(media.file_id)
            reported_size = metadata.get('file_size')
            if reported_size is not None:
                if _size(reported_size) is None:
                    raise TelegramMediaError('MEDIA_INVALID')
                if reported_size > limit:
                    raise TelegramMediaError('MEDIA_TOO_LARGE')
            path = metadata.get('file_path')
            if not isinstance(path, str):
                raise TelegramMediaError('MEDIA_INVALID')
            authorize(item, 'telegram.download', external=True)
            content = await client.download_file(path, limit)
    except TelegramError as exc:
        raise TelegramMediaError('MEDIA_TOO_LARGE' if exc.code == 'file_too_large' else 'MEDIA_INVALID') from None
    if len(content) > limit:
        raise TelegramMediaError('MEDIA_TOO_LARGE')
    if media.kind == 'text':
        try:
            decoded = content.decode('utf-8')
        except UnicodeDecodeError:
            raise TelegramMediaError('MEDIA_TEXT_INVALID') from None
        if len(decoded) > 20_000:
            raise TelegramMediaError('MEDIA_TOO_LARGE')
    return content
