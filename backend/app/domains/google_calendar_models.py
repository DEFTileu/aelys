"""Separate owner Calendar connection, encrypted credentials and OAuth state."""
from datetime import datetime

from app.core.db import Base
from app.core.models import Owned
from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column


class GoogleCalendarConnection(Owned):
    __tablename__ = 'google_calendar_connections'
    __table_args__ = (UniqueConstraint('owner_id', name='uq_google_calendar_owner'),)
    calendar_id: Mapped[str] = mapped_column(String(320), default='primary')
    calendar_timezone: Mapped[str] = mapped_column(String(64), default='UTC')
    connection_status: Mapped[str] = mapped_column(String(32), default='connected')
    encrypted_sync_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    lease_owner: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(80), nullable=True)


class GoogleCalendarCredential(Base):
    __tablename__ = 'google_calendar_credentials'
    connection_id: Mapped[str] = mapped_column(String(36), ForeignKey('google_calendar_connections.id'), primary_key=True)
    encrypted_tokens: Mapped[str] = mapped_column(Text)


class GoogleCalendarOAuthState(Base):
    __tablename__ = 'google_calendar_oauth_states'
    state_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey('users.id'))
    session_id: Mapped[str] = mapped_column(String(36), ForeignKey('auth_sessions.id'))
    encrypted_verifier: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    browser_state: Mapped[str | None] = mapped_column(String(16), nullable=True)
