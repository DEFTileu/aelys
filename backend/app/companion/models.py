"""Tables behind the desk board: the idempotent action ledger and per-device state."""
from __future__ import annotations

from datetime import datetime

from app.core.db import Base
from app.core.models import now
from sqlalchemy import JSON, BigInteger, DateTime, Float, ForeignKey, String, text
from sqlalchemy.orm import Mapped, mapped_column


class CompanionAction(Base):
    """One row per board action id; `result_json` is replayed verbatim, never recomputed."""
    __tablename__ = "companion_actions"
    device_id: Mapped[str] = mapped_column(String(36), ForeignKey("devices.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # the board's uuid, unique per device only
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(40))
    result_json: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CompanionState(Base):
    __tablename__ = "companion_state"
    device_id: Mapped[str] = mapped_column(String(36), ForeignKey("devices.id"), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    fw_version: Mapped[str | None] = mapped_column(String(40))
    board: Mapped[str | None] = mapped_column(String(60))
    last_hello_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_metrics_json: Mapped[dict | None] = mapped_column(JSON)
    character_epoch: Mapped[int] = mapped_column(BigInteger, default=0, server_default=text('0'))
    character_seq: Mapped[int] = mapped_column(BigInteger, default=-1, server_default=text('-1'))
    character_json: Mapped[dict | None] = mapped_column(JSON)
    lost_mode_json: Mapped[dict | None] = mapped_column(JSON)
    ice_json: Mapped[dict | None] = mapped_column(JSON)
    pending_commands_json: Mapped[list] = mapped_column(JSON, default=list)
    last_wifi_scan_json: Mapped[dict | None] = mapped_column(JSON)
    # v1.1: board contacts and Wi-Fi names are personal data: never logged, shown only to the owner.
    contacts_json: Mapped[dict | None] = mapped_column(JSON)
    wifi_json: Mapped[dict | None] = mapped_column(JSON)
    settings_json: Mapped[dict | None] = mapped_column(JSON)
    command_log_json: Mapped[list | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class CompanionWeather(Base):
    """The owner's weather city for the board: coordinates rounded to 0.1 degree (~10 km), never a precise location."""
    __tablename__ = "companion_weather"
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    lat: Mapped[float] = mapped_column(Float)
    lon: Mapped[float] = mapped_column(Float)
    forecast_json: Mapped[dict | None] = mapped_column(JSON)  # the last good forecast; kept when a fetch fails
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # of forecast_json
    attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # last try, good or not: the 30-minute window
