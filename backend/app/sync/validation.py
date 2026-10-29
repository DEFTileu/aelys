"""Boundary validation and privacy policy for sync payloads."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Mapping
from uuid import UUID

from .errors import SyncException
from .models import OperationAction, OperationEnvelope, SyncErrorCode

MAX_BATCH_OPERATIONS = 200
MAX_OPERATION_BYTES = 256 * 1024
MAX_BATCH_BYTES = 2 * 1024 * 1024
MAX_NESTING = 12

SYNCABLE_RESOURCE_KINDS = frozenset(
    {
        "project",
        "note",
        "task",
        "event",
        "file",
        "mail",
        "mail_message",
        "mail_draft",
        "finance_transaction",
        "focus_session",
        "ai_chat",
        "repository",
        "agent_session_index",
    }
)

INDEX_FIELDS = frozenset(
    {
        "id",
        "owner_id",
        "device_id",
        "project_id",
        "adapter",
        "opaque_local_session_ref",
        "started_at",
        "last_activity_at",
        "message_count",
        "state",
        "last_indexed_at",
    }
)

SECRET_KEY = re.compile(
    r"(?:^|_|-)(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|private[-_]?key|authorization|bearer|credential)(?:$|_|-)",
    re.IGNORECASE,
)
TRANSCRIPT_KEYS = frozenset(
    {"transcript", "transcripts", "messages", "message_body", "command_log", "embedding", "embeddings"}
)


def _error(message: str, **details: Any) -> SyncException:
    return SyncException(SyncErrorCode.VALIDATION_ERROR, message, details, 422)


def _walk(value: Any, depth: int = 0, key: str = "") -> None:
    if depth > MAX_NESTING:
        raise _error("Payload nesting exceeds the sync limit", max_nesting=MAX_NESTING)
    if isinstance(value, Mapping):
        for child_key, child in value.items():
            if not isinstance(child_key, str) or len(child_key) > 128:
                raise _error("Patch keys must be strings up to 128 characters")
            normalized = child_key.casefold()
            if SECRET_KEY.search(normalized):
                raise SyncException(
                    SyncErrorCode.PRIVACY_VIOLATION,
                    "Secrets are not accepted in sync payloads",
                    {"field": child_key},
                    422,
                )
            if normalized in TRANSCRIPT_KEYS:
                raise SyncException(
                    SyncErrorCode.PRIVACY_VIOLATION,
                    "Agent transcript content is local-only",
                    {"field": child_key},
                    422,
                )
            _walk(child, depth + 1, child_key)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _walk(child, depth + 1, key)
    elif isinstance(value, str) and len(value.encode("utf-8")) > MAX_OPERATION_BYTES:
        raise _error("Text value exceeds the sync payload limit")

def validate_patch(patch: Mapping[str, Any]) -> None:
    """Validate a patch recursively without treating ordinary text as metadata."""
    _walk(patch)


def _parse_datetime(value: Any) -> datetime:
    if not isinstance(value, str):
        raise _error("client_timestamp must be an ISO8601 string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _error("client_timestamp must be a valid ISO8601 instant") from exc
    if parsed.tzinfo is None:
        raise _error("client_timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def parse_operation(raw: Mapping[str, Any]) -> OperationEnvelope:
    if not isinstance(raw, Mapping):
        raise _error("Operation must be an object")
    required = {"operation_id", "device_id", "resource_kind", "resource_id", "action", "base_version", "client_timestamp"}
    missing = sorted(required - set(raw))
    if missing:
        raise _error("Operation is missing required fields", fields=missing)
    try:
        operation_id = str(UUID(str(raw["operation_id"])))
        device_id = str(UUID(str(raw["device_id"])))
    except (ValueError, TypeError) as exc:
        raise _error("operation_id and device_id must be UUIDs") from exc
    resource_id = str(raw["resource_id"])
    if not resource_id or len(resource_id) > 256:
        raise _error("resource_id must be between 1 and 256 characters")
    resource_kind = str(raw["resource_kind"])
    if resource_kind == "agent_session":
        raise SyncException(
            SyncErrorCode.PRIVACY_VIOLATION,
            "Raw agent sessions cannot be synchronized",
            {"resource_kind": resource_kind},
            422,
        )
    if resource_kind not in SYNCABLE_RESOURCE_KINDS:
        raise _error("resource_kind is not syncable", resource_kind=resource_kind)
    try:
        action = OperationAction(str(raw["action"]))
    except ValueError as exc:
        raise _error("action must be create, update, or delete") from exc
    base_version = raw["base_version"]
    if isinstance(base_version, bool) or not isinstance(base_version, int) or base_version < 0:
        raise _error("base_version must be a non-negative integer")
    patch = raw.get("patch", {})
    if not isinstance(patch, Mapping):
        raise _error("patch must be an object")
    _walk(patch)
    if resource_kind == "agent_session_index":
        unknown = sorted(set(patch) - INDEX_FIELDS)
        if unknown:
            raise SyncException(
                SyncErrorCode.PRIVACY_VIOLATION,
                "Agent session index contains fields outside the cloud metadata allowlist",
                {"fields": unknown},
                422,
            )
    operation = OperationEnvelope(
        operation_id=operation_id,
        device_id=device_id,
        resource_kind=resource_kind,
        resource_id=resource_id,
        action=action,
        base_version=base_version,
        client_timestamp=_parse_datetime(raw["client_timestamp"]),
        patch=dict(patch),
    )
    encoded = json.dumps(raw, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    if len(encoded) > MAX_OPERATION_BYTES:
        raise _error("Operation exceeds the sync payload limit", max_bytes=MAX_OPERATION_BYTES)
    return operation


def parse_batch(raw: Mapping[str, Any]) -> tuple[str, tuple[OperationEnvelope, ...]]:
    if not isinstance(raw, Mapping):
        raise _error("Push body must be an object")
    try:
        device_id = str(UUID(str(raw["device_id"])))
    except (KeyError, ValueError, TypeError) as exc:
        raise _error("device_id must be a UUID") from exc
    operations = raw.get("operations")
    if not isinstance(operations, list):
        raise _error("operations must be an array")
    if not operations or len(operations) > MAX_BATCH_OPERATIONS:
        raise _error("operations count is outside the allowed bounds", max_operations=MAX_BATCH_OPERATIONS)
    encoded = json.dumps(raw, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    if len(encoded) > MAX_BATCH_BYTES:
        raise _error("Push body exceeds the sync payload limit", max_bytes=MAX_BATCH_BYTES)
    parsed = tuple(parse_operation(item) for item in operations)
    mismatched = [op.operation_id for op in parsed if op.device_id != device_id]
    if mismatched:
        raise SyncException(
            SyncErrorCode.FORBIDDEN,
            "Operation device_id must match the authenticated push device",
            {"operation_ids": mismatched},
            403,
        )
    return device_id, parsed
