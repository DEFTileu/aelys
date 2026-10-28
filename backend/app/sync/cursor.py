"""Opaque owner-bound cursors for pull and bootstrap pagination."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Optional

from .errors import SyncException
from .models import SyncErrorCode


@dataclass(frozen=True)
class DecodedCursor:
    kind: str
    owner_id: str
    commit_seq: int
    snapshot_seq: Optional[int] = None
    after_resource_id: Optional[str] = None


class CursorCodec:
    """HMAC-signed cursors prevent clients from changing owner or sequence."""

    def __init__(self, secret: bytes):
        if len(secret) < 32:
            raise ValueError("Cursor secret must contain at least 32 bytes")
        self._secret = secret

    def encode(
        self,
        *,
        kind: str,
        owner_id: str,
        commit_seq: int,
        snapshot_seq: Optional[int] = None,
        after_resource_id: Optional[str] = None,
    ) -> str:
        body = json.dumps(
            {"k": kind, "o": owner_id, "s": commit_seq, "b": snapshot_seq, "a": after_resource_id},
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        encoded = base64.urlsafe_b64encode(body).rstrip(b"=")
        signature = hmac.new(self._secret, encoded, hashlib.sha256).digest()
        return f"{encoded.decode()}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"

    def decode(self, token: str, *, owner_id: str, expected_kind: str) -> DecodedCursor:
        try:
            encoded, supplied_signature = token.split(".", 1)
            expected_signature = base64.urlsafe_b64encode(
                hmac.new(self._secret, encoded.encode(), hashlib.sha256).digest()
            ).rstrip(b"=").decode()
            if not hmac.compare_digest(supplied_signature, expected_signature):
                raise ValueError
            padding = "=" * (-len(encoded) % 4)
            data = json.loads(base64.urlsafe_b64decode((encoded + padding).encode()))
            decoded = DecodedCursor(
                kind=str(data["k"]),
                owner_id=str(data["o"]),
                commit_seq=int(data["s"]),
                snapshot_seq=None if data.get("b") is None else int(data["b"]),
                after_resource_id=data.get("a"),
            )
        except (ValueError, TypeError, KeyError, UnicodeError, binascii.Error, json.JSONDecodeError) as exc:
            raise SyncException(SyncErrorCode.VALIDATION_ERROR, "Invalid sync cursor", {}, 422) from exc
        if decoded.owner_id != owner_id or decoded.kind != expected_kind or decoded.commit_seq < 0:
            raise SyncException(SyncErrorCode.FORBIDDEN, "Cursor is not valid for this owner or endpoint", {}, 403)
        return decoded
