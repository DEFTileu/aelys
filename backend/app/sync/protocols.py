"""Narrow persistence and authorization protocols for the sync service."""

from __future__ import annotations

from typing import Protocol

from .models import (
    ApplyResult,
    AuthorizationContext,
    BootstrapPage,
    OperationEnvelope,
    PullPage,
    SyncStatus,
)


class SyncAuthorizer(Protocol):
    """Foundation-owned owner/device authorization hook."""

    def authorize(self, owner_id: str, device_id: str) -> AuthorizationContext:
        """Return a scoped context or raise a typed auth exception."""


class SyncStore(Protocol):
    """Transactional store contract implemented by the PostgreSQL layer.

    Implementations MUST serialize commit ordering at transaction commit time.
    A sequence allocated before a transaction commits is not a valid cursor
    ordering primitive.  ``commit_seq`` values returned by this protocol must
    therefore be monotonically committed and pull must use that same order.
    """

    def get_operation_receipt(
        self, owner_id: str, operation_id: str
    ) -> tuple[str, ApplyResult] | None:
        """Return ``(device_id, result)`` for an already recorded operation."""

    def apply_operation(
        self, context: AuthorizationContext, operation: OperationEnvelope
    ) -> ApplyResult:
        """Atomically check ownership/version, mutate, receipt, and change log."""

    def pull_changes(
        self,
        owner_id: str,
        after_commit_seq: int,
        limit: int,
        snapshot_commit_seq: int | None = None,
    ) -> PullPage:
        """Read committed changes in stable order, bounded by a snapshot if set."""

    def bootstrap_records(
        self,
        owner_id: str,
        scope: str | None,
        snapshot_commit_seq: int,
        after_resource_id: str | None,
        limit: int,
    ) -> BootstrapPage:
        """Read a stable snapshot page; ordering is store-defined and repeatable."""

    def acknowledge(self, context: AuthorizationContext, commit_seq: int) -> None:
        """Persist a device cursor after the client durably applies changes."""

    def status(self, context: AuthorizationContext) -> SyncStatus:
        """Return device cursor, commit watermark, and compaction state."""
