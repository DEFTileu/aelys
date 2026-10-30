from __future__ import annotations

import argparse
import asyncio
import os

from sqlalchemy import select, text

from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core.db import SessionLocal
from app.core.models import AIProviderSecret, GmailCredential, GmailOAuthState


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
        gmail = list((await db.execute(select(GmailCredential))).scalars())
        for credential in gmail:
            credential.encrypted_tokens = encrypt_secret(decrypt_secret(credential.encrypted_tokens, old_key), new_key)
        oauth = list((await db.execute(select(GmailOAuthState))).scalars())
        for state in oauth:
            state.encrypted_verifier = encrypt_secret(decrypt_secret(state.encrypted_verifier, old_key), new_key)
        # Raw SQL bypasses EncryptedText, which would try the configured new key
        # while the database still contains ciphertext encrypted with the old key.
        integrations = (await db.execute(text(
            "SELECT id, encrypted_token, instructions FROM telegram_integrations"
        ))).mappings().all()
        for integration in integrations:
            await db.execute(text(
                "UPDATE telegram_integrations SET encrypted_token = :token, "
                "instructions = :instructions WHERE id = :id"
            ), {
                "id": integration["id"],
                "token": (encrypt_secret(decrypt_secret(integration["encrypted_token"], old_key), new_key)
                          if integration["encrypted_token"] is not None else None),
                "instructions": encrypt_secret(decrypt_secret(integration["instructions"], old_key), new_key),
            })
        messages = (await db.execute(text(
            "SELECT id, chat_title, text, draft_text FROM telegram_business_messages"
        ))).mappings().all()
        for message in messages:
            await db.execute(text(
                "UPDATE telegram_business_messages SET chat_title = :chat_title, "
                "text = :message_text, draft_text = :draft_text WHERE id = :id"
            ), {
                "id": message["id"],
                "chat_title": encrypt_secret(decrypt_secret(message["chat_title"], old_key), new_key),
                "message_text": encrypt_secret(decrypt_secret(message["text"], old_key), new_key),
                "draft_text": (encrypt_secret(decrypt_secret(message["draft_text"], old_key), new_key)
                               if message["draft_text"] is not None else None),
            })
        await db.commit()
    return len(rows) + len(gmail) + len(oauth) + len(integrations) + len(messages)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Re-encrypt Aelys provider, Gmail and Telegram data with a new key")
    parser.parse_args()
    print(f"rotated {asyncio.run(rotate())} encrypted records")
