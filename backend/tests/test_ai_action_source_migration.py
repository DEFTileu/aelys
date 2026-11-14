"""AI action source and expiry columns migrate without changing legacy actions."""

import sqlalchemy as sa
from test_clean_migrations import alembic_head, run_alembic


def test_ai_action_source_columns_upgrade_downgrade_preserve_legacy_action(tmp_path):
    filename = tmp_path / "ai-action-sources.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "0054_telegram_command_sessions")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        tables_before = set(sa.inspect(engine).get_table_names())
        with engine.begin() as db:
            existing_columns = {column["name"] for column in sa.inspect(db).get_columns("ai_actions")}
            for name in ("source_kind", "source_id", "expires_at"):
                if name in existing_columns:
                    db.execute(sa.text(f"ALTER TABLE ai_actions DROP COLUMN {name}"))
            db.execute(sa.text("""
                INSERT INTO ai_actions
                    (id, owner_id, version, created_at, updated_at, deleted_at,
                     conversation_id, run_id, message_id, tool, arguments_json,
                     title, summary, items_json, status, result_json)
                VALUES ('legacy-action', 'legacy-owner', 7, '2026-01-01 00:00:00',
                        '2026-01-01 00:00:00', NULL, 'conversation', 'run', NULL,
                        'create_task', '{}', 'Legacy', 'preserve me', '[]',
                        'pending', '{}')
            """))

        run_alembic(url, "upgrade", "head")
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        inspector = sa.inspect(engine)
        assert set(inspector.get_table_names()) == tables_before
        columns = {column["name"]: column for column in inspector.get_columns("ai_actions")}
        assert columns["source_kind"]["type"].length == 40 and columns["source_kind"]["nullable"]
        assert columns["source_id"]["type"].length == 36 and columns["source_id"]["nullable"]
        assert isinstance(columns["expires_at"]["type"], sa.DateTime) and columns["expires_at"]["nullable"]
        with engine.connect() as db:
            row = db.execute(sa.text("""
                SELECT id, version, title, summary, source_kind, source_id, expires_at
                FROM ai_actions WHERE id='legacy-action'
            """)).one()
            assert tuple(row) == ("legacy-action", 7, "Legacy", "preserve me", None, None, None)
            assert db.scalar(sa.text("SELECT version_num FROM alembic_version")) == alembic_head()

        run_alembic(url, "downgrade", "0054_telegram_command_sessions")
        columns = {column["name"] for column in sa.inspect(engine).get_columns("ai_actions")}
        assert not {"source_kind", "source_id", "expires_at"} & columns
        with engine.connect() as db:
            assert db.execute(sa.text("SELECT id, version, title, summary FROM ai_actions WHERE id='legacy-action'")).one() == (
                "legacy-action", 7, "Legacy", "preserve me"
            )
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()
