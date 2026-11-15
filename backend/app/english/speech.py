"""Speaking practice: owner-scoped BYOK transcription. Audio bytes live only for this request and are never stored or logged."""
from __future__ import annotations

import asyncio
import json
import logging
from decimal import ROUND_CEILING, Decimal
from typing import TYPE_CHECKING, cast
from uuid import uuid4

import httpx
from app.ai import api as ai_api
from app.ai.crypto import decrypt_secret
from app.core.db import get_db
from app.core.models import AIConversation, AIRun, now
from app.core.security import current_principal
from app.english.ai import fail
from app.integrations import telegram_transcription as provider_pattern
from app.sync.change_log import lock_owner
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from python_multipart import MultipartParser
from python_multipart.exceptions import MultipartParseError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.formparsers import parse_options_header

if TYPE_CHECKING:
    from python_multipart.multipart import MultipartCallbacks

router = APIRouter()

MAX_BYTES = 10 * 1024 * 1024
MAX_MULTIPART_OVERHEAD = 64 * 1024
MAX_BOUNDARY_BYTES = 200
EXTENSIONS = {"audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3"}
FAILURES = {"TRANSCRIPTION_NOT_CONFIGURED": (409, "Подключите провайдера распознавания речи в настройках"), "BUDGET_EXCEEDED": (429, "Месячный бюджет AI исчерпан")}


class TranscriptOut(BaseModel):
    text: str
    duration_sec: int | None


async def read_audio(incoming: Request) -> tuple[str, bytes]:
    """The audio media type and bytes of a multipart (field `audio`) or raw audio/* body, within MAX_BYTES."""
    content_type = incoming.headers.get("content-type", "")
    is_multipart = content_type.lower().startswith("multipart/form-data")
    if is_multipart:
        data, mime = await _read_multipart_audio(incoming)
    else:
        mime = content_type.split(";")[0].strip().lower()  # browsers send e.g. "audio/webm;codecs=opus"
        if mime not in EXTENSIONS:
            raise fail(415, "AUDIO_UNSUPPORTED", "Формат аудио не поддерживается")
        raw_data = bytearray()
        async for chunk in incoming.stream():
            if len(raw_data) + len(chunk) > MAX_BYTES:
                raise fail(413, "AUDIO_TOO_LARGE", "Запись длиннее 10 МБ")
            raw_data.extend(chunk)
        data = bytes(raw_data)
    mime = mime.split(";")[0].strip().lower()
    if mime not in EXTENSIONS:
        raise fail(415, "AUDIO_UNSUPPORTED", "Формат аудио не поддерживается")
    if not data:
        raise fail(422, "AUDIO_EMPTY", "Запись пустая")
    return mime, bytes(data)


async def _read_multipart_audio(incoming: Request) -> tuple[bytes, str]:
    """Parse one audio part into bounded memory without Starlette's spooled upload files."""
    try:
        _, params = parse_options_header(incoming.headers["content-type"])
        boundary = params[b"boundary"]
        if not boundary or len(boundary) > MAX_BOUNDARY_BYTES:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise fail(422, "AUDIO_INVALID", "Некорректная multipart-запись") from None

    total = 0
    part_count = 0
    audio_count = 0
    in_audio = False
    complete = False
    audio = bytearray()
    part_mime = ""
    disposition = bytearray()
    header_name = bytearray()
    header_value = bytearray()

    def on_part_begin() -> None:
        nonlocal part_count, in_audio, part_mime
        part_count += 1
        if part_count > 1:
            raise ValueError
        in_audio = False
        part_mime = ""
        disposition.clear()

    def on_header_field(data: bytes, start: int, end: int) -> None:
        header_name.extend(data[start:end])

    def on_header_value(data: bytes, start: int, end: int) -> None:
        header_value.extend(data[start:end])

    def on_header_end() -> None:
        nonlocal part_mime
        if header_name.lower() == b"content-disposition":
            disposition.extend(header_value)
        elif header_name.lower() == b"content-type":
            part_mime = header_value.decode("latin-1")
        header_name.clear()
        header_value.clear()

    def on_headers_finished() -> None:
        nonlocal in_audio, audio_count
        _, options = parse_options_header(bytes(disposition))
        in_audio = options.get(b"name") == b"audio" and b"filename" in options
        if in_audio:
            audio_count += 1
            if audio_count > 1:
                raise ValueError

    def on_part_data(data: bytes, start: int, end: int) -> None:
        if in_audio:
            if len(audio) + end - start > MAX_BYTES:
                raise OverflowError
            audio.extend(data[start:end])

    def on_end() -> None:
        nonlocal complete
        complete = True

    callbacks = cast('MultipartCallbacks', {
        "on_part_begin": on_part_begin,
        "on_header_field": on_header_field,
        "on_header_value": on_header_value,
        "on_header_end": on_header_end,
        "on_headers_finished": on_headers_finished,
        "on_part_data": on_part_data,
        "on_end": on_end,
    })
    try:
        parser = MultipartParser(boundary, callbacks, max_header_count=8, max_header_size=8192)
        # Parser diagnostics include offending bytes. Keep them request-local and silent.
        parser.logger = logging.Logger('aelys.audio.multipart')  # noqa: LOG001 - never mutate a shared logger
        parser.logger.disabled = True
        async for chunk in incoming.stream():
            total += len(chunk)
            if total > MAX_BYTES + MAX_MULTIPART_OVERHEAD:
                raise OverflowError
            parser.write(chunk)
        parser.finalize()
    except OverflowError:
        raise fail(413, "AUDIO_TOO_LARGE", "Запись длиннее 10 МБ") from None
    except (MultipartParseError, KeyError, TypeError, ValueError, RuntimeError):
        raise fail(422, "AUDIO_INVALID", "Некорректная multipart-запись") from None
    if not complete:
        raise fail(422, "AUDIO_INVALID", "Некорректная multipart-запись")
    if audio_count == 0:
        raise fail(422, "AUDIO_EMPTY", "Запись пустая")
    if part_count != 1:
        raise fail(422, "AUDIO_INVALID", "Некорректная multipart-запись")
    return bytes(audio), part_mime


