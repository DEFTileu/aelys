"""Generate a Telegram draft using only the authorized business conversation.

The caller authorizes manual generation or enabled auto-reply and owns the
transaction, concurrency control, and any eventual Telegram send.
"""
from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal
from uuid import uuid4

from app.ai import api as ai_api
from app.ai.crypto import decrypt_secret
from app.ai.errors import ModelUnavailable
from app.ai.models import (
    Capability,
    ChatMessage,
    MediaContent,
    PermissionContext,
    PrivacyClass,
    RoutingRequest,
    TaskKind,
    ToolCall,
)
from app.ai.policy import ServerPolicyEngine
from app.core.models import AIConversation, AIProvider, AIProviderSecret, AIRun
from app.integrations.telegram_models import (
    TelegramBusinessMessage,
    TelegramIntegration,
)
from app.integrations.telegram_secretary import (
    build_system_prompt,
    validate_reply_audience,
)
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


class TelegramAIError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class BusinessDecision:
    action: Literal["reply", "no_reply", "handoff"]
    text: str | None
    owner_note: str | None
    sticker: dict[str, str | None] | None = None


class _DecisionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["reply", "no_reply", "handoff"]
    text: str | None = Field(max_length=4096)
    owner_note: str | None = Field(max_length=2000)
    sticker: int | None = Field(default=None, ge=1, le=20)

    @model_validator(mode="after")
    def valid_audience(self):
        if self.action == "reply" and (not self.text or not self.text.strip()) and self.sticker is None:
            raise ValueError("reply requires text or sticker")
        if self.action != "reply" and self.text is not None:
            raise ValueError("terminal decisions must not contain customer text")
        if self.action != "reply" and self.sticker is not None:
            raise ValueError("terminal decisions must not contain a sticker")
        if self.action == "handoff" and (not self.owner_note or not self.owner_note.strip()):
            raise ValueError("handoff requires owner note")
        if self.action != "handoff" and self.owner_note is not None:
            raise ValueError("owner note is only for handoff")
        return self


@dataclass
class _PolicyDescriptor:
    name: str = "telegram.ai"
    required_scope: str = "telegram.ai"
    external_effect: bool = True


_AUTO_REPLY = "[previous automatic reply; not evidence of owner commitments] "
_MEDIA_HANDOFF = "В чате есть вложение, которое автоответчик не смог прочитать. Просмотрите переписку и ответьте вручную."


def _emoji(value: object) -> str | None:
    # Sticker emoji are untrusted provider text: only short non-ASCII symbols reach the model.
    return value if isinstance(value, str) and re.fullmatch(r"[^\x00-\x7f]{1,16}", value) else None


async def _stickers(db: AsyncSession, integration: TelegramIntegration) -> list[dict[str, str | None]]:
    """Up to 20 distinct stickers from recent chats; the model only ever sees their numbers."""
    rows = (await db.execute(select(TelegramBusinessMessage.media_metadata).where(
        TelegramBusinessMessage.owner_id == integration.owner_id,
        TelegramBusinessMessage.integration_id == integration.id,
        TelegramBusinessMessage.deleted_at.is_(None),
        TelegramBusinessMessage.media_metadata.is_not(None),
    ).order_by(TelegramBusinessMessage.sent_at.desc(), TelegramBusinessMessage.telegram_message_id.desc()).limit(500))).scalars()
    found: dict[str, dict[str, str | None]] = {}
    for raw in rows:
        try:
            value = json.loads(raw)
        except ValueError:
            continue
        if isinstance(value, dict) and value.get("kind") == "sticker" and isinstance(value.get("file_id"), str):
            found.setdefault(value["file_id"], {"file_id": value["file_id"], "emoji": _emoji(value.get("emoji"))})
        if len(found) == 20:
            break
    return list(found.values())


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


