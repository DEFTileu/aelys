"""Shared domain primitives.

The application core is intentionally optional here.  Domain packages can be
imported by the backend entrypoint once its settings/auth dependencies exist,
while tests can use the same services with an owner id and a SQLAlchemy
session directly.
"""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import DateTime, String, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column


class Base(DeclarativeBase):
    pass


def now_utc() -> datetime:
    return datetime.now(UTC)


class DomainError(Exception):
    code = "DOMAIN_ERROR"

    def __init__(self, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFoundError(DomainError):
    code = "NOT_FOUND"


class ConflictError(DomainError):
    code = "VERSION_CONFLICT"


class ForbiddenError(DomainError):
    code = "FORBIDDEN"


class ValidationDomainError(DomainError):
    code = "VALIDATION_ERROR"


class IdempotencyError(DomainError):
    code = "IDEMPOTENCY_CONFLICT"


class OwnerScoped(Base):
    __abstract__ = True

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    owner_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc, nullable=False)
    version: Mapped[int] = mapped_column(default=1, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Timestamped(Base):
    __abstract__ = True

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    owner_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc, nullable=False)


class APIModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")


class VersionedPatch(APIModel):
    version: int = Field(ge=1)


class Page(APIModel):
    items: list[Any]
    next_cursor: str | None = None


def new_id() -> str:
    return str(uuid4())


def require_owner(obj: Any, owner_id: str) -> Any:
    if obj is None:
        raise NotFoundError("Resource not found")
    if getattr(obj, "owner_id", None) != owner_id:
        raise NotFoundError("Resource not found")
    if getattr(obj, "deleted_at", None) is not None:
        raise NotFoundError("Resource not found")
    return obj


def get_owned(session: Session, model: type[Any], object_id: str, owner_id: str) -> Any:
    return require_owner(session.scalar(select(model).where(model.id == object_id, model.owner_id == owner_id)), owner_id)


def save(session: Session, value: Any) -> Any:
    session.add(value)
    session.flush()
    return value


def soft_delete(session: Session, value: OwnerScoped, expected_version: int | None = None) -> Any:
    if expected_version is not None and value.version != expected_version:
        raise ConflictError("Concurrent update", details={"resource_id": value.id, "server_version": value.version})
    value.deleted_at = now_utc()
    value.version += 1
    session.flush()
    return value


def update_version(value: Any, expected_version: int, fields: dict[str, Any]) -> Any:
    if value.version != expected_version:
        raise ConflictError("Concurrent update", details={"resource_id": value.id, "server_version": value.version})
    for key, item in fields.items():
        if item is not None and key != "version":
            setattr(value, key, item)
    value.version += 1
    value.updated_at = now_utc()
    return value


def decimal(value: Decimal | str | int) -> Decimal:
    if isinstance(value, float):
        raise ValidationDomainError("Money values cannot be binary floats")
    return Decimal(str(value))


def db_dependency() -> Any:
    """Compatibility dependency replaced by the application core at mount time."""
    raise RuntimeError("Configure backend.app.core database dependency before mounting domain routers")


def owner_dependency(request: Request) -> str:
    # Fail closed: only an identity set by the application core counts. A client-supplied header must never name the owner.
    owner = getattr(request.state, "owner_id", None)
    if not owner:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHORIZED", "message": "Owner context required"})
    return owner


def translate_error(error: DomainError) -> HTTPException:
    status = {"NOT_FOUND": 404, "VERSION_CONFLICT": 409, "FORBIDDEN": 403, "VALIDATION_ERROR": 422}.get(error.code, 400)
    return HTTPException(status_code=status, detail={"error": {"code": error.code, "message": error.message, "details": error.details}})


def commit(session: Session) -> None:
    session.commit()
