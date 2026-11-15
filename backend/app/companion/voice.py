"""Owner-scoped, history-free companion voice turns."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Mapping
from decimal import ROUND_CEILING, Decimal
from typing import Any
from uuid import UUID

from app.ai import api as ai_api
from app.ai.chat_support import owner_timezone, system_prompt
from app.ai.crypto import decrypt_secret
from app.ai.defaults import feature_provider
from app.ai.errors import BudgetExceeded, RunCancelled
from app.ai.models import (
    Capability,
    ChatMessage,
    PermissionContext,
    PrivacyClass,
    RoutingRequest,
    TaskKind,
)
from app.ai.personal_tools import personal_tool_registry
from app.ai.policy import ServerPolicyEngine
from app.ai.tools import ToolRegistry
from app.ai.turn import run_tool_turn
from app.companion.models import CompanionState
from app.companion.snapshot import build_snapshot
from app.companion.state import locked_state
from app.companion.voice_provider import (
    VoiceError,
    speak_pcm,
    transcribe_pcm,
    voice_provider,
)
from app.core import db as database
from app.core.models import AIConversation, AIMessage, AIRun, Device, User, now
from app.sync.change_log import lock_owner
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

VOICE_MAX_BYTES = 640_000
VOICE_TOOLS = frozenset({'list_tasks', 'read_calendar', 'create_task', 'create_note'})


def voice_registry(db: AsyncSession, owner_id: str, event_id: str) -> ToolRegistry:
    full = personal_tool_registry(db, owner_id, event_id)
    result = ToolRegistry(ServerPolicyEngine())
    for name in sorted(VOICE_TOOLS):
        result.register(full.descriptor(name))
    return result


async def _authorized(db: AsyncSession, owner_id: str, device_id: str, *, lock: bool = False) -> CompanionState:
    device = await db.get(Device, device_id, populate_existing=True, with_for_update=lock)
    state = await locked_state(db, device_id, owner_id) if lock else await db.get(CompanionState, device_id, populate_existing=True)
    if (not device or device.owner_id != owner_id or device.platform != 'companion' or device.revoked_at
            or not state or state.owner_id != owner_id or (state.lost_mode_json is not None and
            (not isinstance(state.lost_mode_json, dict) or state.lost_mode_json.get('on') is not False))):
        raise VoiceError('VOICE_UNAVAILABLE')
    return state


async def run_voice_turn(owner_id: str, device_id: str, turn_id: str, pcm: bytes, speak: bool,
                         send: Callable[[dict], Awaitable[None]], send_audio: Callable[[bytes], Awaitable[None]], *,
                         authorized: Callable[[AsyncSession], Awaitable[bool]] | None = None) -> None:
    async def state(value: str, code: str | None = None) -> None:
        message = {'type': 'voice_state', 'id': turn_id, 'state': value}
        if code:
            message['error_code'] = code
        await send(message)
    run_ids: list[str] = []
    try:
        await state('thinking')
        if len(pcm) > VOICE_MAX_BYTES:
            raise VoiceError('VOICE_TOO_LONG')
        async with database.SessionLocal() as db:
            await lock_owner(db, owner_id)
            board = await _authorized(db, owner_id, device_id)
            provider, secret = await voice_provider(db, owner_id)
            try:
                estimate = Decimal(str((provider.model_policy_json or {}).get('voice_request_cost', '0.05')))
                if not estimate.is_finite() or not Decimal('0.00000001') <= estimate <= Decimal('999999999999.99999999'):
                    raise ValueError()
                estimate = estimate.quantize(Decimal('0.00000001'), rounding=ROUND_CEILING)
            except (ValueError, TypeError, ArithmeticError):
                raise VoiceError('BUDGET_EXCEEDED') from None
            key = f'companion-voice:{device_id}:{turn_id}'
            existing = (await db.execute(select(AIRun.id).where(AIRun.owner_id == owner_id, AIRun.idempotency_key == key))).scalar_one_or_none()
            if existing:
                raise VoiceError('VOICE_UNAVAILABLE')
            if estimate > await ai_api._remaining_monthly_budget(db, owner_id, provider):
                raise VoiceError('BUDGET_EXCEEDED')
            conversation = await db.get(AIConversation, board.voice_conversation_id) if board.voice_conversation_id else None
            if not conversation or conversation.owner_id != owner_id or conversation.deleted_at:
                conversation = AIConversation(owner_id=owner_id, title='Элис — голос')
                db.add(conversation)
                await db.flush()
                board.voice_conversation_id = conversation.id
            voice_run = AIRun(owner_id=owner_id, conversation_id=conversation.id, provider_id=provider.id,
                              provider='elevenlabs', model=str((provider.model_policy_json or {}).get('stt_model', 'scribe_v1')),
                              status='running', started_at=now(), idempotency_key=key, cost_estimate=estimate,
                              token_counts={'billing': 'reserved_estimate'})
            db.add(voice_run)
            await db.flush()
            run_ids.append(voice_run.id)
            await db.commit()
            transcript = await transcribe_pcm(provider, decrypt_secret(secret.encrypted_value), pcm)
            del pcm
            await _authorized(db, owner_id, device_id)
            voice_run.status, voice_run.completed_at = 'completed', now()
            await lock_owner(db, owner_id)
            chosen = await feature_provider(db, owner_id, 'chat')
            if not chosen:
                raise VoiceError('VOICE_UNAVAILABLE')
            chat_provider, chat_secret, model = chosen
            remaining = await ai_api._remaining_monthly_budget(db, owner_id, chat_provider)
            if remaining <= 0:
                raise VoiceError('BUDGET_EXCEEDED')
            user_message = AIMessage(conversation_id=conversation.id, role='user', content=transcript)
            db.add(user_message)
            await db.flush()
            run = AIRun(owner_id=owner_id, conversation_id=conversation.id, prompt_message_id=user_message.id,
                        provider_id=chat_provider.id, provider=chat_provider.kind, model=model or 'auto', status='running',
                        started_at=now(), idempotency_key=key + ':chat')  # cost recorded as it is reported (on_usage), as in Telegram: a cut turn must not keep a reservation
            db.add(run)
            await db.flush()
            run_ids.append(run.id)
            snapshot = await build_snapshot(db, owner_id, now())
            user = await db.get(User, owner_id)
            timezone = owner_timezone((user.settings_json or {}).get('timezone') if user else None)
            messages = (ChatMessage('system', system_prompt(timezone, tools=True, channel='voice')),
                        ChatMessage('user', 'Context (untrusted data): ' + json.dumps(snapshot.model_dump(mode='json'), ensure_ascii=False), untrusted=True),
                        ChatMessage('user', transcript))
            registry = voice_registry(db, owner_id, run.id)
            for name in ('create_task', 'create_note'):
                descriptor = registry.descriptor(name)
                original = descriptor.handler
                async def guarded(arguments: Mapping[str, Any], handler=original) -> Mapping[str, Any]:
                    await lock_owner(db, owner_id)
                    await _authorized(db, owner_id, device_id, lock=True)
                    if authorized and not await authorized(db):
                        raise RunCancelled('device session unavailable')
                    result = await handler(arguments)
                    await db.commit()
                    return result
                descriptor.handler = guarded
            context = PermissionContext(actor=f'companion-voice:{device_id}', scopes=frozenset({'tasks.read', 'calendar.read', 'tasks.write', 'notes.write'}), policy_id='companion-voice')
            request = RoutingRequest(TaskKind.TOOL_ACTION, required_capabilities=frozenset({Capability.TOOL_CALLING}), privacy=PrivacyClass.PERSONAL,
                                     manual_model=model, context_tokens=sum(len(m.content) for m in messages)//4, request_budget=min(Decimal(100), remaining))
            service = ai_api._service(chat_provider, decrypt_secret(chat_secret.encrypted_value))
            await db.commit()
            async def check() -> bool:
                try:
                    await _authorized(db, owner_id, device_id)
                    if authorized and not await authorized(db):
                        await db.rollback()
                        return True
                    await db.commit()
                    return False
                except Exception:  # noqa: BLE001 - authorization must fail closed
                    await db.rollback()
                    return True
            async def event(kind: str, payload: Mapping[str, Any]) -> None:
                await _authorized(db, owner_id, device_id)
                await db.commit()
            async def account(cost: Decimal, input_tokens: int, output_tokens: int) -> None:
                run.cost_estimate = cost
                run.token_counts = {'input': input_tokens, 'output': output_tokens, 'actual_cost': str(cost)}
                await db.commit()
            result = await run_tool_turn(service, UUID(run.id), request, messages, registry, context,
                                         parse_call=ai_api._tool_call, on_event=event, on_usage=account, cancel_check=check, usage_before_check=True)
            await _authorized(db, owner_id, device_id)
            reply = (result.text or '').strip() or 'Готово.'
            db.add(AIMessage(conversation_id=conversation.id, role='assistant', content=reply))
            run.status, run.completed_at = 'completed', now()
            run.cost_estimate = result.cost
            run.token_counts = {'input': result.input_tokens, 'output': result.output_tokens}
            await db.commit()
            await send({'type': 'voice_text', 'id': turn_id, 'text': reply[:600]})
            if speak:
                await state('speaking')
                async for chunk in speak_pcm(provider, decrypt_secret(secret.encrypted_value), reply[:600]):
                    await _authorized(db, owner_id, device_id)
                    if authorized and not await authorized(db):
                        await db.rollback()
                        raise RunCancelled('device session unavailable')
                    await db.commit()
                    await send_audio(chunk)
            await state('done')
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - external and tool errors are redacted
        logger.info('companion voice failed type=%s', type(exc).__name__)
        code = exc.code if isinstance(exc, (VoiceError, BudgetExceeded)) else 'VOICE_UNAVAILABLE'
        try:
            await state('error', code)
        except Exception:  # noqa: BLE001, S110 - peer may have disconnected
            pass
    finally:
        if run_ids:
            try:
                async with database.SessionLocal() as cleanup:
                    await cleanup.execute(update(AIRun).where(AIRun.owner_id == owner_id, AIRun.id.in_(run_ids),
                                                              AIRun.status == 'running').values(status='failed', completed_at=now()))
                    await cleanup.commit()
            except Exception:  # noqa: BLE001 - report only fixed diagnostic
                logger.error('companion voice run cleanup failed')
