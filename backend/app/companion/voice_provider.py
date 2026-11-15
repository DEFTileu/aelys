"""ElevenLabs voice transport. Audio remains in memory and errors are redacted."""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from decimal import ROUND_CEILING, Decimal
from urllib.parse import quote

import httpx
from app.ai.defaults import feature_provider
from app.core.models import AIProvider, AIProviderSecret, AIRun
from app.sync.change_log import lock_owner
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULT_VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2'  # Alice, a premade voice: free accounts get 402 paid_plan_required for library voices
_BASE = 'https://api.elevenlabs.io'


class VoiceError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def voice_transport() -> httpx.AsyncBaseTransport:
    return httpx.AsyncHTTPTransport(retries=0)


async def voice_provider(db: AsyncSession, owner_id: str) -> tuple[AIProvider, AIProviderSecret]:
    chosen = await feature_provider(db, owner_id, 'voice')
    if not chosen:
        raise VoiceError('VOICE_NOT_CONFIGURED')
    return chosen[0], chosen[1]


# The owner speaks Russian, Kazakh or English. On a short phrase Scribe can guess another language (Portuguese was seen) and then
# returns gibberish in it: such a guess is transcribed again as Russian.
VOICE_LANGUAGES = frozenset({'ru', 'rus', 'kk', 'kaz', 'en', 'eng'})


async def _scribe(provider: AIProvider, key: str, upload: tuple[str, bytes, str], file_format: str | None, language: str | None) -> dict:
    transport = voice_transport()
    try:
        fields = {'model_id': (provider.model_policy_json or {}).get('stt_model', 'scribe_v1')}
        if file_format:
            fields['file_format'] = file_format
        if language:
            fields['language_code'] = language
        request = httpx.Request('POST', _BASE + '/v1/speech-to-text', headers={'xi-api-key': key}, data=fields, files={'file': upload})
        request.read()
        async with asyncio.timeout(30):
            response = await transport.handle_async_request(request)
            try:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > 100_000:
                        raise VoiceError('VOICE_UNAVAILABLE')
                    body.extend(chunk)
                if response.status_code != 200:
                    raise VoiceError('VOICE_UNAVAILABLE')
                data = json.loads(body)
                if not isinstance(data, dict) or not isinstance(data.get('text'), str):
                    raise VoiceError('VOICE_UNAVAILABLE')
                return data
            finally:
                await response.aclose()
    except VoiceError:
        raise
    except Exception:  # noqa: BLE001 - external failures are redacted
        raise VoiceError('VOICE_UNAVAILABLE') from None
    finally:
        await transport.aclose()


async def transcribe(provider: AIProvider, key: str, upload: tuple[str, bytes, str], file_format: str | None = None, *,
                     before_retry: Callable[[], Awaitable[None]] | None = None) -> str:
    """upload is the multipart file (name, bytes, media type); file_format names raw PCM, None lets Scribe read a container."""
    data = await _scribe(provider, key, upload, file_format, None)
    detected = data.get('language_code')
    if isinstance(detected, str) and detected.lower() not in VOICE_LANGUAGES:
        if before_retry is not None:
            await before_retry()
        data = await _scribe(provider, key, upload, file_format, 'rus')
    text = data['text'].strip()
    if not text:
        raise VoiceError('VOICE_EMPTY')
    return text


async def transcribe_pcm(provider: AIProvider, key: str, pcm: bytes, *, before_retry: Callable[[], Awaitable[None]] | None = None) -> str:
    return await transcribe(provider, key, ('voice.pcm', pcm, 'application/octet-stream'), 'pcm_s16le_16', before_retry=before_retry)


async def reserve_retry(db: AsyncSession, owner_id: str, provider: AIProvider, run: AIRun) -> None:
    """A language retry is another billable provider request, reserved before sending."""
    from app.ai.api import _remaining_monthly_budget

    await lock_owner(db, owner_id)
    estimate = request_estimate(provider)
    if estimate > await _remaining_monthly_budget(db, owner_id, provider):
        raise VoiceError('BUDGET_EXCEEDED')
    run.cost_estimate += estimate
    await db.commit()


def request_estimate(provider: AIProvider) -> Decimal:
    """The reserved cost of one voice request; a bad policy value reads as no budget left."""
    try:
        estimate = Decimal(str((provider.model_policy_json or {}).get('voice_request_cost', '0.05')))
        if not estimate.is_finite() or not Decimal('0.00000001') <= estimate <= Decimal('999999999999.99999999'):
            raise ValueError()
        return estimate.quantize(Decimal('0.00000001'), rounding=ROUND_CEILING)
    except (ValueError, TypeError, ArithmeticError):
        raise VoiceError('BUDGET_EXCEEDED') from None


async def _tts(provider: AIProvider, key: str, text: str, output_format: str) -> AsyncIterator[bytes]:
    transport = voice_transport()
    try:
        policy = provider.model_policy_json or {}
        voice_id = quote(str(policy.get('voice_id') or DEFAULT_VOICE_ID), safe='')
        request = httpx.Request('POST', f'{_BASE}/v1/text-to-speech/{voice_id}/stream',
            params={'output_format': output_format}, headers={'xi-api-key': key},
            json={'text': text, 'model_id': policy.get('tts_model') or policy.get('default_model') or 'eleven_flash_v2_5'})
        async with asyncio.timeout(60):
            response = await transport.handle_async_request(request)
            try:
                if response.status_code != 200:
                    raise VoiceError('VOICE_UNAVAILABLE')
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()
    except VoiceError:
        raise
    except Exception:  # noqa: BLE001 - external failures are redacted
        raise VoiceError('VOICE_UNAVAILABLE') from None
    finally:
        await transport.aclose()


async def speak_pcm(provider: AIProvider, key: str, text: str) -> AsyncIterator[bytes]:
    pending = b''
    async for chunk in _tts(provider, key, text, 'pcm_16000'):
        pending += chunk
        while len(pending) >= 4096:
            yield pending[:4096]
            pending = pending[4096:]
        size = len(pending) & ~1
        if size:
            yield pending[:size]
            pending = pending[size:]


SPEAK_MAX_BYTES = 4 * 1024 * 1024


async def speak_mp3(provider: AIProvider, key: str, text: str) -> bytes:
    """The whole reply as MP3 for the apps' players (64 kbps, about 8 KB a second)."""
    audio = bytearray()
    async for chunk in _tts(provider, key, text, 'mp3_44100_64'):
        if len(audio) + len(chunk) > SPEAK_MAX_BYTES:
            raise VoiceError('VOICE_UNAVAILABLE')
        audio.extend(chunk)
    if not audio:
        raise VoiceError('VOICE_UNAVAILABLE')
    return bytes(audio)
