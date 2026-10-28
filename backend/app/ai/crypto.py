from __future__ import annotations
import base64, hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from app.core.config import get_settings

def _key() -> bytes:
    settings = get_settings()
    material = settings.provider_encryption_key or settings.secret_key
    return hashlib.sha256(material.encode()).digest()
def encrypt_secret(value: str) -> str:
    import os
    nonce = os.urandom(12)
    return base64.urlsafe_b64encode(nonce + AESGCM(_key()).encrypt(nonce, value.encode(), None)).decode()
def decrypt_secret(value: str) -> str:
    raw=base64.urlsafe_b64decode(value.encode()); nonce,body=raw[:12],raw[12:]
    return AESGCM(_key()).decrypt(nonce,body,None).decode()