@router.post("/english/speech/transcribe", response_model=TranscriptOut)
async def english_transcribe(incoming: Request, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    """Accepts multipart (field `audio`) or a raw audio/* body; the web app and the native bridge send raw bytes."""
    user, _ = principal
    mime, data = await read_audio(incoming)
    try:
        provider, secret = await provider_pattern.transcription_provider(db, user.id)
        try:
            estimate = Decimal(str(provider.model_policy_json.get("transcription_request_cost", "0.10")))
        except (ValueError, TypeError, ArithmeticError):
            raise provider_pattern.TranscriptionError("BUDGET_EXCEEDED") from None
        if not estimate.is_finite() or not Decimal("0.00000001") <= estimate <= Decimal("999999999999.99999999"):
            raise provider_pattern.TranscriptionError("BUDGET_EXCEEDED")
        estimate = estimate.quantize(Decimal("0.00000001"), rounding=ROUND_CEILING)
        await lock_owner(db, user.id)
        if estimate > await ai_api._remaining_monthly_budget(db, user.id, provider):
            raise provider_pattern.TranscriptionError("BUDGET_EXCEEDED")
    except provider_pattern.TranscriptionError as error:
        status, message = FAILURES.get(error.code, (502, "Не удалось распознать запись"))
        raise fail(status, error.code, message) from None
    model = str(provider.model_policy_json["default_model"])
    request = httpx.Request(
        "POST", ai_api._provider_base_url("transcription", provider.base_url) + "/v1/audio/transcriptions",
        headers={"authorization": f"Bearer {decrypt_secret(secret.encrypted_value)}"},
        data={"model": model, "response_format": "json"}, files={"file": (f"speech.{EXTENSIONS[mime]}", data, mime)},  # fixed name: client filenames never reach the provider
        extensions={"timeout": {"connect": 10.0, "read": 60.0, "write": 30.0, "pool": 10.0}})
    request.read()
    conversation = AIConversation(owner_id=user.id, title="English speech", tool_scope_json={})
    db.add(conversation)
    await db.flush()
    run = AIRun(owner_id=user.id, conversation_id=conversation.id, provider_id=provider.id, provider="transcription", model=model, status="running", started_at=now(), idempotency_key=f"english-transcription:{uuid4()}", cost_estimate=estimate, token_counts={"billing": "reserved_estimate"})
    db.add(run)
    await db.commit()  # the provider wait must not hold a DB writer
    transport = provider_pattern.transcription_transport()
    try:
        async with asyncio.timeout(75):
            response = await transport.handle_async_request(request)
            try:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > 100_000:
                        raise ValueError
                    body.extend(chunk)
                result = json.loads(body) if response.status_code == 200 else None
            finally:
                await response.aclose()
        text = result.get("text") if isinstance(result, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > 20_000:
            raise ValueError
        seconds = result.get("duration") if isinstance(result, dict) else None
        run.status, run.completed_at = "completed", now()
        await db.commit()
        return TranscriptOut(text=text.strip(), duration_sec=round(seconds) if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and 0 < seconds < 7200 else None)
    except Exception:  # noqa: BLE001 - transport URLs, bodies and keys never become errors or logs
        await db.rollback()
        run.status, run.completed_at = "failed", now()
        await db.commit()
        raise fail(502, "TRANSCRIPTION_UNAVAILABLE", "Не удалось распознать запись") from None
    finally:
        await transport.aclose()
