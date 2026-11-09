"""Speaking practice: owner-scoped BYOK transcription. Audio bytes live only for this request and are never stored or logged."""
from __future__ import annotations

import asyncio
import json
from decimal import ROUND_CEILING, Decimal
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
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import UploadFile

router = APIRouter()

MAX_BYTES = 10 * 1024 * 1024
EXTENSIONS = {"audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3"}
FAILURES = {"TRANSCRIPTION_NOT_CONFIGURED": (409, "Подключите провайдера распознавания речи в настройках"), "BUDGET_EXCEEDED": (429, "Месячный бюджет AI исчерпан")}


class TranscriptOut(BaseModel):
    text: str
    duration_sec: int | None


@router.post("/english/speech/transcribe", response_model=TranscriptOut)
async def english_transcribe(incoming: Request, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    """Accepts multipart (field `audio`) or a raw audio/* body; the web app and the native bridge send raw bytes."""
    user, _ = principal
    content_type, audio = incoming.headers.get("content-type", ""), None
    if content_type.lower().startswith("multipart/form-data"):
        field = (await incoming.form()).get("audio")
        if not isinstance(field, UploadFile):
            raise fail(422, "AUDIO_EMPTY", "Запись пустая")
        audio, content_type = field, field.content_type or ""
    mime = content_type.split(";")[0].strip().lower()  # browsers send e.g. "audio/webm;codecs=opus"
    if mime not in EXTENSIONS:
        raise fail(415, "AUDIO_UNSUPPORTED", "Формат аудио не поддерживается")
    if audio is not None:
        data = await audio.read(MAX_BYTES + 1)  # shortcut: Starlette may spool the multipart body to a temp file first, so size is checked after parsing
    else:
        data = b""
        async for chunk in incoming.stream():
            data += chunk
            if len(data) > MAX_BYTES:
                break
    if len(data) > MAX_BYTES:
        raise fail(413, "AUDIO_TOO_LARGE", "Запись длиннее 10 МБ")
    if not data:
        raise fail(422, "AUDIO_EMPTY", "Запись пустая")
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
