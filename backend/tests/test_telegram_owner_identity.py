"""Verified Telegram owner identity capture and its schema migration."""

from datetime import timedelta

import pytest
import sqlalchemy as sa
from app.ai.crypto import decrypt_secret
from app.core.db import Base
from app.core.models import User, now
from app.core.security import token_hash
from app.integrations import telegram_service as service
from app.integrations.telegram_models import TelegramIntegration
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session
from test_clean_migrations import alembic_head, run_alembic

OWNER_ID = 24680


def test_profile_name_is_normalized_bounded_and_ignores_other_fields():
    name = service.owner_profile_name({
        "first_name": "  Ｍｉｒａ\n",
        "last_name": "V" * 200,
        "username": "must-not-be-used",
        "contact": {"first_name": "also-not-used"},
    })
    assert name == "Mira " + "V" * 155
    assert len(name) == 160


@pytest.fixture
async def identity_db(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/identity.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        session.add(User(id="owner"))
        item = TelegramIntegration(
            id="telegram", owner_id="owner", bot_id=1, bot_username="bot",
            bot_name="Bot", business_capable=True, owner_telegram_id=OWNER_ID,
        )
        session.add(item)
        await session.commit()
    yield engine, sessions
    await engine.dispose()


def verified_binding(item, name="Mira Vale"):
    code = "verified-binding-code-123456"
    item.owner_telegram_id = None
    item.binding_code_hash = token_hash(code)
    item.binding_expires_at = now() + timedelta(minutes=5)
    return code, {
        "message": {
            "text": f"/start aelys_{code}",
            "from": {"id": OWNER_ID, "is_bot": False, "first_name": name.split()[0],
                     "last_name": " ".join(name.split()[1:])},
            "chat": {"id": OWNER_ID, "type": "private"},
        }
    }


@pytest.mark.asyncio
async def test_successful_private_binding_stores_only_bounded_normalized_profile_name(identity_db):
    _, sessions = identity_db
    async with sessions() as session:
        item = await session.get(TelegramIntegration, "telegram")
        _code, payload = verified_binding(item, "  Mira   Vale  ")
        payload["message"]["from"]["first_name"] = "  Mira\t"
        payload["message"]["from"]["last_name"] = "Vale   "
        await service.ingest_update(session, item, payload, None)
        await session.commit()
        await session.refresh(item)
        assert item.owner_telegram_id == OWNER_ID
        assert item.owner_name == "Mira Vale"
        assert item.binding_code_hash is None


@pytest.mark.asyncio
async def test_rejected_binding_cannot_change_owner_name(identity_db):
    _, sessions = identity_db
    async with sessions() as session:
        item = await session.get(TelegramIntegration, "telegram")
        item.owner_name = "Existing Owner"
        code, payload = verified_binding(item)
        item.owner_telegram_id = OWNER_ID
        payload["message"]["from"]["id"] = OWNER_ID + 1
        payload["message"]["chat"]["id"] = OWNER_ID + 1
        await service.ingest_update(session, item, payload, None)
        await session.commit()
        await session.refresh(item)
        assert item.owner_telegram_id == OWNER_ID
        assert item.owner_name == "Existing Owner"
        assert item.binding_code_hash == token_hash(code)


@pytest.mark.asyncio
async def test_accepted_owner_business_connection_captures_user_profile_name(identity_db):
    _, sessions = identity_db
    async with sessions() as session:
        item = await session.get(TelegramIntegration, "telegram")
        connection = await service.accept_connection(session, item, {
            "id": "business-owner", "user": {"id": OWNER_ID, "first_name": "Mira", "last_name": "Vale"},
            "user_chat_id": OWNER_ID, "is_enabled": True,
            "rights": {"can_reply": True},
        })
        await session.commit()
        await session.refresh(item)
        assert connection is not None
        assert item.owner_name == "Mira Vale"


@pytest.mark.asyncio
async def test_foreign_or_disabled_business_connection_cannot_change_owner_name(identity_db):
    _, sessions = identity_db
    async with sessions() as session:
        item = await session.get(TelegramIntegration, "telegram")
        item.owner_name = "Existing Owner"
        foreign = await service.accept_connection(session, item, {
            "id": "foreign", "user": {"id": OWNER_ID + 1, "first_name": "Other"},
            "user_chat_id": OWNER_ID + 1, "is_enabled": True,
        })
        disabled = await service.accept_connection(session, item, {
            "id": "disabled", "user": {"id": OWNER_ID, "first_name": "Wrong"},
            "user_chat_id": OWNER_ID, "is_enabled": False,
        })
        await session.commit()
        await session.refresh(item)
        assert foreign is None
        assert disabled is not None and not disabled.enabled
        assert item.owner_name == "Existing Owner"


@pytest.mark.asyncio
async def test_fresh_verified_connection_backfills_missing_owner_name(identity_db):
    _, sessions = identity_db

    class Client:
        async def get_business_connection(self, connection_id):
            assert connection_id == "fresh-owner"
            return {
                "id": connection_id, "user": {"id": OWNER_ID, "first_name": "Mira", "last_name": "Vale"},
                "user_chat_id": OWNER_ID, "is_enabled": True,
                "rights": {"can_reply": True},
            }

    async with sessions() as session:
        item = await session.get(TelegramIntegration, "telegram")
        result = await service.verified_connection(session, item, Client(), "fresh-owner", fresh=True)
        await session.commit()
        await session.refresh(item)
        assert result is not None
        assert item.owner_name == "Mira Vale"


@pytest.mark.asyncio
async def test_disconnect_or_bot_replacement_purge_clears_owner_identity(identity_db):
    _, sessions = identity_db
    async with sessions() as session:
        item = await session.get(TelegramIntegration, 'telegram')
        item.owner_name = 'Existing Owner'
        await session.commit()
        await service.purge_integration(session, item)
        await session.commit()
        await session.refresh(item)
        assert item.owner_name is None


@pytest.mark.asyncio
async def test_owner_name_is_encrypted_at_rest(identity_db):
    engine, _ = identity_db
    sync_engine = sa.create_engine(engine.url.render_as_string(hide_password=False).replace("+aiosqlite", ""))
    try:
        with Session(sync_engine) as session:
            item = session.get(TelegramIntegration, "telegram")
            item.owner_name = "Mira Vale"
            session.commit()
        with sync_engine.connect() as connection:
            ciphertext = connection.scalar(sa.text("SELECT owner_name FROM telegram_integrations WHERE id='telegram'"))
            assert ciphertext != "Mira Vale"
            assert decrypt_secret(ciphertext) == "Mira Vale"
        with Session(sync_engine) as session:
            assert session.get(TelegramIntegration, "telegram").owner_name == "Mira Vale"
    finally:
        sync_engine.dispose()


def test_0052_migration_preserves_existing_integrations(tmp_path):
    filename = tmp_path / "owner-identity-migration.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "head")
    run_alembic(url, "downgrade", "0051_companion_v11")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        with engine.begin() as connection:
            connection.execute(sa.text(
                "INSERT INTO users (id, created_at, settings_json) VALUES ('preserved-owner', CURRENT_TIMESTAMP, '{}')"
            ))
            connection.execute(sa.text("""INSERT INTO telegram_integrations
                (id, owner_id, bot_id, bot_username, bot_name, business_capable, enabled, auto_reply,
                 instructions, last_update_id, version, created_at, updated_at)
                VALUES ('preserved-integration', 'preserved-owner', 1, 'bot', 'Bot', 1, 1, 0,
                        'encrypted-existing-instructions', 41, 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"""))
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        columns = {column["name"] for column in sa.inspect(engine).get_columns("telegram_integrations")}
        assert "owner_name" in columns
        with engine.connect() as connection:
            row = connection.execute(sa.text("SELECT instructions, last_update_id, version, owner_name FROM telegram_integrations WHERE id='preserved-integration'")).one()
            assert tuple(row) == ("encrypted-existing-instructions", 41, 6, None)
            assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == alembic_head()
    finally:
        engine.dispose()
