"""Application service for push, pull, bootstrap and sync status."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional

from .cursor import CursorCodec
from .errors import SyncException, SyncResetRequired
from .models import (
    AuthorizationContext,
    OperationResult,
    OperationStatus,
    SyncErrorCode,
)
from .protocols import SyncAuthorizer, SyncStore
from .validation import MAX_BATCH_OPERATIONS, parse_batch


@dataclass(frozen=True)
class PushResponse:
    results: tuple[OperationResult, ...]
    server_cursor: str


@dataclass(frozen=True)
class PullResponse:
    changes: tuple[Mapping[str, Any], ...]
    next_cursor: str
    has_more: bool


@dataclass(frozen=True)
class BootstrapResponse:
    records: tuple[Mapping[str, Any], ...]
    cursor: str
    next_page_token: Optional[str]
    has_more: bool


class SyncService:
    def __init__(self, store: SyncStore, authorizer: SyncAuthorizer, cursor_codec: CursorCodec):
        self.store = store
        self.authorizer = authorizer
        self.cursors = cursor_codec

    def _context(self, owner_id: str, device_id: str) -> AuthorizationContext:
        context = self.authorizer.authorize(owner_id, device_id)
        if context.owner_id != owner_id or context.device_id != device_id:
            raise SyncException(SyncErrorCode.FORBIDDEN, "Authorization context mismatch", {}, 403)
        return context

    def push(self, owner_id: str, raw_body: Mapping[str, Any]) -> PushResponse:
        device_id, operations = parse_batch(raw_body)
        context = self._context(owner_id, device_id)
        results: list[OperationResult] = []
        for operation in operations:
            receipt = self.store.get_operation_receipt(owner_id, operation.operation_id)
            if receipt is not None:
                recorded_device, prior = receipt
                if recorded_device != device_id:
                    results.append(
                        OperationResult(
                            operation.operation_id,
                            OperationStatus.REJECTED,
                            error_code=SyncErrorCode.IDEMPOTENCY_CONFLICT,
                            message="Operation id is already bound to another device",
                        )
                    )
                else:
                    results.append(
                        OperationResult(
                            operation.operation_id,
                            OperationStatus.DUPLICATE,
                            version=prior.version,
                            cursor=self._cursor_for_result(owner_id, prior.commit_seq),
                            error_code=prior.error_code,
                            message=prior.message,
                            server_record=prior.server_record,
                            conflict_id=prior.conflict_id,
                            branches=prior.branches,
                        )
                    )
                continue
            applied = self.store.apply_operation(context, operation)
            results.append(
                OperationResult(
                    operation.operation_id,
                    applied.status,
                    version=applied.version,
                    cursor=self._cursor_for_result(owner_id, applied.commit_seq),
                    error_code=applied.error_code,
                    message=applied.message,
                    server_record=applied.server_record,
                    conflict_id=applied.conflict_id,
                    branches=applied.branches,
                )
            )
        current = self.store.status(context).current_commit_seq
        return PushResponse(tuple(results), self._cursor_for_result(owner_id, current))

    def _cursor_for_result(self, owner_id: str, commit_seq: Optional[int]) -> str:
        return self.cursors.encode(kind="pull", owner_id=owner_id, commit_seq=commit_seq or 0)

    def pull(self, owner_id: str, device_id: str, cursor: Optional[str], limit: int = 200) -> PullResponse:
        context = self._context(owner_id, device_id)
        if limit < 1 or limit > MAX_BATCH_OPERATIONS:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR, "limit is outside the allowed bounds", {}, 422)
        decoded = (
            self.cursors.decode(cursor, owner_id=owner_id, expected_kind="pull")
            if cursor
            else None
        )
        after = decoded.commit_seq if decoded else 0
        status = self.store.status(context)
        if after > status.current_commit_seq:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR, "Cannot pull from a future cursor", {}, 422)
        if after < status.compaction_watermark:
            raise SyncResetRequired(status.compaction_watermark)
        page = self.store.pull_changes(owner_id, after, limit)
        changes = tuple(
            {
                "commit_seq": item.commit_seq,
                "resource_kind": item.resource_kind,
                "resource_id": item.resource_id,
                "version": item.version,
                "operation": item.operation.value,
                "payload": item.payload,
                "tombstone": item.tombstone,
            }
            for item in page.changes
        )
        next_seq = page.changes[-1].commit_seq if page.changes else after
        return PullResponse(changes, self.cursors.encode(kind="pull", owner_id=owner_id, commit_seq=next_seq), page.has_more)

    def bootstrap(
        self,
        owner_id: str,
        device_id: str,
        scope: Optional[str] = None,
        page_token: Optional[str] = None,
        limit: int = 200,
    ) -> BootstrapResponse:
        context = self._context(owner_id, device_id)
        if limit < 1 or limit > MAX_BATCH_OPERATIONS:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR, "limit is outside the allowed bounds", {}, 422)
        decoded = (
            self.cursors.decode(page_token, owner_id=owner_id, expected_kind="bootstrap")
            if page_token
            else None
        )
        status = self.store.status(context)
        snapshot = decoded.snapshot_seq if decoded else status.current_commit_seq
        if snapshot is None:
            snapshot = status.current_commit_seq
        if snapshot > status.current_commit_seq:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR, "Bootstrap token refers to a future snapshot", {}, 422)
        page = self.store.bootstrap_records(
            owner_id,
            scope,
            snapshot,
            decoded.after_resource_id if decoded else None,
            limit,
        )
        records = tuple(
            {
                "resource_kind": record.resource_kind,
                "resource_id": record.resource_id,
                "version": record.version,
                "payload": record.payload,
                "deleted": record.deleted,
            }
            for record in page.records
        )
        next_token = (
            self.cursors.encode(
                kind="bootstrap",
                owner_id=owner_id,
                commit_seq=snapshot,
                snapshot_seq=snapshot,
                after_resource_id=page.next_after,
            )
            if page.has_more and page.next_after is not None
            else None
        )
        return BootstrapResponse(
            records,
            self.cursors.encode(kind="pull", owner_id=owner_id, commit_seq=snapshot),
            next_token,
            page.has_more,
        )

    def acknowledge(self, owner_id: str, device_id: str, cursor: str) -> None:
        context = self._context(owner_id, device_id)
        decoded = self.cursors.decode(cursor, owner_id=owner_id, expected_kind="pull")
        status = self.store.status(context)
        if decoded.commit_seq > status.current_commit_seq:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR, "Cannot acknowledge a future cursor", {}, 422)
        self.store.acknowledge(context, decoded.commit_seq)

    def status(self, owner_id: str, device_id: str):
        context = self._context(owner_id, device_id)
        return self.store.status(context)
