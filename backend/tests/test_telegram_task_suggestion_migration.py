"""Task suggestion settings and per-message state migrate without data loss."""

import sqlalchemy as sa
from test_clean_migrations import alembic_head, run_alembic


def test_task_suggestion_columns_upgrade_downgrade_preserve_legacy_rows(tmp_path):
    filename = tmp_path / "telegram-task-suggestions.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "0055_ai_action_sources")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        tables_before = set(sa.inspect(engine).get_table_names())
        with engine.begin() as db:
            integration_columns = {
                column["name"] for column in sa.inspect(db).get_columns("telegram_integrations")
            }
            message_columns = {
                column["name"] for column in sa.inspect(db).get_columns("telegram_business_messages")
            }
            for name in ("task_suggestions_chat_id", "task_suggestions_enabled_at"):
                if name in integration_columns:
                    db.execute(sa.text(f"ALTER TABLE telegram_integrations DROP COLUMN {name}"))
            if "task_suggestion_state" in message_columns:
                db.execute(sa.text("ALTER TABLE telegram_business_messages DROP COLUMN task_suggestion_state"))

            db.execute(sa.text("""
                INSERT INTO telegram_integrations
                    (id, owner_id, bot_id, bot_username, bot_name, business_capable,
                     enabled, auto_reply, timezone, instructions, last_update_id,
                     version, created_at, updated_at)
                VALUES ('integration', 'owner', 1, 'bot', 'Bot', 1,
                        1, 0, 'UTC', 'encrypted-instructions', -1,
                        6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """))
            db.execute(sa.text("""
                INSERT INTO telegram_business_connections
                    (id, integration_id, owner_id, telegram_user_id, user_chat_id,
                     enabled, rights, connected_at, updated_at)
                VALUES ('connection', 'integration', 'owner', 1, 2,
                        1, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """))
            db.execute(sa.text("""
                INSERT INTO telegram_business_messages
                    (id, owner_id, version, created_at, updated_at, deleted_at,
                     integration_id, business_connection_id, chat_id, telegram_message_id,
                     chat_title, text, sent_at, direction, draft_status)
                VALUES ('message', 'owner', 9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL,
                        'integration', 'connection', 2, 3, 'encrypted-title',
                        'encrypted-message', CURRENT_TIMESTAMP, 'inbound', 'none')
            """))

        run_alembic(url, "upgrade", "head")
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        inspector = sa.inspect(engine)
        assert set(inspector.get_table_names()) == tables_before
        integration_columns = {
            column["name"]: column for column in inspector.get_columns("telegram_integrations")
        }
        message_columns = {
            column["name"]: column for column in inspector.get_columns("telegram_business_messages")
        }
        assert integration_columns["task_suggestions_chat_id"]["nullable"]
        assert isinstance(integration_columns["task_suggestions_chat_id"]["type"], sa.BigInteger)
        enabled_at = integration_columns["task_suggestions_enabled_at"]
        assert enabled_at["nullable"] and isinstance(enabled_at["type"], sa.DateTime)
        assert message_columns["task_suggestion_state"]["nullable"]
        assert message_columns["task_suggestion_state"]["type"].length == 24
        with engine.connect() as db:
            assert db.execute(sa.text("""
                SELECT id, owner_id, version, bot_username, task_suggestions_chat_id,
                       task_suggestions_enabled_at
                FROM telegram_integrations WHERE id='integration'
            """)).one() == ("integration", "owner", 6, "bot", None, None)
            assert db.execute(sa.text("""
                SELECT id, version, direction, text, task_suggestion_state
                FROM telegram_business_messages WHERE id='message'
            """)).one() == ("message", 9, "inbound", "encrypted-message", None)
            assert db.scalar(sa.text("SELECT version_num FROM alembic_version")) == alembic_head()

        run_alembic(url, "downgrade", "0055_ai_action_sources")
        integration_columns = {
            column["name"] for column in sa.inspect(engine).get_columns("telegram_integrations")
        }
        message_columns = {
            column["name"] for column in sa.inspect(engine).get_columns("telegram_business_messages")
        }
        assert not {"task_suggestions_chat_id", "task_suggestions_enabled_at"} & integration_columns
        assert "task_suggestion_state" not in message_columns
        with engine.connect() as db:
            assert db.execute(sa.text("SELECT id, version, bot_username FROM telegram_integrations WHERE id='integration'")).one() == (
                "integration", 6, "bot"
            )
            assert db.execute(sa.text("SELECT id, version, direction, text FROM telegram_business_messages WHERE id='message'")).one() == (
                "message", 9, "inbound", "encrypted-message"
            )
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()
