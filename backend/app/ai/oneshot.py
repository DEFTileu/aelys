"""One-shot JSON completion through a feature's configured provider, shared by small server-side AI helpers."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

from app.ai import api as ai_api
from app.ai.crypto import decrypt_secret
from app.ai.defaults import feature_provider
from app.ai.models import ChatMessage, PrivacyClass, RoutingRequest, TaskKind
from app.core.models import AIConversation, AIRun
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class OneShot:
    run_id: str  # the logged AIRun
    data: dict | None  # None when the reply was not a JSON object


async def one_shot_json(db: AsyncSession, owner_id: str, feature: str, title: str, system: str, text: str, max_tokens: int = 600) -> OneShot | None:
    """Ask the owner's provider for a JSON object; None means unavailable (no provider, no budget, timeout, error).

    The text is fenced as untrusted data. The caller must re-validate the reply and never let it choose policy.
    """
    chosen = await feature_provider(db, owner_id, feature)
    if chosen is None:
        return None
    provider, secret, model = chosen
    try:
        remaining = await ai_api._remaining_monthly_budget(db, owner_id, provider)
        if remaining <= 0:
            return None
        run_id, started = uuid4(), datetime.now(UTC)
        service = ai_api._service(provider, decrypt_secret(secret.encrypted_value))
        request = RoutingRequest(TaskKind.UNKNOWN, privacy=PrivacyClass.PERSONAL, manual_model=model, request_budget=min(Decimal(100), remaining))
        result = await asyncio.wait_for(service.complete(run_id, request, (ChatMessage("system", system), ChatMessage("user", text, untrusted=True)), max_tokens=max_tokens, tools=()), timeout=45)
        conversation = AIConversation(owner_id=owner_id, title=title, tool_scope_json={})
        db.add(conversation)
        await db.flush()
        db.add(AIRun(id=str(run_id), owner_id=owner_id, conversation_id=conversation.id, prompt_message_id=None, provider_id=provider.id, provider=getattr(result.provider, "value", result.provider), model=result.model, status="completed", tool_scope_json={}, token_counts={"input": result.usage.usage.input_tokens, "output": result.usage.usage.output_tokens}, cost_estimate=result.usage.estimated_cost, started_at=started, completed_at=datetime.now(UTC)))
        await db.commit()
        reply = result.response.text
        if result.response.tool_calls or not isinstance(reply, str):
            return OneShot(str(run_id), None)
        data = json.loads(reply[reply.index("{"): reply.rindex("}") + 1])
        return OneShot(str(run_id), data if isinstance(data, dict) else None)
    except Exception:  # noqa: BLE001 - provider or parse failures mean "no answer"
        await db.rollback()
        return None
