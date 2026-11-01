"""Verify fresh and existing SQLite databases cross the migration merge."""
import os
import subprocess
import sys
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parents[1]
MERGE = "0028_merge_personal_desktop"
_config = Config(str(ROOT / "alembic.ini"))
_config.set_main_option("script_location", str(ROOT / "alembic"))
HEAD = ScriptDirectory.from_config(_config).get_current_head()
PERSONAL = "0025_telegram_personal"
DESKTOP = "0027_note_pinned_mail_read"


def alembic(database: Path, *args: str) -> None:
    env = os.environ | {
        "AELYS_DATABASE_URL": f"sqlite+aiosqlite:///{database}",
        "AELYS_SECRET_KEY": "migration-test-key-" * 3,
        "PYTHONPATH": str(ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env,
                   check=True, capture_output=True, text=True)


def columns(engine: sa.Engine, table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(engine).get_columns(table)}


def test_fresh_database_has_one_head_and_no_schema_drift(tmp_path: Path) -> None:
    config = Config(str(ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(ROOT / "alembic"))
    assert ScriptDirectory.from_config(config).get_heads() == [HEAD]
    assert set(ScriptDirectory.from_config(config).get_revision(MERGE).down_revision) == {PERSONAL, DESKTOP}
    database = tmp_path / "fresh.db"
    alembic(database, "upgrade", "head")
    alembic(database, "check")
    engine = sa.create_engine(f"sqlite:///{database}")
    try:
        with engine.connect() as connection:
            assert connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalars().all() == [HEAD]
    finally:
        engine.dispose()


@pytest.mark.parametrize("branch", [PERSONAL, DESKTOP])
def test_upgrade_from_each_branch_preserves_existing_data(tmp_path: Path, branch: str) -> None:
    database = tmp_path / "branch.db"
    alembic(database, "upgrade", "head")
    # 0001 creates current metadata, so rewind the actual migrations to obtain
    # historical branch schemas instead of stamping a fresh current schema.
    alembic(database, "downgrade", "0024_device_pairing")
    alembic(database, "upgrade", branch)
    engine = sa.create_engine(f"sqlite:///{database}", poolclass=sa.pool.NullPool)
    try:
        telegram_columns = columns(engine, "telegram_integrations")
        focus_columns = columns(engine, "focus_sessions")
        if branch == PERSONAL:
            assert "timezone" in telegram_columns
            assert "paused_seconds" not in focus_columns
            assert "pinned" not in columns(engine, "notes")
        else:
            assert "timezone" not in telegram_columns
            assert "paused_seconds" in focus_columns
            assert "pinned" in columns(engine, "notes")
        with engine.begin() as connection:
            assert connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalars().all() == [branch]
            connection.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES ('owner', CURRENT_TIMESTAMP, '{}')"))
            connection.execute(sa.text("""INSERT INTO telegram_integrations
                (id, owner_id, bot_id, bot_username, bot_name, business_capable, enabled, auto_reply,
                 instructions, last_update_id, version, created_at, updated_at)
                VALUES ('integration', 'owner', 1, 'bot', 'Bot', 1, 1, 0,
                        'encrypted-instructions', 42, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"""))
            connection.execute(sa.text("""INSERT INTO focus_sessions
                (id, owner_id, version, created_at, updated_at, started_at, elapsed_seconds, mode, status)
                VALUES ('focus', 'owner', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                        '2026-10-31 12:00:00', 125, 'pomodoro', 'active')"""))
            if branch == PERSONAL:
                connection.execute(sa.text("UPDATE telegram_integrations SET timezone='Asia/Almaty', digest_time='09:15', reply_delay_seconds=37"))
            else:
                connection.execute(sa.text("UPDATE focus_sessions SET status='paused', paused_at='2026-10-31 12:05:00', paused_seconds=25"))
        alembic(database, "upgrade", "head")
        alembic(database, "check")
        with engine.connect() as connection:
            assert connection.execute(sa.text("SELECT version_num FROM alembic_version")).scalars().all() == [HEAD]
            telegram = connection.execute(sa.text("SELECT instructions, last_update_id, version, timezone, digest_time, reply_delay_seconds FROM telegram_integrations WHERE id='integration'")).one()
            focus = connection.execute(sa.text("SELECT version, started_at, elapsed_seconds, status, paused_at, paused_seconds FROM focus_sessions WHERE id='focus'")).one()
            expected_telegram = ("Asia/Almaty", "09:15", 37) if branch == PERSONAL else ("UTC", None, 90)
            expected_focus = ("active", None, 0) if branch == PERSONAL else ("paused", "2026-10-31 12:05:00", 25)
            assert tuple(telegram) == ("encrypted-instructions", 42, 3, *expected_telegram)
            assert tuple(focus) == (4, "2026-10-31 12:00:00", 125, *expected_focus)
        assert "pinned" in columns(engine, "notes")
        assert "is_read" in columns(engine, "mail_messages")
        assert "events" in columns(engine, "agent_session_index")
    finally:
        engine.dispose()
