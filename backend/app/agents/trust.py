"""Signed release-manifest helpers for local runtime provenance."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from pathlib import Path
from typing import Mapping

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def digest_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_payload(payload: Mapping[str, object]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False).encode()


def build_signed_manifest(
    runtime_digest: str,
    probe_digest: str,
    manifest_id: str,
    private_key: bytes,
) -> tuple[str, str]:
    if not all(len(value) == 64 and all(char in "0123456789abcdef" for char in value) for value in (runtime_digest, probe_digest)):
        raise ValueError("runtime and probe digests must be lowercase SHA-256 values")
    payload = {"manifest_id": manifest_id, "probe_digest": probe_digest, "runtime_digest": runtime_digest}
    key = Ed25519PrivateKey.from_private_bytes(private_key)
    envelope = {"payload": payload, "signature": list(key.sign(canonical_payload(payload)))}
    encoded = b64url(json.dumps(envelope, separators=(",", ":"), ensure_ascii=False).encode())
    return b64url(key.public_key().public_bytes_raw()), encoded


def verify_signed_manifest(
    public_key: str | None,
    manifest: str | None,
    runtime_digest: object,
    probe_digest: object,
) -> bool:
    try:
        if not public_key or not manifest or not isinstance(runtime_digest, str) or not isinstance(probe_digest, str):
            return False
        public = unb64url(public_key)
        envelope = json.loads(unb64url(manifest))
        payload = envelope["payload"]
        signature = bytes(envelope["signature"])
        if not isinstance(payload, dict):
            return False
        expected_runtime = payload["runtime_digest"]
        expected_probe = payload["probe_digest"]
        if not all(isinstance(value, str) and len(value) == 64 and all(char in "0123456789abcdef" for char in value) for value in (expected_runtime, expected_probe)):
            return False
        Ed25519PublicKey.from_public_bytes(public).verify(signature, canonical_payload(payload))
        return runtime_digest == expected_runtime and probe_digest == expected_probe
    except (binascii.Error, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return False
