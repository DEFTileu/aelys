"""Explicit owner facts; plaintext is encrypted by the existing secret codec."""
from datetime import datetime

from app.core.models import Owned
from app.integrations.telegram_models import EncryptedText
from sqlalchemy import DateTime, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column


class OwnerMemoryFact(Owned):
    __tablename__ = 'owner_memory_facts'
    __table_args__ = (UniqueConstraint('owner_id', 'normalized_hash', name='uq_owner_memory_fact_hash'),)

    text: Mapped[str] = mapped_column(EncryptedText())
    kind: Mapped[str] = mapped_column(String(16))
    source: Mapped[str] = mapped_column(String(32))
    source_message_id: Mapped[str | None] = mapped_column(String(100))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    normalized_hash: Mapped[str] = mapped_column(String(64))
