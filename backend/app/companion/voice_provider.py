"""ElevenLabs voice transport. Audio remains in memory and errors are redacted."""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from urllib.parse import quote

import httpx
from app.ai.defaults import feature_provider
from app.core.models import AIProvider, AIProviderSecret
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


async def transcribe_pcm(provider: AIProvider, key: str, pcm: bytes) -> str:
    transport = voice_transport()
    try:
        request = httpx.Request('POST', _BASE + '/v1/speech-to-text', headers={'xi-api-key': key},
            data={'model_id': (provider.model_policy_json or {}).get('stt_model', 'scribe_v1'), 'file_format': 'pcm_s16le_16'},
            files={'file': ('voice.pcm', pcm, 'application/octet-stream')})
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
                text = data.get('text') if isinstance(data, dict) else None
                if not isinstance(text, str):
                    raise VoiceError('VOICE_UNAVAILABLE')
                if not text.strip():
                    raise VoiceError('VOICE_EMPTY')
                return text.strip()
            finally:
                await response.aclose()
    except VoiceError:
        raise
    except Exception:  # noqa: BLE001 - external failures are redacted
        raise VoiceError('VOICE_UNAVAILABLE') from None
    finally:
        await transport.aclose()


async def speak_pcm(provider: AIProvider, key: str, text: str) -> AsyncIterator[bytes]:
    transport = voice_transport()
    try:
        policy = provider.model_policy_json or {}
        voice_id = quote(str(policy.get('voice_id') or DEFAULT_VOICE_ID), safe='')
        request = httpx.Request('POST', f'{_BASE}/v1/text-to-speech/{voice_id}/stream',
            params={'output_format': 'pcm_16000'}, headers={'xi-api-key': key},
            json={'text': text, 'model_id': policy.get('tts_model') or policy.get('default_model') or 'eleven_flash_v2_5'})
        async with asyncio.timeout(60):
            response = await transport.handle_async_request(request)
            try:
                if response.status_code != 200:
                    raise VoiceError('VOICE_UNAVAILABLE')
                pending = b''
                async for chunk in response.aiter_bytes():
                    pending += chunk
                    while len(pending) >= 4096:
                        yield pending[:4096]
                        pending = pending[4096:]
                    size = len(pending) & ~1
                    if size:
                        yield pending[:size]
                        pending = pending[size:]
            finally:
                await response.aclose()
    except VoiceError:
        raise
    except Exception:  # noqa: BLE001 - external failures are redacted
        raise VoiceError('VOICE_UNAVAILABLE') from None
    finally:
        await transport.aclose()
