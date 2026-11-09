"""Provider-backed JSON completion for the English module."""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

from app.ai import api as ai_api
from app.ai.crypto import decrypt_secret
from app.ai.egress import SensitiveDataBlocked
from app.ai.models import ChatMessage, PrivacyClass, RoutingRequest, TaskKind
from app.core.models import AIConversation, AIProvider, AIProviderSecret, AIRun
from fastapi import HTTPException
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


def fail(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def parse_json(text: str) -> dict[str, Any]:
    """Extract the JSON object from model output, tolerating a code fence or prose around it."""
    try:
        data = json.loads(text[text.index("{"): text.rindex("}") + 1])
    except ValueError:
        raise fail(502, "AI_BAD_OUTPUT", "AI вернул некорректный ответ") from None
    if not isinstance(data, dict):
        raise fail(502, "AI_BAD_OUTPUT", "AI вернул некорректный ответ")
    return data


def validated[M: BaseModel](model: type[M], data: dict[str, Any]) -> M:
    try:
        return model.model_validate(data)
    except ValidationError:
        raise fail(502, "AI_BAD_OUTPUT", "AI вернул некорректный ответ") from None


async def complete_json(db: AsyncSession, owner_id: str, system: str, user_text: str, max_tokens: int) -> dict[str, Any]:
    """Ask the owner's provider for one JSON object. Commits the AIRun at once, so spend on rejected output still counts against the budget.

    That commit ends the caller's transaction and releases lock_owner: call this before locking."""
    unavailable = fail(503, "AI_UNAVAILABLE", "Подключите AI-провайдера в настройках")
    provider = (await db.execute(select(AIProvider).where(AIProvider.owner_id == owner_id, AIProvider.enabled.is_(True), AIProvider.deleted_at.is_(None)).order_by(AIProvider.created_at))).scalars().first()
    secret = await db.get(AIProviderSecret, provider.id) if provider else None
    if provider is None or secret is None or secret.owner_id != owner_id or not secret.encrypted_value:
        raise unavailable
    remaining = await ai_api._remaining_monthly_budget(db, owner_id, provider)
    if remaining <= 0:
        raise unavailable
    run_id, started = uuid4(), datetime.now(UTC)
    try:
        service = ai_api._service(provider, decrypt_secret(secret.encrypted_value))
        request = RoutingRequest(TaskKind.UNKNOWN, privacy=PrivacyClass.PERSONAL, request_budget=min(Decimal(100), remaining))
        result = await asyncio.wait_for(service.complete(run_id, request, (ChatMessage("system", system), ChatMessage("user", user_text, untrusted=True)), max_tokens=max_tokens, tools=()), timeout=60)
    except SensitiveDataBlocked as error:
        raise fail(422, "SENSITIVE_DATA_BLOCKED", str(error)) from None
    except Exception:  # noqa: BLE001 - provider details never reach the client
        raise fail(502, "AI_FAILED", "AI-провайдер не ответил, попробуйте позже") from None
    conversation = AIConversation(owner_id=owner_id, title="English", tool_scope_json={})
    db.add(conversation)
    await db.flush()
    db.add(AIRun(id=str(run_id), owner_id=owner_id, conversation_id=conversation.id, prompt_message_id=None, provider_id=provider.id, provider=getattr(result.provider, "value", result.provider), model=result.model, status="completed", tool_scope_json={}, token_counts={"input": result.usage.usage.input_tokens, "output": result.usage.usage.output_tokens}, cost_estimate=result.usage.estimated_cost, started_at=started, completed_at=datetime.now(UTC)))
    await db.commit()
    text = result.response.text
    if result.response.tool_calls or not isinstance(text, str):
        raise fail(502, "AI_BAD_OUTPUT", "AI вернул некорректный ответ")
    return parse_json(text)
