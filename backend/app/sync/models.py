"""Typed, dependency-light sync DTOs.

These dataclasses are intentionally independent from the foundation ORM and
can later be mirrored by Pydantic models at the FastAPI boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Mapping, Optional


class SyncErrorCode(str, Enum):
    VALIDATION_ERROR = "VALIDATION_ERROR"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    DEVICE_REVOKED = "DEVICE_REVOKED"
    VERSION_CONFLICT = "VERSION_CONFLICT"
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
    PRIVACY_VIOLATION = "PRIVACY_VIOLATION"
    SYNC_RESET_REQUIRED = "SYNC_RESET_REQUIRED"
    NOT_FOUND = "NOT_FOUND"


class OperationAction(str, Enum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"


class OperationStatus(str, Enum):
    APPLIED = "applied"
    DUPLICATE = "duplicate"
    CONFLICT = "conflict"
    REJECTED = "rejected"


@dataclass(frozen=True)
class AuthorizationContext:
    owner_id: str
    device_id: str
    actor_type: str = "device"
    project_scope: Optional[frozenset[str]] = None
    policy_id: Optional[str] = None


@dataclass(frozen=True)
class OperationEnvelope:
    operation_id: str
    device_id: str
    resource_kind: str
    resource_id: str
    action: OperationAction
    base_version: int
    client_timestamp: datetime
    patch: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "OperationEnvelope":
        from .validation import parse_operation

        return parse_operation(raw)


@dataclass(frozen=True)
class Change:
    """One committed change in commit order.

    ``commit_seq`` is assigned by the store at transaction commit time.  It is
    intentionally distinct from an insert/allocation id.
    """

    commit_seq: int
    resource_kind: str
    resource_id: str
    version: int
    operation: OperationAction
    payload: Optional[Mapping[str, Any]]
    tombstone: bool = False


@dataclass(frozen=True)
class ServerRecord:
    resource_kind: str
    resource_id: str
    version: int
    payload: Mapping[str, Any]
    deleted: bool = False


@dataclass(frozen=True)
class OperationResult:
    operation_id: str
    status: OperationStatus
    version: Optional[int] = None
    cursor: Optional[str] = None
    error_code: Optional[SyncErrorCode] = None
    message: Optional[str] = None
    server_record: Optional[ServerRecord] = None
    conflict_id: Optional[str] = None
    branches: tuple[Mapping[str, Any], ...] = ()


@dataclass(frozen=True)
class PullPage:
    changes: tuple[Change, ...]
    has_more: bool
    current_commit_seq: int
    compaction_watermark: int = 0


@dataclass(frozen=True)
class BootstrapPage:
    records: tuple[ServerRecord, ...]
    snapshot_commit_seq: int
    has_more: bool
    next_after: Optional[str] = None


@dataclass(frozen=True)
class SyncStatus:
    device_id: str
    acknowledged_seq: int
    current_commit_seq: int
    compaction_watermark: int
    pending_operations: int
    reset_required: bool = False


@dataclass(frozen=True)
class ApplyResult:
    status: OperationStatus
    version: Optional[int] = None
    commit_seq: Optional[int] = None
    server_record: Optional[ServerRecord] = None
    error_code: Optional[SyncErrorCode] = None
    message: Optional[str] = None
    conflict_id: Optional[str] = None
    branches: tuple[Mapping[str, Any], ...] = ()
