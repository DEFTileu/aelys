"""Versioned, owner scoped sync primitives used by the application core.

The service is storage agnostic at the transport boundary: it accepts typed
operations and returns per-operation results.  Domain mutation handlers can
be registered by the backend without exposing private Mac session bodies.
"""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import Field, field_validator

from .common import APIModel, ValidationDomainError, now_utc


class SyncAction(StrEnum):
    create = "create"
    update = "update"
    delete = "delete"


class SyncOperation(APIModel):
    operation_id: UUID
    device_id: UUID
    resource_kind: str = Field(min_length=1, max_length=40)
    resource_id: UUID
    action: SyncAction
    base_version: int = Field(ge=0)
    client_timestamp: datetime | None = None
    patch: dict[str, Any] = Field(default_factory=dict)

    @field_validator("resource_kind")
    @classmethod
    def no_private_transcript(cls, value: str) -> str:
        if value in {"agent_message", "agent_transcript", "agent_embedding"}:
            raise ValueError("private agent session content cannot be synchronized")
        return value


class SyncResult(APIModel):
    operation_id: UUID
    status: str
    version: int | None = None
    cursor: str | None = None
    conflict: dict[str, Any] | None = None


class SyncPushResponse(APIModel):
    results: list[SyncResult]
    server_cursor: str | None = None


class SyncChange(APIModel):
    cursor: int
    resource_kind: str
    resource_id: UUID
    version: int
    action: SyncAction
    payload: dict[str, Any] = Field(default_factory=dict)


class SyncPullResponse(APIModel):
    changes: list[SyncChange]
    next_cursor: str
    has_more: bool


class InMemorySyncStore:
    """Small deterministic store useful for service tests and local adapters."""
    def __init__(self) -> None:
        self.resources: dict[tuple[str, str, str], tuple[int, dict[str, Any]]] = {}
        self.operations: dict[UUID, SyncResult] = {}
        self.changes: list[tuple[str, SyncChange]] = []

    def push(self, owner_id: str, operations: list[SyncOperation]) -> SyncPushResponse:
        results: list[SyncResult] = []
        for op in operations:
            if op.operation_id in self.operations:
                results.append(self.operations[op.operation_id]); continue
            if op.resource_kind.startswith("agent_"):
                raise ValidationDomainError("Private agent session content cannot be synchronized")
            key=(owner_id,op.resource_kind,str(op.resource_id)); current=self.resources.get(key)
            current_version=current[0] if current else 0
            if op.action is not SyncAction.create and current is None:
                result=SyncResult(operation_id=op.operation_id,status="conflict",conflict={"code":"NOT_FOUND"}); self.operations[op.operation_id]=result; results.append(result); continue
            if op.action is not SyncAction.create and current_version != op.base_version:
                result=SyncResult(operation_id=op.operation_id,status="conflict",version=current_version,conflict={"code":"VERSION_CONFLICT","server_version":current_version}); self.operations[op.operation_id]=result; results.append(result); continue
            if op.action is SyncAction.create and current is not None:
                result=SyncResult(operation_id=op.operation_id,status="conflict",version=current_version,conflict={"code":"ALREADY_EXISTS"}); self.operations[op.operation_id]=result; results.append(result); continue
            next_version=current_version+1; payload=dict(current[1]) if current else {}
            payload.update(op.patch)
            if op.action is SyncAction.delete: payload={"deleted_at":now_utc().isoformat()}
            self.resources[key]=(next_version,payload)
            cursor=str(len(self.changes)+1)
            change=SyncChange(cursor=int(cursor),resource_kind=op.resource_kind,resource_id=op.resource_id,version=next_version,action=op.action,payload=payload)
            self.changes.append((owner_id,change))
            result=SyncResult(operation_id=op.operation_id,status="applied",version=next_version,cursor=cursor); self.operations[op.operation_id]=result; results.append(result)
        return SyncPushResponse(results=results,server_cursor=str(len(self.changes)))

    def pull(self, owner_id: str, cursor: int = 0, limit: int = 200) -> SyncPullResponse:
        visible=[change for owner,change in self.changes if owner==owner_id and change.cursor>cursor]
        page=visible[:limit]; next_cursor=str(page[-1].cursor if page else cursor)
        return SyncPullResponse(changes=page,next_cursor=next_cursor,has_more=len(visible)>len(page))
