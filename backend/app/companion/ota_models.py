"""Firmware releases the board installs over the air, and the crash dumps it uploads."""
from __future__ import annotations

from datetime import datetime

from app.core.db import Base
from app.core.models import now, uid
from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column


class CompanionFirmware(Base):
    __tablename__ = "companion_firmware"
    __table_args__ = (UniqueConstraint("owner_id", "version"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    version: Mapped[str] = mapped_column(String(11))
    min_version: Mapped[str] = mapped_column(String(11))
    sha256: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    data: Mapped[bytes] = mapped_column(LargeBinary)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class CompanionCoredump(Base):
    __tablename__ = "companion_coredumps"
    __table_args__ = (UniqueConstraint("device_id", "sha256"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    device_id: Mapped[str] = mapped_column(String(36), ForeignKey("devices.id"), index=True)
    fw_version: Mapped[str] = mapped_column(String(11))
    elf_sha256: Mapped[str | None] = mapped_column(String(64))
    sha256: Mapped[str] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer)
    data: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
