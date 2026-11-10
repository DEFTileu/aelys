"""Which provider and model each AI feature uses, chosen once in Settings.

Stored in ``User.settings_json["ai_defaults"]``. A missing or unusable choice falls
back to the oldest ready provider of the right kind, so nothing breaks before the
owner picks. Telegram keeps its own ``provider_id``/``model`` on the integration.
"""
from __future__ import annotations

from typing import Any

from app.core.models import AIProvider, AIProviderSecret, User
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

CHAT_KINDS = ("claude", "openrouter")
FEATURES: dict[str, tuple[str, ...]] = {"chat": CHAT_KINDS, "english": CHAT_KINDS, "automation": CHAT_KINDS,
                                        "transcription": ("transcription",)}


def stored_defaults(user: User | None) -> dict[str, dict[str, Any]]:
    raw = (user.settings_json or {}).get("ai_defaults") if user else None
    return {key: value for key, value in (raw or {}).items() if key in FEATURES and isinstance(value, dict)}


async def feature_provider(db: AsyncSession, owner_id: str, feature: str) -> tuple[AIProvider, AIProviderSecret, str | None] | None:
    """The chosen ready provider for a feature, else the oldest ready one; the model is None for its default."""
    choice = stored_defaults(await db.get(User, owner_id)).get(feature, {})
    rows = (await db.execute(select(AIProvider, AIProviderSecret).join(AIProviderSecret, AIProviderSecret.provider_id == AIProvider.id).where(
        AIProvider.owner_id == owner_id, AIProviderSecret.owner_id == owner_id, AIProvider.enabled.is_(True),
        AIProvider.deleted_at.is_(None), AIProvider.kind.in_(FEATURES[feature]), AIProviderSecret.encrypted_value != "",
    ).order_by(AIProvider.created_at))).all()
    for provider, secret in rows:
        if provider.id == choice.get("provider_id"):
            return provider, secret, str(choice["model"]) if choice.get("model") and choice["model"] != "auto" else None
    return (rows[0][0], rows[0][1], None) if rows else None
