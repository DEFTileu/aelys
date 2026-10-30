"""Exercise the real Alembic chain on an empty SQLite or opted-in PostgreSQL DB."""
import os
import subprocess
import sys
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.script import ScriptDirectory

ROOT = Path(__file__).resolve().parents[1]


def run_alembic(url: str, *args: str) -> None:
    env = os.environ | {"AELYS_DATABASE_URL": url, "AELYS_SECRET_KEY": "migration-test-key-" * 3,
                        "PYTHONPATH": str(ROOT)}
    subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env,
                   check=True, capture_output=True, text=True)


@pytest.mark.parametrize("backend", ["sqlite", "postgresql"])
def test_clean_and_incremental_upgrade(backend: str, tmp_path: Path) -> None:
    if backend == "postgresql":
        url = os.environ.get("AELYS_TEST_POSTGRES_MIGRATION_URL")
        if not url:
            pytest.skip("set AELYS_TEST_POSTGRES_MIGRATION_URL to an empty disposable database")
        parsed = sa.engine.make_url(url)
        if parsed.get_backend_name() != "postgresql":
            pytest.fail("migration test URL must point to PostgreSQL")
        sync_url = parsed.set(drivername="postgresql+psycopg")
    else:
        url = f"sqlite+aiosqlite:///{tmp_path / 'clean.db'}"
        sync_url = sa.engine.make_url(url).set(drivername="sqlite")

    # Alembic runs in separate processes; do not retain stale SQLite schema caches.
    engine = sa.create_engine(sync_url, poolclass=sa.pool.NullPool)
    try:
        # Refuse to touch any existing objects, including Alembic's version table.
        with engine.connect() as connection:
            inspector = sa.inspect(connection)
            assert not inspector.get_table_names() and not inspector.get_view_names(), "test database must be empty"
        run_alembic(url, "upgrade", "0001_initial")
        inspector = sa.inspect(engine)
        assert not inspector.has_table("auth_sessions")
        assert not inspector.has_table("gmail_oauth_states")
        with engine.begin() as connection:
            connection.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES (:id, CURRENT_TIMESTAMP, :settings)"),
                               {"id": "migration-test-owner", "settings": "{}"})
        run_alembic(url, "upgrade", "0005_auth_sessions")
        assert sa.inspect(engine).has_table("auth_sessions")
        assert not sa.inspect(engine).has_table("gmail_oauth_states")
        run_alembic(url, "upgrade", "0013_ai_run_request_binding")
        fks = sa.inspect(engine).get_foreign_keys("ai_runs")
        for column, target in (("provider_id", "ai_providers"), ("prompt_message_id", "ai_messages")):
            matching = [fk for fk in fks if fk["constrained_columns"] == [column] and fk["referred_table"] == target]
            assert len(matching) == 1
        run_alembic(url, "upgrade", "0016_gmail_connection")
        gmail_fks = sa.inspect(engine).get_foreign_keys("gmail_oauth_states")
        assert any(fk["constrained_columns"] == ["session_id"] and fk["referred_table"] == "auth_sessions" for fk in gmail_fks)
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        config = Config(str(ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(ROOT / "alembic"))
        head = ScriptDirectory.from_config(config).get_current_head()
        with engine.connect() as connection:
            assert connection.scalar(sa.text("SELECT version_num FROM alembic_version")) == head
            assert connection.scalar(sa.text("SELECT id FROM users WHERE id = 'migration-test-owner'")) == "migration-test-owner"
    finally:
        engine.dispose()
