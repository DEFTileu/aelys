"""Voice in the apps' AI chat: speech to text and text to speech through the owner's ElevenLabs key, the board's provider.
Audio lives only for the request; it is never stored or logged. Each call reserves the voice request cost against the monthly budget."""
from __future__ import annotations

import asyncio
import base64
import re
from uuid import uuid4

from app.ai import api as ai_api
from app.ai.crypto import decrypt_secret
from app.companion.voice_provider import (
    VoiceError,
    request_estimate,
    reserve_retry,
    speak_mp3,
    transcribe,
    voice_provider,
)
from app.core.db import get_db
from app.core.models import AIConversation, AIProvider, AIRun, now
from app.core.security import current_principal
from app.english.ai import fail
from app.english.speech import EXTENSIONS, read_audio
from app.sync.change_log import lock_owner
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter()

SPEAK_MAX_CHARS = 2500
FAILURES = {
    'VOICE_NOT_CONFIGURED': (409, 'Add an ElevenLabs key in Settings › AI & models'),
    'BUDGET_EXCEEDED': (429, 'The monthly voice budget is used up'),
    'VOICE_EMPTY': (422, 'No speech was heard'),
}


class VoiceText(BaseModel):
    text: str


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


class SpeakOut(BaseModel):
    audio: str  # base64: the native bridge carries JSON only
    content_type: str


def speakable(text: str) -> str:
    """A chat answer as plain speech: no code, link targets or markdown marks; cut at a sentence end within SPEAK_MAX_CHARS."""
    text = re.sub(r'(`{3,}|~{3,}).*?(\1|$)', ' ', text, flags=re.DOTALL)
    text = re.sub(r'^(?: {4}|\t)[^\n]*', ' ', text, flags=re.MULTILINE)
    text = re.sub(r'<(script|style|pre|code)\b[^>]*>.*?</\1\s*>', ' ', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'^\s{0,3}\[[^\]]+\]:[^\n]*', '', text, flags=re.MULTILINE)
    text = re.sub(r'!?\[([^\]]*)\]\[[^\]]*\]', r'\1', text)
    text = re.sub(r'!?\[([^\]]*)\]\([^)]*\)', r'\1', text)
    text = re.sub(r'https?://\S+', '', text)
    text = re.sub(r'^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'[*_`~|#]', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) > SPEAK_MAX_CHARS:
        cut = text[:SPEAK_MAX_CHARS]
        end = max(cut.rfind('. '), cut.rfind('! '), cut.rfind('? '))
        text = cut[:end + 1] if end > SPEAK_MAX_CHARS // 2 else cut
    return text


async def _reserve(db: AsyncSession, owner_id: str, model_key: str, default_model: str) -> tuple[AIProvider, str, AIRun]:
    await lock_owner(db, owner_id)
    provider, secret = await voice_provider(db, owner_id)
    try:
        key = decrypt_secret(secret.encrypted_value)
    except Exception:  # noqa: BLE001 - encrypted credentials must never become client errors
        raise VoiceError('VOICE_UNAVAILABLE') from None
    estimate = request_estimate(provider)
    if estimate > await ai_api._remaining_monthly_budget(db, owner_id, provider):
        raise VoiceError('BUDGET_EXCEEDED')
    # The run needs a conversation; a hidden one keeps the chat list clean while the budget still counts the run.
    conversation = AIConversation(owner_id=owner_id, title='Voice', tool_scope_json={}, deleted_at=now())
    db.add(conversation)
    await db.flush()
    run = AIRun(owner_id=owner_id, conversation_id=conversation.id, provider_id=provider.id, provider='elevenlabs',
                model=str((provider.model_policy_json or {}).get(model_key) or default_model), status='running', started_at=now(),
                idempotency_key=f'chat-voice:{uuid4()}', cost_estimate=estimate, token_counts={'billing': 'reserved_estimate'})
    db.add(run)
    await db.commit()  # the provider wait must not hold a DB writer
    return provider, key, run


async def _finish(db: AsyncSession, run: AIRun | None, ok: bool) -> None:
    if run is None:
        return
    if not ok:
        await db.rollback()
    run.status, run.completed_at = ('completed' if ok else 'failed'), now()
    await db.commit()


def _fail(error: VoiceError):
    status, message = FAILURES.get(error.code, (502, 'Voice is unavailable right now'))
    return fail(status, error.code, message)


@router.post('/ai/voice/transcribe', response_model=VoiceText)
async def voice_transcribe(incoming: Request, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    """A raw audio/* body (or multipart field `audio`) from the chat's microphone; answers with the words heard."""
    user, _ = principal
    mime, data = await read_audio(incoming)
    run = None
    try:
        provider, key, run = await _reserve(db, user.id, 'stt_model', 'scribe_v1')
        text = await transcribe(provider, key, (f'voice.{EXTENSIONS[mime]}', data, mime),
                                before_retry=lambda: reserve_retry(db, user.id, provider, run))
    except VoiceError as error:
        await _finish(db, run, False)
        raise _fail(error) from None
    except asyncio.CancelledError:
        await asyncio.shield(_finish(db, run, False))
        raise
    except Exception:  # noqa: BLE001 - provider diagnostics must not escape
        await _finish(db, run, False)
        raise _fail(VoiceError('VOICE_UNAVAILABLE')) from None
    await _finish(db, run, True)
    return VoiceText(text=text[:20_000])


@router.post('/ai/voice/speak', response_model=SpeakOut)
async def voice_speak(body: SpeakIn, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    """An answer read aloud in the board's voice, as base64 MP3."""
    user, _ = principal
    text = speakable(body.text)
    if not text:
        raise fail(422, 'VOICE_EMPTY', 'Nothing to read aloud')
    run = None
    try:
        provider, key, run = await _reserve(db, user.id, 'tts_model', 'eleven_flash_v2_5')
        audio = await speak_mp3(provider, key, text)
    except VoiceError as error:
        await _finish(db, run, False)
        raise _fail(error) from None
    except asyncio.CancelledError:
        await asyncio.shield(_finish(db, run, False))
        raise
    except Exception:  # noqa: BLE001 - provider diagnostics must not escape
        await _finish(db, run, False)
        raise _fail(VoiceError('VOICE_UNAVAILABLE')) from None
    await _finish(db, run, True)
    return SpeakOut(audio=base64.b64encode(audio).decode(), content_type='audio/mpeg')
