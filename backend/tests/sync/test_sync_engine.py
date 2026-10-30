from __future__ import annotations

import unittest
from uuid import uuid4

from backend.app.sync.cursor import CursorCodec
from backend.app.sync.errors import SyncException, SyncResetRequired
from backend.app.sync.models import (
    ApplyResult,
    AuthorizationContext,
    BootstrapPage,
    Change,
    OperationAction,
    OperationEnvelope,
    OperationStatus,
    PullPage,
    ServerRecord,
    SyncErrorCode,
    SyncStatus,
)
from backend.app.sync.service import SyncService
from backend.app.sync.validation import (
    MAX_OPERATION_BYTES,
    parse_batch,
    parse_operation,
)

OWNER = "owner-1"
DEVICE = str(uuid4())
OTHER_DEVICE = str(uuid4())
NOW = "2026-10-28T00:00:00Z"


class FakeAuthorizer:
    def __init__(self) -> None:
        self.revoked: set[str] = set()

    def authorize(self, owner_id: str, device_id: str) -> AuthorizationContext:
        if device_id in self.revoked:
            raise SyncException(SyncErrorCode.DEVICE_REVOKED, "Device revoked", {}, 403)
        return AuthorizationContext(owner_id=owner_id, device_id=device_id)


class FakeStore:
    """A small transactional model used to test the service protocol."""

    def __init__(self) -> None:
        self.records: dict[tuple[str, str], ServerRecord] = {}
        self.receipts: dict[str, tuple[str, ApplyResult]] = {}
        self.changes: list[Change] = []
        self.acks: dict[str, int] = {}
        self.compaction_watermark = 0
        self._next_commit_seq = 10
        self._allocated_hints = iter([200, 100, 900, 300, 700, 500, 400, 800, 600, 1000])
        self.record_commits: dict[tuple[str, str], int] = {}

    def get_operation_receipt(self, owner_id: str, operation_id: str):
        return self.receipts.get(operation_id)

    def apply_operation(self, context: AuthorizationContext, operation: OperationEnvelope) -> ApplyResult:
        if operation.operation_id in self.receipts:
            return self.receipts[operation.operation_id][1]
        key = (operation.resource_kind, operation.resource_id)
        current = self.records.get(key)
        current_version = current.version if current else 0
        if operation.action is OperationAction.CREATE and current is not None and not current.deleted:
            result = ApplyResult(OperationStatus.CONFLICT, current_version, server_record=current, error_code=SyncErrorCode.VERSION_CONFLICT)
            self.receipts[operation.operation_id] = (context.device_id, result)
            return result
        if operation.action is not OperationAction.CREATE and operation.base_version != current_version:
            branches: tuple[dict, ...] = ()
            conflict_id: str | None = None
            if operation.resource_kind == "note" and operation.action is OperationAction.UPDATE:
                conflict_id = str(uuid4())
                body = operation.patch.get("markdown_body", operation.patch.get("body"))
                branches = (
                    {"branch": "server", "version": current_version, "payload": current.payload if current else {}},
                    {"branch": "client", "base_version": operation.base_version, "body": body},
                )
            result = ApplyResult(
                OperationStatus.CONFLICT,
                current_version,
                server_record=current,
                error_code=SyncErrorCode.VERSION_CONFLICT,
                message="Concurrent update",
                conflict_id=conflict_id,
                branches=branches,
            )
            self.receipts[operation.operation_id] = (context.device_id, result)
            return result
        version = current_version + 1
        deleted = operation.action is OperationAction.DELETE
        record = ServerRecord(operation.resource_kind, operation.resource_id, version, dict(operation.patch), deleted)
        self.records[key] = record
        # The allocation hint is intentionally ignored. PostgreSQL wiring must
        # use a commit-order primitive rather than an allocation-order value.
        next(self._allocated_hints, None)
        commit_seq = self._next_commit_seq
        self._next_commit_seq += 10
        self.record_commits[key] = commit_seq
        change = Change(commit_seq, operation.resource_kind, operation.resource_id, version, operation.action, None if deleted else dict(operation.patch), deleted)
        self.changes.append(change)
        self.changes.sort(key=lambda item: item.commit_seq)
        result = ApplyResult(OperationStatus.APPLIED, version, commit_seq, record)
        self.receipts[operation.operation_id] = (context.device_id, result)
        return result

    def pull_changes(self, owner_id: str, after_commit_seq: int, limit: int, snapshot_commit_seq=None) -> PullPage:
        eligible = [x for x in self.changes if x.commit_seq > after_commit_seq]
        if snapshot_commit_seq is not None:
            eligible = [x for x in eligible if x.commit_seq <= snapshot_commit_seq]
        return PullPage(tuple(eligible[:limit]), len(eligible) > limit, self.changes[-1].commit_seq if self.changes else 0, self.compaction_watermark)

    def bootstrap_records(self, owner_id: str, scope, snapshot_commit_seq: int, after_resource_id, limit: int) -> BootstrapPage:
        records = sorted(
            (record for key, record in self.records.items() if self.record_commits[key] <= snapshot_commit_seq),
            key=lambda item: item.resource_id,
        )
        if after_resource_id is not None:
            records = [x for x in records if x.resource_id > after_resource_id]
        page = records[:limit]
        has_more = len(records) > limit
        return BootstrapPage(tuple(page), snapshot_commit_seq, has_more, page[-1].resource_id if has_more else None)

    def acknowledge(self, context: AuthorizationContext, commit_seq: int) -> None:
        self.acks[context.device_id] = commit_seq

    def status(self, context: AuthorizationContext) -> SyncStatus:
        return SyncStatus(
            context.device_id,
            self.acks.get(context.device_id, 0),
            self.changes[-1].commit_seq if self.changes else 0,
            self.compaction_watermark,
            0,
        )


