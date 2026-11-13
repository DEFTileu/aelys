from datetime import UTC, datetime

import pytest
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core.config import get_settings
from app.core.db import Base
from app.core.models import User
from cryptography.exceptions import InvalidTag
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from scripts import rotate_provider_secrets

OLD_KEY = "old-test-provider-key-0123456789abcdef"
NEW_KEY = "new-test-provider-key-0123456789abcdef"


@pytest.fixture
async def rotation_db(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'telegram-command-rotation.db'}")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(rotate_provider_secrets, "SessionLocal", sessions)
    monkeypatch.setenv("AELYS_PROVIDER_ENCRYPTION_KEY_OLD", OLD_KEY)
    monkeypatch.setenv("AELYS_PROVIDER_ENCRYPTION_KEY", OLD_KEY)
    get_settings.cache_clear()
    now = datetime.now(UTC).isoformat()
    async with sessions() as db:
        db.add(User(id="owner"))
        await db.flush()
        await db.execute(
            text("""
                INSERT INTO telegram_integrations
                    (id, owner_id, encrypted_token, bot_id, bot_username, bot_name,
                     business_capable, enabled, auto_reply, timezone, reply_delay_seconds,
                     owner_name, instructions, last_update_id, version, created_at, updated_at)
                VALUES
                    ('integration', 'owner', NULL, 1, 'bot', 'Bot', 1, 1, 0, 'UTC', 90,
                     :owner_name, :instructions, -1, 1, :now, :now)
            """),
            {
                "owner_name": encrypt_secret("Private Owner", OLD_KEY),
                "instructions": encrypt_secret("Private instructions", OLD_KEY),
                "now": now,
            },
        )
        await db.execute(text("""
            INSERT INTO telegram_business_connections
                (id, integration_id, owner_id, telegram_user_id, user_chat_id, enabled,
                 rights, connected_at, updated_at)
            VALUES ('connection', 'integration', 'owner', 1, 2, 1, '{}', :now, :now)
        """), {"now": now})
        await db.execute(text("""
            INSERT INTO telegram_business_messages
                (id, owner_id, integration_id, business_connection_id, chat_id,
                 telegram_message_id, chat_title, text, sent_at, direction, draft_status, version,
                 created_at, updated_at)
            VALUES ('source', 'owner', 'integration', 'connection', 2, 3,
                    :title, :body, :now, 'inbound', 'none', 1, :now, :now)
        """), {
            "title": encrypt_secret("Private chat", OLD_KEY),
            "body": encrypt_secret("Source message", OLD_KEY),
            "now": now,
        })
        await db.execute(text("""
            INSERT INTO telegram_business_commands
                (id, owner_id, integration_id, source_message_id, source_version,
                 telegram_message_id, business_connection_id, chat_id, kind, query, quote,
                 reply_to_message_id, state, version, created_at, updated_at)
            VALUES
                ('command-with-quote', 'owner', 'integration', 'source', 1, 10,
                 'connection', 2, 'ask', :query, :quote, 3, 'queued', 1, :now, :now),
                ('command-without-quote', 'owner', 'integration', 'source', 1, 11,
                 'connection', 2, 'search', :second_query, NULL, 3, 'queued', 1, :now, :now)
        """), {
            "query": encrypt_secret("Private query", OLD_KEY),
            "quote": encrypt_secret("Untrusted quote", OLD_KEY),
            "second_query": encrypt_secret("Another query", OLD_KEY),
            "now": now,
        })
        await db.commit()
    monkeypatch.setenv("AELYS_PROVIDER_ENCRYPTION_KEY", NEW_KEY)
    get_settings.cache_clear()
    yield sessions
    await engine.dispose()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_rotates_owner_name_and_business_command_fields(rotation_db):
    assert await rotate_provider_secrets.rotate() == 4

    async with rotation_db() as db:
        integration = (await db.execute(text(
            "SELECT owner_name FROM telegram_integrations WHERE id = 'integration'"
        ))).scalar_one()
        commands = (await db.execute(text(
            "SELECT id, query, quote FROM telegram_business_commands ORDER BY id"
        ))).mappings().all()

    assert decrypt_secret(integration, NEW_KEY) == "Private Owner"
    with pytest.raises(InvalidTag):
        decrypt_secret(integration, OLD_KEY)
    assert [(row["id"], decrypt_secret(row["query"], NEW_KEY)) for row in commands] == [
        ("command-with-quote", "Private query"),
        ("command-without-quote", "Another query"),
    ]
    assert decrypt_secret(commands[0]["quote"], NEW_KEY) == "Untrusted quote"
    assert commands[1]["quote"] is None
    for row in commands:
        with pytest.raises(InvalidTag):
            decrypt_secret(row["query"], OLD_KEY)
    with pytest.raises(InvalidTag):
        decrypt_secret(commands[0]["quote"], OLD_KEY)


@pytest.mark.asyncio
async def test_old_key_decryption_failure_rolls_back_rotation(rotation_db):
    async with rotation_db() as db:
        await db.execute(text("""
            UPDATE telegram_business_commands SET quote = :bad
            WHERE id = 'command-with-quote'
        """), {"bad": encrypt_secret("Wrong-key quote", NEW_KEY)})
        await db.commit()
        before = (await db.execute(text("""
            SELECT owner_name FROM telegram_integrations WHERE id = 'integration'
        """))).scalar_one()
        before_query = (await db.execute(text("""
            SELECT query FROM telegram_business_commands WHERE id = 'command-without-quote'
        """))).scalar_one()

    with pytest.raises(InvalidTag):
        await rotate_provider_secrets.rotate()

    async with rotation_db() as db:
        after = (await db.execute(text("""
            SELECT owner_name FROM telegram_integrations WHERE id = 'integration'
        """))).scalar_one()
        after_query = (await db.execute(text("""
            SELECT query FROM telegram_business_commands WHERE id = 'command-without-quote'
        """))).scalar_one()

    assert after == before
    assert after_query == before_query
    assert decrypt_secret(after, OLD_KEY) == "Private Owner"
    assert decrypt_secret(after_query, OLD_KEY) == "Another query"
