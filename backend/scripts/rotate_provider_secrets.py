from __future__ import annotations

import argparse
import asyncio
import os

from sqlalchemy import select

from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core.db import SessionLocal
from app.core.models import AIProviderSecret


async def rotate() -> int:
    old_key = os.environ.get("AELYS_PROVIDER_ENCRYPTION_KEY_OLD")
    new_key = os.environ.get("AELYS_PROVIDER_ENCRYPTION_KEY")
    if not old_key or len(old_key) < 32 or not new_key or len(new_key) < 32:
        raise SystemExit("set AELYS_PROVIDER_ENCRYPTION_KEY_OLD and new AELYS_PROVIDER_ENCRYPTION_KEY")
    if old_key == new_key:
        raise SystemExit("old and new provider encryption keys must differ")
    async with SessionLocal() as db:
        rows = list((await db.execute(select(AIProviderSecret))).scalars())
        for row in rows:
            plaintext = decrypt_secret(row.encrypted_value, old_key)
            row.encrypted_value = encrypt_secret(plaintext, new_key)
            row.key_version += 1
        await db.commit()
    return len(rows)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Re-encrypt Aelys BYOK provider secrets with a new key")
    parser.parse_args()
    print(f"rotated {asyncio.run(rotate())} provider secret envelopes")
