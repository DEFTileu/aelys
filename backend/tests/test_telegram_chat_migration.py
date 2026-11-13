"""Upgrade a real pre-receipt schema without rewriting existing owner data."""

import sqlalchemy as sa
from test_clean_migrations import run_alembic


def test_existing_0034_database_adds_chat_receipts_and_keeps_owner(tmp_path):
    filename = tmp_path / "chat-upgrade.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "0034_google_calendar")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        # Initial legacy metadata includes current tables on fresh installs;
        # remove the future table to reproduce an actual 0034 installation.
        with engine.begin() as db:
            db.execute(sa.text("DROP TABLE IF EXISTS telegram_chat_sends"))
            db.execute(
                sa.text(
                    "INSERT INTO users (id,email,created_at,settings_json) VALUES ('preserved-owner','local',CURRENT_TIMESTAMP,'{}')"
                )
            )
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        inspector = sa.inspect(engine)
        assert inspector.has_table("telegram_chat_sends")
        assert any(
            set(row["column_names"]) == {"owner_id", "idempotency_key"}
            for row in inspector.get_unique_constraints("telegram_chat_sends")
        )
        with engine.connect() as db:
            assert (
                db.scalar(sa.text("SELECT email FROM users WHERE id='preserved-owner'"))
                == "local"
            )
            assert (
                db.scalar(sa.text("SELECT version_num FROM alembic_version"))
                == "0052_telegram_owner_identity"
            )
        run_alembic(url, "downgrade", "0034_google_calendar")
        assert not sa.inspect(engine).has_table("telegram_chat_sends")
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()


def test_existing_0035_upgrade_adds_nullable_media_and_reply_columns(tmp_path):
    filename = tmp_path / "media-upgrade.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "0035_telegram_chat_sends")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        with engine.begin() as db:
            # Reproduce the actual pre-feature schema rather than stamping a new one.
            db.execute(
                sa.text(
                    "ALTER TABLE telegram_business_messages DROP COLUMN media_metadata"
                )
            )
            db.execute(
                sa.text(
                    "ALTER TABLE telegram_business_messages DROP COLUMN reply_to_telegram_message_id"
                )
            )
            db.execute(
                sa.text(
                    "INSERT INTO users (id,email,created_at,settings_json) VALUES ('media-owner','local',CURRENT_TIMESTAMP,'{}')"
                )
            )
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        columns = {
            column["name"]: column
            for column in sa.inspect(engine).get_columns("telegram_business_messages")
        }
        assert (
            columns["media_metadata"]["nullable"]
            and columns["reply_to_telegram_message_id"]["nullable"]
        )
        with engine.connect() as db:
            assert (
                db.scalar(sa.text("SELECT email FROM users WHERE id='media-owner'"))
                == "local"
            )
        run_alembic(url, "downgrade", "0035_telegram_chat_sends")
        assert "media_metadata" not in {
            column["name"]
            for column in sa.inspect(engine).get_columns("telegram_business_messages")
        }
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()
