"""Telegram command session columns upgrade and downgrade without data loss."""

import sqlalchemy as sa
from test_clean_migrations import alembic_head, run_alembic


def test_command_session_columns_upgrade_and_downgrade_preserve_legacy_data(tmp_path):
    filename = tmp_path / "telegram-sessions.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "0053_telegram_business_commands")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        tables_before = set(sa.inspect(engine).get_table_names())
        with engine.begin() as db:
            existing_columns = {
                column["name"] for column in sa.inspect(db).get_columns("telegram_business_commands")
            }
            if "ix_telegram_business_commands_session_id" in {
                index["name"] for index in sa.inspect(db).get_indexes("telegram_business_commands")
            }:
                db.execute(sa.text("DROP INDEX ix_telegram_business_commands_session_id"))
            for name in ("session_id", "answer", "knowledge_refs"):
                if name in existing_columns:
                    db.execute(sa.text(f"ALTER TABLE telegram_business_commands DROP COLUMN {name}"))
            db.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES ('owner', CURRENT_TIMESTAMP, '{}')"))
            db.execute(sa.text("""
                INSERT INTO telegram_business_commands
                    (id, owner_id, integration_id, source_message_id, source_version,
                     telegram_message_id, business_connection_id, chat_id, kind, query,
                     quote, reply_to_message_id, state, version, created_at, updated_at)
                VALUES ('legacy', 'owner', 'integration', 'source', 4, 9,
                        'connection', 7, 'ask', 'ciphertext-query', NULL, 8,
                        'queued', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """))

        run_alembic(url, "upgrade", "0054_telegram_command_sessions")
        run_alembic(url, "upgrade", "0054_telegram_command_sessions")
        inspector = sa.inspect(engine)
        assert set(inspector.get_table_names()) == tables_before
        columns = {column["name"]: column for column in inspector.get_columns("telegram_business_commands")}
        assert columns["session_id"]["type"].length == 36 and columns["session_id"]["nullable"]
        assert columns["answer"]["nullable"]
        assert not columns["knowledge_refs"]["nullable"]
        assert any(index["name"] == "ix_telegram_business_commands_session_id" for index in inspector.get_indexes("telegram_business_commands"))
        with engine.connect() as db:
            assert db.execute(sa.text("SELECT query, source_version, version FROM telegram_business_commands WHERE id='legacy'")).one() == ("ciphertext-query", 4, 3)
            assert db.scalar(sa.text("SELECT knowledge_refs FROM telegram_business_commands WHERE id='legacy'")) == "[]"
            assert db.scalar(sa.text("SELECT version_num FROM alembic_version")) == "0054_telegram_command_sessions"

        run_alembic(url, "downgrade", "0053_telegram_business_commands")
        inspector = sa.inspect(engine)
        columns = {column["name"] for column in inspector.get_columns("telegram_business_commands")}
        assert not {"session_id", "answer", "knowledge_refs"} & columns
        assert not any(index["name"] == "ix_telegram_business_commands_session_id" for index in inspector.get_indexes("telegram_business_commands"))
        with engine.connect() as db:
            assert db.scalar(sa.text("SELECT query FROM telegram_business_commands WHERE id='legacy'")) == "ciphertext-query"
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()


def test_clean_upgrade_includes_command_session_schema(tmp_path):
    filename = tmp_path / "telegram-sessions-clean.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "head")
    run_alembic(url, "check")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        inspector = sa.inspect(engine)
        columns = {column["name"]: column for column in inspector.get_columns("telegram_business_commands")}
        assert columns["session_id"]["nullable"]
        assert columns["answer"]["nullable"]
        assert not columns["knowledge_refs"]["nullable"]
        assert any(index["name"] == "ix_telegram_business_commands_session_id" for index in inspector.get_indexes("telegram_business_commands"))
        with engine.connect() as db:
            assert db.scalar(sa.text("SELECT version_num FROM alembic_version")) == alembic_head()
    finally:
        engine.dispose()