def operation(
    *,
    resource_kind: str = "task",
    resource_id: str | None = None,
    action: str = "create",
    base_version: int = 0,
    patch: dict | None = None,
    device_id: str = DEVICE,
) -> dict:
    return {
        "operation_id": str(uuid4()),
        "device_id": device_id,
        "resource_kind": resource_kind,
        "resource_id": resource_id or str(uuid4()),
        "action": action,
        "base_version": base_version,
        "client_timestamp": NOW,
        "patch": patch or {"title": "write tests"},
    }


class SyncEngineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = FakeStore()
        self.auth = FakeAuthorizer()
        self.service = SyncService(self.store, self.auth, CursorCodec(b"x" * 32))

    def push(self, *operations: dict, device_id: str = DEVICE):
        return self.service.push(OWNER, {"device_id": device_id, "operations": list(operations)})

    def test_retry_is_idempotent_and_returns_same_receipt(self) -> None:
        op = operation()
        first = self.push(op)
        second = self.push(op)
        self.assertEqual(first.results[0].status, OperationStatus.APPLIED)
        self.assertEqual(second.results[0].status, OperationStatus.DUPLICATE)
        self.assertEqual(first.results[0].version, second.results[0].version)
        self.assertEqual(len(self.store.changes), 1)

    def test_version_conflict_returns_server_record(self) -> None:
        resource_id = str(uuid4())
        created = self.push(operation(resource_id=resource_id)).results[0]
        conflict = self.push(operation(resource_id=resource_id, action="update", base_version=0, patch={"title": "stale"})).results[0]
        self.assertEqual(created.version, 1)
        self.assertEqual(conflict.status, OperationStatus.CONFLICT)
        self.assertEqual(conflict.error_code, SyncErrorCode.VERSION_CONFLICT)
        self.assertEqual(conflict.server_record.version, 1)

    def test_note_conflict_preserves_client_branch(self) -> None:
        resource_id = str(uuid4())
        self.push(operation(resource_kind="note", resource_id=resource_id, patch={"markdown_body": "server"}))
        result = self.push(operation(resource_kind="note", resource_id=resource_id, action="update", patch={"markdown_body": "offline client"})).results[0]
        self.assertEqual(result.status, OperationStatus.CONFLICT)
        self.assertTrue(result.conflict_id)
        self.assertEqual(result.branches[1]["body"], "offline client")

    def test_cursor_uses_committed_boundary_and_is_repeat_safe(self) -> None:
        self.push(operation())
        self.push(operation())
        page = self.service.pull(OWNER, DEVICE, None, limit=1)
        self.assertEqual(page.changes[0]["commit_seq"], 10)
        next_page = self.service.pull(OWNER, DEVICE, page.next_cursor, limit=1)
        self.assertEqual(next_page.changes[0]["commit_seq"], 20)
        replay = self.service.pull(OWNER, DEVICE, page.next_cursor, limit=1)
        self.assertEqual(replay.changes, next_page.changes)

    def test_delete_is_a_tombstone_and_acknowledge_is_bound(self) -> None:
        resource_id = str(uuid4())
        self.push(operation(resource_id=resource_id))
        deleted = self.push(operation(resource_id=resource_id, action="delete", base_version=1, patch={})).results[0]
        pulled = self.service.pull(OWNER, DEVICE, None).changes
        self.assertTrue(pulled[-1]["tombstone"])
        self.service.acknowledge(OWNER, DEVICE, deleted.cursor)
        self.assertEqual(self.store.acks[DEVICE], 20)

    def test_bootstrap_has_stable_snapshot_and_opaque_page(self) -> None:
        self.push(operation(resource_id="a"), operation(resource_id="b"))
        first = self.service.bootstrap(OWNER, DEVICE, limit=1)
        self.assertEqual(len(first.records), 1)
        self.assertTrue(first.next_page_token)
        self.push(operation(resource_id="c"))
        second = self.service.bootstrap(OWNER, DEVICE, page_token=first.next_page_token, limit=1)
        self.assertEqual([r["resource_id"] for r in second.records], ["b"])
        self.assertNotIn("c", [r["resource_id"] for r in second.records])
        self.assertFalse(second.has_more)

    def test_compacted_cursor_requires_reset(self) -> None:
        self.push(operation())
        self.store.compaction_watermark = 10
        with self.assertRaises(SyncResetRequired):
            self.service.pull(OWNER, DEVICE, self.service.cursors.encode(kind="pull", owner_id=OWNER, commit_seq=0))

    def test_cursor_is_opaque_and_owner_bound(self) -> None:
        token = self.service.cursors.encode(kind="pull", owner_id=OWNER, commit_seq=10)
        with self.assertRaises(SyncException):
            self.service.pull("another-owner", DEVICE, token)
        with self.assertRaises(SyncException):
            self.service.pull(OWNER, DEVICE, token[:-1] + ("A" if token[-1] != "A" else "B"))

    def test_revoked_device_is_rejected_before_store_write(self) -> None:
        self.auth.revoked.add(DEVICE)
        with self.assertRaises(SyncException) as raised:
            self.push(operation())
        self.assertEqual(raised.exception.code, SyncErrorCode.DEVICE_REVOKED)
        self.assertEqual(self.store.changes, [])

    def test_raw_agent_transcript_and_secret_are_rejected(self) -> None:
        with self.assertRaises(SyncException) as transcript:
            parse_operation(operation(resource_kind="agent_session", patch={"transcript": "private"}))
        self.assertEqual(transcript.exception.code, SyncErrorCode.PRIVACY_VIOLATION)
        with self.assertRaises(SyncException) as secret:
            parse_operation(operation(patch={"api_key": "sk-secret"}))
        self.assertEqual(secret.exception.code, SyncErrorCode.PRIVACY_VIOLATION)
        with self.assertRaises(SyncException):
            parse_operation(operation(resource_kind="agent_session_index", patch={"content": "private"}))

    def test_payload_bounds_and_device_binding(self) -> None:
        with self.assertRaises(SyncException):
            parse_operation(operation(patch={"title": "x" * MAX_OPERATION_BYTES}))
        with self.assertRaises(SyncException) as mismatch:
            parse_batch({"device_id": DEVICE, "operations": [operation(device_id=OTHER_DEVICE)]})
        self.assertEqual(mismatch.exception.code, SyncErrorCode.FORBIDDEN)


if __name__ == "__main__":
    unittest.main()