async def generate_business_draft(
    db: AsyncSession, integration: TelegramIntegration, message: TelegramBusinessMessage
) -> BusinessDecision:
    """Produce a draft without committing or saving message content in AI history."""
    try:
        if (message.owner_id != integration.owner_id or message.integration_id != integration.id
                or message.deleted_at is not None or message.direction != "inbound"):
            raise TelegramAIError("AI_UNAVAILABLE")
        instructions = integration.instructions or ""
        if len(instructions) > 10000:
            raise TelegramAIError("AI_UNAVAILABLE")
        if not integration.provider_id:
            raise TelegramAIError("PROVIDER_REQUIRED")
        provider = await db.get(AIProvider, integration.provider_id)
        if not provider or provider.owner_id != integration.owner_id or not provider.enabled or provider.deleted_at is not None:
            raise TelegramAIError("PROVIDER_REQUIRED")
        secret = await db.get(AIProviderSecret, provider.id)
        if not secret or secret.owner_id != integration.owner_id or not secret.encrypted_value:
            raise TelegramAIError("PROVIDER_REQUIRED")

        ServerPolicyEngine().authorize(
            _PolicyDescriptor(), ToolCall("telegram.ai", {}),
            PermissionContext(actor=f"telegram:{integration.owner_id}", scopes=frozenset({"telegram.ai"}),
                              allow_external_effects=True, policy_id="telegram.ai"),
        )
        remaining = await ai_api._remaining_monthly_budget(db, integration.owner_id, provider)
        if remaining <= 0:
            raise TelegramAIError("BUDGET_EXCEEDED")
        # Bound the history to the target message, excluding other owners and chats.
        history = list((await db.execute(select(TelegramBusinessMessage).where(
            TelegramBusinessMessage.owner_id == integration.owner_id,
            TelegramBusinessMessage.integration_id == integration.id,
            TelegramBusinessMessage.business_connection_id == message.business_connection_id,
            TelegramBusinessMessage.chat_id == message.chat_id,
            TelegramBusinessMessage.deleted_at.is_(None),
            TelegramBusinessMessage.direction.in_(("inbound", "outbound", "owner")),
            (TelegramBusinessMessage.sent_at < message.sent_at) | (
                (TelegramBusinessMessage.sent_at == message.sent_at)
                & (TelegramBusinessMessage.telegram_message_id <= message.telegram_message_id)
            ),
        ).order_by(TelegramBusinessMessage.sent_at.desc(), TelegramBusinessMessage.telegram_message_id.desc()).limit(12))).scalars())
        if not any(item.id == message.id for item in history):
            raise TelegramAIError("AI_UNAVAILABLE")
        # Only the unanswered incoming burst needs media bytes. Older media stays
        # an explicit marker; do not repeatedly download an already answered photo.
        pending: list[TelegramBusinessMessage] = []
        for item in history:
            if item.direction != "inbound":
                break
            if (item.id != message.id and item.draft_status == "sent"
                    and item.updated_at is not None and _utc(item.updated_at) <= _utc(message.sent_at)):
                break
            pending.append(item)
        unread_media = [item for item in reversed(pending) if (item.media or {}).get("kind") in {"photo", "voice", "audio"}]
        if any((item.media or {}).get("kind") != "photo" for item in unread_media) or len(unread_media) > 2:
            return BusinessDecision("handoff", None, _MEDIA_HANDOFF)
        required = frozenset({Capability.IMAGES}) if unread_media else frozenset()
        request = RoutingRequest(TaskKind.UNKNOWN, required_capabilities=required, privacy=PrivacyClass.PERSONAL,
                                 manual_model=integration.model or None,
                                 request_budget=min(Decimal(100), remaining))
        service = ai_api._service(provider, decrypt_secret(secret.encrypted_value))
        attachments: dict[str, tuple[MediaContent, ...]] = {}
        if unread_media:
            # Model eligibility is checked before any download or provider call.
            try:
                service.select(request)
            except ModelUnavailable:
                return BusinessDecision("handoff", None, _MEDIA_HANDOFF)
            from .telegram_business_media import preview_media
            for item in unread_media:
                try:
                    data, mime = await asyncio.wait_for(preview_media(db, integration, item), timeout=20)
                except (HTTPException, TimeoutError):
                    return BusinessDecision("handoff", None, _MEDIA_HANDOFF)
                attachments[item.id] = (MediaContent(mime, data, "telegram-photo"),)
        turns: list[ChatMessage] = []
        for item in reversed(history):
            content = item.text
            kind = (item.media or {}).get("kind")
            if kind == "sticker":
                emoji = _emoji((item.media or {}).get("emoji"))
                marker = f"[sticker {emoji}]" if emoji else "[sticker]"
                content = f"{marker}\n{content}" if content else marker
            elif kind:
                marker = f"[{kind} attached; " + ("content supplied below]" if item.id in attachments else "content unavailable in this turn]")
                content = f"{marker}\n{content}" if content else marker
            if item.reply_to_telegram_message_id:
                content = f"[reply_to_message_id={item.reply_to_telegram_message_id}; reference only]\n{content}"
            if content and item.direction != "inbound":
                content = ("[owner manual reply] " if item.direction == "owner" else _AUTO_REPLY) + content
            if content:
                turns.append(ChatMessage("user" if item.direction == "inbound" else "assistant", content, untrusted=True, media=attachments.get(item.id, ())))
            # updated_at is a conservative upper bound on when a reply was saved;
            # without this check a reply sent after the target could leak backwards.
            if (item.id != message.id and item.direction == "inbound" and item.draft_status == "sent"
                    and item.draft_text and item.updated_at is not None
                    and _utc(item.updated_at) <= _utc(message.sent_at)):
                turns.append(ChatMessage("assistant", _AUTO_REPLY + item.draft_text, untrusted=True))
        stickers = await _stickers(db, integration)
        system = build_system_prompt(instructions, integration.owner_name)
        if stickers:
            system += "\nStickers you may attach (optional): " + ", ".join(f"{number} {sticker['emoji'] or ''}".rstrip() for number, sticker in enumerate(stickers, 1)) + ". Set sticker to the number or null. Use a sticker only when it fits the tone, never instead of needed information."
        if integration.status_text and integration.status_until and _utc(integration.status_until) > datetime.now(UTC):
            system += "\nOwner status (approved for sharing with this customer): " + integration.status_text
            system += "\nValid until: " + _utc(integration.status_until).isoformat()
        available = 30000 - len(system)
        selected: list[ChatMessage] = []
        # Keep the most recent context, including at least part of the target.
        for turn in reversed(turns):
            if available <= 0:
                break
            content = turn.content[-available:]
            if content:
                selected.append(ChatMessage(turn.role, content, untrusted=True, media=turn.media))
                available -= len(content)
        # A long newest message must not squeeze the image out of its context and
        # produce a confident text-only answer to an unseen attachment.
        if sum(bool(turn.media) for turn in selected) != len(attachments):
            return BusinessDecision("handoff", None, _MEDIA_HANDOFF)
        messages = (ChatMessage("system", system), *reversed(selected))
        run_id = uuid4()
        started = datetime.now(UTC)
        result = await asyncio.wait_for(service.complete(run_id, request, messages, max_tokens=800, tools=()), timeout=60)
        # Record even an unusable response: it still incurred provider charges.
        conversation = AIConversation(owner_id=integration.owner_id, title="TelegramBusiness", tool_scope_json={}, deleted_at=datetime.now(UTC))
        db.add(conversation)
        await db.flush()
        provider_name = getattr(result.provider, "value", result.provider)
        db.add(AIRun(
            id=str(run_id), owner_id=integration.owner_id, conversation_id=conversation.id,
            prompt_message_id=None, provider_id=provider.id, provider=provider_name,
            model=result.model, status="completed", tool_scope_json={},
            token_counts={"input": result.usage.usage.input_tokens, "output": result.usage.usage.output_tokens},
            cost_estimate=result.usage.estimated_cost, started_at=started, completed_at=datetime.now(UTC),
        ))
        await db.flush()
        text = result.response.text
        if result.response.tool_calls or not isinstance(text, str) or not text.strip() or len(text) > 4096:
            raise TelegramAIError("AI_UNAVAILABLE")
        # Accept exactly one outer Markdown code fence, never surrounding prose
        # or multiple blocks. The JSON schema and audience checks stay strict.
        text = text.strip()
        fenced = re.fullmatch(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", text, re.DOTALL)
        if fenced:
            text = fenced.group(1)
        parsed = _DecisionPayload.model_validate_json(text)
        try:
            validate_reply_audience(parsed.text, integration.owner_name)
        except ValueError:
            return BusinessDecision("handoff", None, "Автоответ обращался к владельцу или говорил от лица посредника. Ответьте собеседнику вручную.")
        if parsed.sticker is not None and parsed.sticker > len(stickers):
            raise TelegramAIError("AI_UNAVAILABLE")
        chosen = stickers[parsed.sticker - 1] if parsed.sticker is not None else None
        return BusinessDecision(parsed.action, parsed.text, parsed.owner_note, chosen)
    except TelegramAIError:
        raise
    except Exception:  # noqa: BLE001 - provider failures never reveal owner or credential details
        raise TelegramAIError("AI_UNAVAILABLE") from None
