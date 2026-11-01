"""Persistence for Telegram Business; raw updates and plaintext tokens are excluded."""
from datetime import date, datetime

from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core.db import Base
from app.core.models import Owned, now
from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    false,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


class EncryptedText(TypeDecorator[str]):
    """Encrypt content at rest using the configured provider encryption key."""

    impl = Text
    cache_ok = True

    def process_bind_param(self, value: str | None, dialect) -> str | None:
        return encrypt_secret(value) if value is not None else None

    def process_result_value(self, value: str | None, dialect) -> str | None:
        return decrypt_secret(value) if value is not None else None


class TelegramIntegration(Owned):
    __tablename__ = "telegram_integrations"
    __table_args__ = (UniqueConstraint("owner_id", name="uq_telegram_integrations_owner_id"),)

    encrypted_token: Mapped[str | None] = mapped_column(Text)
    bot_id: Mapped[int] = mapped_column(BigInteger)
    bot_username: Mapped[str] = mapped_column(String(64))
    bot_name: Mapped[str] = mapped_column(String(200))
    business_capable: Mapped[bool] = mapped_column(Boolean)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_reply: Mapped[bool] = mapped_column(Boolean, default=False)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC", server_default="UTC")
    pending_digest_on: Mapped[date | None] = mapped_column(Date)
    pending_digest_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deadline_reminders: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    quiet_start: Mapped[str | None] = mapped_column(String(5))
    quiet_end: Mapped[str | None] = mapped_column(String(5))
    digest_time: Mapped[str | None] = mapped_column(String(5))
    last_digest_on: Mapped[date | None] = mapped_column(Date)
    reply_delay_seconds: Mapped[int] = mapped_column(Integer, default=90, server_default="90")
    status_text: Mapped[str | None] = mapped_column(EncryptedText())
    status_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    instructions: Mapped[str] = mapped_column(EncryptedText(), default="")
    provider_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ai_providers.id"))
    model: Mapped[str | None] = mapped_column(String(200))
    owner_telegram_id: Mapped[int | None] = mapped_column(BigInteger)
    binding_code_hash: Mapped[str | None] = mapped_column(String(64))
    binding_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    personal_conversation_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ai_conversations.id"))
    last_update_id: Mapped[int] = mapped_column(BigInteger, default=-1)
    lease_owner: Mapped[str | None] = mapped_column(String(64))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error_code: Mapped[str | None] = mapped_column(String(80))


class TelegramBusinessConnection(Base):
    __tablename__ = "telegram_business_connections"

    id: Mapped[str] = mapped_column(String(256), primary_key=True)
    integration_id: Mapped[str] = mapped_column(String(36), ForeignKey("telegram_integrations.id"))
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"))
    telegram_user_id: Mapped[int] = mapped_column(BigInteger)
    user_chat_id: Mapped[int] = mapped_column(BigInteger)
    enabled: Mapped[bool] = mapped_column(Boolean)
    rights: Mapped[dict] = mapped_column(JSON, default=dict)
    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class TelegramBusinessMessage(Owned):
    __tablename__ = "telegram_business_messages"
    __table_args__ = (UniqueConstraint(
        "integration_id", "business_connection_id", "chat_id", "telegram_message_id",
        name="uq_telegram_business_message_remote",
    ),)

    integration_id: Mapped[str] = mapped_column(String(36), ForeignKey("telegram_integrations.id"))
    business_connection_id: Mapped[str] = mapped_column(String(256), ForeignKey("telegram_business_connections.id"))
    chat_id: Mapped[int] = mapped_column(BigInteger)
    telegram_message_id: Mapped[int] = mapped_column(BigInteger)
    sender_id: Mapped[int | None] = mapped_column(BigInteger)
    chat_title: Mapped[str] = mapped_column(EncryptedText(), default="")
    text: Mapped[str] = mapped_column(EncryptedText(), default="")
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    direction: Mapped[str] = mapped_column(String(16), default="inbound")
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    owner_note: Mapped[str | None] = mapped_column(EncryptedText())
    draft_text: Mapped[str | None] = mapped_column(EncryptedText())
    draft_status: Mapped[str] = mapped_column(String(24), default="none")
    draft_error_code: Mapped[str | None] = mapped_column(String(80))
    reply_message_id: Mapped[int | None] = mapped_column(BigInteger)


class TelegramUpdateReceipt(Base):
    __tablename__ = "telegram_update_receipts"

    integration_id: Mapped[str] = mapped_column(String(36), ForeignKey("telegram_integrations.id"), primary_key=True)
    update_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class TelegramPersonalJob(Owned):
    """Only verified owner requests enter this encrypted, at-most-once queue."""
    __tablename__ = "telegram_personal_jobs"
    __table_args__ = (UniqueConstraint("integration_id", "telegram_update_id", name="uq_telegram_personal_job_update"),)
    integration_id: Mapped[str] = mapped_column(String(36), ForeignKey("telegram_integrations.id"), index=True)
    telegram_update_id: Mapped[int] = mapped_column(BigInteger)
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)
    text: Mapped[str] = mapped_column(EncryptedText(), default="")
    quote: Mapped[str | None] = mapped_column(EncryptedText())
    input_kind: Mapped[str] = mapped_column(String(16), default="text", server_default="text")
    media_metadata: Mapped[str | None] = mapped_column(EncryptedText())
    state: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    conversation_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ai_conversations.id"))
    run_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ai_runs.id"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(String(80))
    recovery_notice_sent: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())


class TelegramChatSend(Owned):
    """Content-free durable receipt; never replay a claimed external send."""
    __tablename__ = "telegram_chat_sends"
    __table_args__ = (UniqueConstraint("owner_id", "idempotency_key", name="uq_telegram_chat_send_key"),)
    integration_id: Mapped[str] = mapped_column(String(36), ForeignKey("telegram_integrations.id"))
    business_connection_id: Mapped[str] = mapped_column(String(256), ForeignKey("telegram_business_connections.id"))
    chat_id: Mapped[int] = mapped_column(BigInteger)
    idempotency_key: Mapped[str] = mapped_column(String(150))
    request_hash: Mapped[str] = mapped_column(String(64))
    send_status: Mapped[str] = mapped_column(String(24), default="sending")
    error_code: Mapped[str | None] = mapped_column(String(80))
    message_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("telegram_business_messages.id", ondelete="SET NULL"))
