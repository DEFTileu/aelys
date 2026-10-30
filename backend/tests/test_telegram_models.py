import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
import sqlalchemy as sa
from app.core.models import User
from app.integrations.telegram_models import (
    TelegramBusinessConnection,
    TelegramBusinessMessage,
    TelegramIntegration,
    TelegramUpdateReceipt,
)
from sqlalchemy.orm import Session

ROOT = Path(__file__).parents[1]
TABLES = [TelegramIntegration.__table__, TelegramBusinessConnection.__table__,
          TelegramBusinessMessage.__table__, TelegramUpdateReceipt.__table__]


def alembic(database, *args):
    env = os.environ | {"AELYS_DATABASE_URL": f"sqlite+aiosqlite:///{database}",
                        "AELYS_SECRET_KEY": "x" * 32, "PYTHONPATH": str(ROOT)}
    return subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT,
                          env=env, check=True, capture_output=True, text=True)


def test_migration_fresh_and_existing_0021(tmp_path):
    database = tmp_path / "telegram.db"
    alembic(database, "upgrade", "head")
    engine = sa.create_engine(f"sqlite:///{database}")
    # Exercise the actual 0021 -> 0022 creation path as well as fresh upgrade.
    alembic(database, "downgrade", "0021_sqlite_ai_run_foreign_keys")
    assert not any(table.name in sa.inspect(engine).get_table_names() for table in TABLES)
    alembic(database, "upgrade", "head")
    inspector = sa.inspect(engine)
    for table in TABLES:
        columns = {column["name"]: column for column in inspector.get_columns(table.name)}
        assert set(columns) == set(table.columns.keys())
        for model_column in table.columns:
            column = columns[model_column.name]
            assert column["nullable"] == model_column.nullable
            assert str(column["type"]) == str(model_column.type)
        assert {tuple(fk["constrained_columns"]) for fk in inspector.get_foreign_keys(table.name)} == {
            (fk.parent.name,) for fk in table.foreign_keys
        }
        assert {tuple(index["column_names"]) for index in inspector.get_indexes(table.name)} == {
            tuple(column.name for column in index.columns) for index in table.indexes
        }
        assert {tuple(c["column_names"]) for c in inspector.get_unique_constraints(table.name)} == {
            tuple(column.name for column in constraint.columns)
            for constraint in table.constraints if isinstance(constraint, sa.UniqueConstraint)
        }
        assert inspector.get_pk_constraint(table.name)["constrained_columns"] == [c.name for c in table.primary_key]
    engine.dispose()


def test_defaults_and_idempotency_constraints():
    engine = sa.create_engine("sqlite://")
    User.__table__.create(engine)
    # Provider target is needed for SQLAlchemy's FK dependency metadata.
    from app.core.models import AIProvider
    AIProvider.__table__.create(engine)
    for table in TABLES:
        table.create(engine)
    now = datetime.now(UTC)
    with Session(engine) as session:
        session.add(User(id="user"))
        session.add(TelegramIntegration(id="integration", owner_id="user", bot_id=1,
                                        bot_username="bot", bot_name="Bot", business_capable=True))
        session.flush()
        integration = session.get(TelegramIntegration, "integration")
        assert (integration.version, integration.enabled, integration.auto_reply,
                integration.instructions, integration.last_update_id) == (1, True, False, "", -1)
        session.add(TelegramBusinessConnection(id="connection", integration_id="integration", owner_id="user",
                     telegram_user_id=1, user_chat_id=2, enabled=True, connected_at=now, updated_at=now))
        session.add(TelegramUpdateReceipt(integration_id="integration", update_id=5))
        session.add(TelegramBusinessMessage(id="message", owner_id="user", integration_id="integration",
                    business_connection_id="connection", chat_id=2, telegram_message_id=3, sent_at=now))
        session.flush()
        assert session.get(TelegramBusinessConnection, "connection").rights == {}
        message = session.get(TelegramBusinessMessage, "message")
        assert (message.version, message.direction, message.draft_status, message.text, message.chat_title) == (1, "inbound", "none", "", "")
        assert session.get(TelegramUpdateReceipt, ("integration", 5)).processed_at is not None
        session.add(TelegramBusinessMessage(id="duplicate", owner_id="user", integration_id="integration",
                    business_connection_id="connection", chat_id=2, telegram_message_id=3, sent_at=now))
        with pytest.raises(sa.exc.IntegrityError):
            session.flush()
    engine.dispose()


def test_content_is_encrypted_at_rest(tmp_path):
    database = tmp_path / "encrypted.db"
    alembic(database, "upgrade", "head")
    engine = sa.create_engine(f"sqlite:///{database}")
    now = datetime.now(UTC)
    with Session(engine) as session:
        session.add(User(id="owner"))
        session.add(TelegramIntegration(id="integration", owner_id="owner", bot_id=1, bot_username="bot",
                    bot_name="Bot", business_capable=True, instructions="private instructions",
                    encrypted_token="already encrypted"))
        session.add(TelegramBusinessConnection(id="connection", integration_id="integration", owner_id="owner",
                    telegram_user_id=1, user_chat_id=2, enabled=True, connected_at=now, updated_at=now))
        session.add(TelegramBusinessMessage(id="message", owner_id="owner", integration_id="integration",
                    business_connection_id="connection", chat_id=2, telegram_message_id=3, sent_at=now,
                    chat_title="private title", text="private message", draft_text="private draft"))
        session.commit()
    with engine.connect() as connection:
        instructions, token = connection.execute(sa.text(
            "SELECT instructions, encrypted_token FROM telegram_integrations")).one()
        title, text, draft = connection.execute(sa.text(
            "SELECT chat_title, text, draft_text FROM telegram_business_messages")).one()
        assert token == "already encrypted"
        for ciphertext, plaintext in [(instructions, "private instructions"), (title, "private title"),
                                      (text, "private message"), (draft, "private draft")]:
            assert plaintext not in ciphertext
    with Session(engine) as session:
        assert session.get(TelegramIntegration, "integration").instructions == "private instructions"
        message = session.get(TelegramBusinessMessage, "message")
        assert (message.chat_title, message.text, message.draft_text) == (
            "private title", "private message", "private draft")
        message.draft_text = None
        session.commit()
        session.expire_all()
        assert session.get(TelegramBusinessMessage, "message").draft_text is None
    engine.dispose()
