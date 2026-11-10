"""Separate owner BYOK audio transcription; bytes exist only during this call."""
from __future__ import annotations

import asyncio
from decimal import ROUND_CEILING, Decimal
from uuid import uuid4

import httpx
from app.ai import api as ai_api
from app.ai.crypto import decrypt_secret
from app.ai.defaults import feature_provider
from app.core.models import AIConversation, AIProvider, AIProviderSecret, AIRun, now
from app.sync.change_log import lock_owner
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .telegram_models import TelegramIntegration, TelegramPersonalJob
from .telegram_personal import authorize


class TranscriptionError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def transcription_transport() -> httpx.AsyncBaseTransport:
    return httpx.AsyncHTTPTransport(retries=0)


async def transcription_provider(db: AsyncSession, owner_id: str) -> tuple[AIProvider, AIProviderSecret]:
    chosen = await feature_provider(db, owner_id, 'transcription')
    if chosen is None or not str((chosen[0].model_policy_json or {}).get('default_model', '')).strip():
        raise TranscriptionError('TRANSCRIPTION_NOT_CONFIGURED')
    return chosen[0], chosen[1]


async def transcribe_audio(db: AsyncSession, item: TelegramIntegration, data: bytes,
                           mime_type: str, filename: str, *, request_id: str | None = None) -> str:
    provider, secret = await transcription_provider(db, item.owner_id)
    if len(data) > 20 * 1024 * 1024 or not data:
        raise TranscriptionError('MEDIA_TOO_LARGE')
    try:
        estimate = Decimal(str(provider.model_policy_json.get('transcription_request_cost', '0.10')))
    except (ValueError, TypeError, ArithmeticError):
        raise TranscriptionError('BUDGET_EXCEEDED') from None
    if not estimate.is_finite() or not Decimal('0.00000001') <= estimate <= Decimal('999999999999.99999999'):
        raise TranscriptionError('BUDGET_EXCEEDED')
    estimate = estimate.quantize(Decimal('0.00000001'), rounding=ROUND_CEILING)
    await lock_owner(db, item.owner_id)
    if estimate > await ai_api._remaining_monthly_budget(db, item.owner_id, provider):
        raise TranscriptionError('BUDGET_EXCEEDED')
    await db.refresh(item)
    if not item.enabled or item.deleted_at or not item.encrypted_token or not item.owner_telegram_id:
        raise TranscriptionError('TRANSCRIPTION_UNAVAILABLE')
    authorize(item, 'ai.transcribe', external=True)
    base = ai_api._provider_base_url('transcription', provider.base_url)
    model = str(provider.model_policy_json['default_model'])
    # Avoid untrusted filenames in multipart headers; MIME determines a safe name.
    extension = {'audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav',
                 'audio/x-wav':'wav','audio/mp4':'m4a','audio/webm':'webm','audio/flac':'flac'}.get(mime_type)
    if extension is None:
        raise TranscriptionError('MEDIA_UNSUPPORTED')
    request = httpx.Request('POST', base + '/v1/audio/transcriptions',
        headers={'authorization': f'Bearer {decrypt_secret(secret.encrypted_value)}'},
        data={'model':model,'response_format':'json'}, files={'file':(f'voice.{extension}',data,mime_type)},
        extensions={'timeout':{'connect':10.0,'read':60.0,'write':30.0,'pool':10.0}})
    request.read()  # in-memory multipart -> async-compatible ByteStream; no spool/file
    authorize(item, 'ai.personal.write')
    job = await db.get(TelegramPersonalJob, request_id) if request_id else None
    if job and (job.owner_id != item.owner_id or job.integration_id != item.id or job.state != 'running'):
        raise TranscriptionError('TRANSCRIPTION_UNAVAILABLE')
    conversation_id = job.conversation_id if job else item.personal_conversation_id
    conversation = await db.get(AIConversation, conversation_id) if conversation_id else None
    if not conversation or conversation.owner_id != item.owner_id or conversation.deleted_at:
        conversation = AIConversation(owner_id=item.owner_id, title='Telegram assistant')
        db.add(conversation); await db.flush()
        item.personal_conversation_id = conversation.id
    key = f'telegram-transcription:{request_id or uuid4()}'
    existing = (await db.execute(select(AIRun).where(AIRun.owner_id == item.owner_id, AIRun.idempotency_key == key))).scalar_one_or_none()
    if existing:
        raise TranscriptionError('TRANSCRIPTION_UNAVAILABLE')
    run = AIRun(owner_id=item.owner_id, conversation_id=conversation.id, provider_id=provider.id,
                provider='transcription', model=model, status='running', started_at=now(),
                idempotency_key=key, cost_estimate=estimate, token_counts={'billing':'reserved_estimate'})
    db.add(run)
    await db.flush()
    if job:
        job.run_id = run.id
    await db.commit()  # provider wait cannot retain a DB writer
    transport = transcription_transport()
    try:
        async with asyncio.timeout(75):
            response = await transport.handle_async_request(request)
            try:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > 100_000:
                        raise TranscriptionError('TRANSCRIPTION_UNAVAILABLE')
                    body.extend(chunk)
                if response.status_code != 200:
                    raise TranscriptionError('TRANSCRIPTION_UNAVAILABLE')
                import json
                result = json.loads(body)
                transcript = result.get('text') if isinstance(result, dict) else None
                if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 20_000:
                    raise TranscriptionError('TRANSCRIPTION_UNAVAILABLE')
                authorize(item, 'ai.personal.write')
                run.status, run.completed_at = 'completed', now()
                await db.commit()
                return transcript.strip()
            finally:
                await response.aclose()
    except Exception:  # noqa: BLE001 - transport URLs, body and keys never become errors/logs
        await db.rollback()
        await db.refresh(run)
        await db.refresh(item)
        authorize(item, 'ai.personal.write')
        run.status, run.completed_at = 'failed', now()
        await db.commit()
        raise TranscriptionError('TRANSCRIPTION_UNAVAILABLE') from None
    finally:
        await transport.aclose()
