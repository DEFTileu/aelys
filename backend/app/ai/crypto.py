from __future__ import annotations
import base64, hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from app.core.config import get_settings

def _key(key_material: str | None = None) -> bytes:
    settings = get_settings()
    material = key_material or settings.provider_encryption_key or settings.secret_key
    return hashlib.sha256(material.encode()).digest()
def encrypt_secret(value: str, key_material: str | None = None) -> str:
    import os
    nonce = os.urandom(12)
    return base64.urlsafe_b64encode(nonce + AESGCM(_key(key_material)).encrypt(nonce, value.encode(), None)).decode()
def decrypt_secret(value: str, key_material: str | None = None) -> str:
    raw=base64.urlsafe_b64decode(value.encode()); nonce,body=raw[:12],raw[12:]
    return AESGCM(_key(key_material)).decrypt(nonce,body,None).decode()
