from datetime import UTC, datetime

import pytest
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core.config import get_settings
from app.core.db import Base
from app.core.models import AIProviderSecret, GmailCredential, GmailOAuthState, User
from app.integrations.telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramIntegration,
)
from cryptography.exceptions import InvalidTag
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from scripts import rotate_provider_secrets

OLD_KEY = "old-test-provider-key-0123456789abcdef"
NEW_KEY = "new-test-provider-key-0123456789abcdef"


@pytest.fixture
async def rotation_db(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'rotation.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(rotate_provider_secrets, "SessionLocal", sessions)
    monkeypatch.setenv("AELYS_PROVIDER_ENCRYPTION_KEY_OLD", OLD_KEY)
    monkeypatch.setenv("AELYS_PROVIDER_ENCRYPTION_KEY", OLD_KEY)
    get_settings.cache_clear()
    now = datetime.now(UTC)
    async with sessions() as db:
        db.add_all([User(id="user"), User(id="user-2")])
        db.add(AIProviderSecret(provider_id="provider", owner_id="user", key_version=1,
                                encrypted_value=encrypt_secret("provider secret", OLD_KEY)))
        db.add(GmailCredential(account_id="account", encrypted_tokens=encrypt_secret("gmail token", OLD_KEY)))
        db.add(GmailOAuthState(state_hash="state", owner_id="user", session_id="session",
                               encrypted_verifier=encrypt_secret("oauth verifier", OLD_KEY), expires_at=now))
        db.add(TelegramIntegration(id="integration", owner_id="user", bot_id=1, bot_username="bot",
                                   bot_name="Bot", business_capable=True, instructions="private instruction",
                                   encrypted_token=encrypt_secret("telegram token", OLD_KEY)))
        db.add(TelegramIntegration(id="no-token", owner_id="user-2", bot_id=2, bot_username="bot2",
                                   bot_name="Bot 2", business_capable=False, instructions="", encrypted_token=None))
        db.add(TelegramBusinessConnection(id="connection", integration_id="integration", owner_id="user",
                                          telegram_user_id=1, user_chat_id=2, enabled=True,
                                          connected_at=now, updated_at=now))
        db.add(TelegramBusinessMessage(id="message", owner_id="user", integration_id="integration",
                                       business_connection_id="connection", chat_id=2, telegram_message_id=3,
                                       sent_at=now, chat_title="private title", text="private message",
                                       draft_text="private draft"))
        db.add(TelegramBusinessMessage(id="empty-draft", owner_id="user", integration_id="integration",
                                       business_connection_id="connection", chat_id=2, telegram_message_id=4,
                                       sent_at=now, chat_title="", text="", draft_text=None))
        await db.commit()
    monkeypatch.setenv("AELYS_PROVIDER_ENCRYPTION_KEY", NEW_KEY)
    get_settings.cache_clear()
    yield sessions
    await engine.dispose()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_rotates_all_encrypted_records_with_new_configured_key(rotation_db):
    assert await rotate_provider_secrets.rotate() == 7
    async with rotation_db() as db:
        integration = (await db.execute(text(
            "SELECT encrypted_token, instructions FROM telegram_integrations WHERE id = 'integration'"))).mappings().one()
        message = (await db.execute(text(
            "SELECT chat_title, text, draft_text FROM telegram_business_messages WHERE id = 'message'"))).mappings().one()
        expected = {"encrypted_token": "telegram token", "instructions": "private instruction",
                    "chat_title": "private title", "text": "private message", "draft_text": "private draft"}
        for row in (integration, message):
            for field, ciphertext in row.items():
                assert decrypt_secret(ciphertext, NEW_KEY) == expected[field]
                with pytest.raises(InvalidTag):
                    decrypt_secret(ciphertext, OLD_KEY)
        assert (await db.execute(text("SELECT encrypted_token FROM telegram_integrations WHERE id = 'no-token'"))).scalar_one() is None
        assert (await db.execute(text("SELECT draft_text FROM telegram_business_messages WHERE id = 'empty-draft'"))).scalar_one() is None
        model = await db.get(TelegramBusinessMessage, "message")
        assert (model.chat_title, model.text, model.draft_text) == ("private title", "private message", "private draft")
        assert (await db.get(TelegramIntegration, "integration")).instructions == "private instruction"
        provider = (await db.execute(select(AIProviderSecret))).scalar_one()
        assert provider.key_version == 2
        for ciphertext, expected_text in [(provider.encrypted_value, "provider secret"),
                ((await db.get(GmailCredential, "account")).encrypted_tokens, "gmail token"),
                ((await db.get(GmailOAuthState, "state")).encrypted_verifier, "oauth verifier")]:
            assert decrypt_secret(ciphertext, NEW_KEY) == expected_text
            with pytest.raises(InvalidTag):
                decrypt_secret(ciphertext, OLD_KEY)


@pytest.mark.asyncio
async def test_failure_rolls_back_all_rotations(rotation_db):
    async with rotation_db() as db:
        await db.execute(text("UPDATE telegram_business_messages SET text = :bad WHERE id = 'message'"),
                         {"bad": encrypt_secret("wrong key", NEW_KEY)})
        await db.commit()
        before = (await db.execute(text("SELECT encrypted_token, instructions FROM telegram_integrations WHERE id = 'integration'"))).one()
    with pytest.raises(InvalidTag):
        await rotate_provider_secrets.rotate()
    async with rotation_db() as db:
        after = (await db.execute(text("SELECT encrypted_token, instructions FROM telegram_integrations WHERE id = 'integration'"))).one()
        assert before == after
        provider = (await db.execute(select(AIProviderSecret))).scalar_one()
        assert provider.key_version == 1
        assert decrypt_secret(provider.encrypted_value, OLD_KEY) == "provider secret"
        assert decrypt_secret((await db.get(GmailCredential, "account")).encrypted_tokens, OLD_KEY) == "gmail token"
        assert decrypt_secret((await db.get(GmailOAuthState, "state")).encrypted_verifier, OLD_KEY) == "oauth verifier"
