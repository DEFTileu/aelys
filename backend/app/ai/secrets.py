"""Encrypted BYOK secret storage abstraction.

The application talks to ``SecretStore`` only through provider references.  The
portable cipher uses authenticated encryption semantics with a random nonce and
an HMAC tag; deployments should supply an OS keychain/KMS backed ``SecretCipher``.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from typing import Protocol


class SecretCipher(Protocol):
    def encrypt(self, plaintext: bytes) -> bytes: ...
    def decrypt(self, ciphertext: bytes) -> bytes: ...


class AuthenticatedStreamCipher:
    """Small dependency-free envelope cipher for development/self-hosted use.

    It is authenticated and keeps plaintext out of the store, while production
    deployments should inject a platform KMS or keychain implementation.
    """

    def __init__(self, master_key: bytes):
        if len(master_key) < 32:
            raise ValueError("master key must contain at least 32 bytes")
        self._key = master_key

    def _stream(self, nonce: bytes, size: int) -> bytes:
        out = bytearray()
        counter = 0
        while len(out) < size:
            out.extend(hmac.new(self._key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest())
            counter += 1
        return bytes(out[:size])

    def encrypt(self, plaintext: bytes) -> bytes:
        nonce = secrets.token_bytes(16)
        ciphertext = bytes(a ^ b for a, b in zip(plaintext, self._stream(nonce, len(plaintext))))
        tag = hmac.new(self._key, nonce + ciphertext, hashlib.sha256).digest()
        return nonce + tag + ciphertext

    def decrypt(self, ciphertext: bytes) -> bytes:
        if len(ciphertext) < 48:
            raise ValueError("invalid encrypted secret")
        nonce, tag, body = ciphertext[:16], ciphertext[16:48], ciphertext[48:]
        expected = hmac.new(self._key, nonce + body, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected):
            raise ValueError("secret authentication failed")
        return bytes(a ^ b for a, b in zip(body, self._stream(nonce, len(body))))


@dataclass(frozen=True)
class SecretRef:
    provider: str
    name: str


class SecretStore:
    """In-memory reference store with encrypted values and no public plaintext API."""

    def __init__(self, cipher: SecretCipher):
        self._cipher = cipher
        self._values: dict[SecretRef, bytes] = {}

    def put(self, ref: SecretRef, value: str) -> None:
        self._values[ref] = self._cipher.encrypt(value.encode("utf-8"))

    def delete(self, ref: SecretRef) -> None:
        self._values.pop(ref, None)

    def exists(self, ref: SecretRef) -> bool:
        return ref in self._values

    def _resolve_for_provider_call(self, ref: SecretRef) -> str:
        """Private boundary used only by provider adapters."""
        if ref not in self._values:
            raise KeyError("secret not found")
        return self._cipher.decrypt(self._values[ref]).decode("utf-8")

    def encrypted_snapshot(self) -> dict[SecretRef, bytes]:
        return dict(self._values)
