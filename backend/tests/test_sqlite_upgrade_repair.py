import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations


def migration(connection, monkeypatch):
    path = Path(__file__).parents[1] / "alembic/versions/0021_sqlite_ai_run_foreign_keys.py"
    spec = importlib.util.spec_from_file_location("sqlite_ai_run_repair", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "op", Operations(MigrationContext.configure(connection)))
    return module


def legacy_schema(connection):
    connection.execute(sa.text("CREATE TABLE ai_messages (id VARCHAR(36) PRIMARY KEY)"))
    connection.execute(sa.text("CREATE TABLE ai_providers (id VARCHAR(36) PRIMARY KEY)"))
    connection.execute(sa.text("CREATE TABLE ai_runs (id VARCHAR(36) PRIMARY KEY, prompt_message_id VARCHAR(36), provider_id VARCHAR(36))"))


def test_repair_preserves_records_and_is_repeatable(monkeypatch):
    with sa.create_engine("sqlite://").begin() as connection:
        connection.execute(sa.text("PRAGMA foreign_keys=ON"))
        legacy_schema(connection)
        connection.execute(sa.text("INSERT INTO ai_messages VALUES ('message-1')"))
        connection.execute(sa.text("INSERT INTO ai_providers VALUES ('provider-1')"))
        connection.execute(sa.text("INSERT INTO ai_runs VALUES ('run-1', 'message-1', 'provider-1')"))
        repair = migration(connection, monkeypatch)
        repair.upgrade(); repair.upgrade()
        assert len(sa.inspect(connection).get_foreign_keys("ai_runs")) == 2
        assert connection.execute(sa.text("SELECT * FROM ai_runs")).one() == ('run-1', 'message-1', 'provider-1')
        with pytest.raises(sa.exc.IntegrityError):
            connection.execute(sa.text("INSERT INTO ai_runs VALUES ('invalid', 'missing', NULL)"))


def test_repair_refuses_to_remove_orphans(monkeypatch):
    with sa.create_engine("sqlite://").begin() as connection:
        legacy_schema(connection)
        connection.execute(sa.text("INSERT INTO ai_runs VALUES ('run-1', 'missing', NULL)"))
        with pytest.raises(RuntimeError, match="no records were deleted"):
            migration(connection, monkeypatch).upgrade()
        assert connection.execute(sa.text("SELECT count(*) FROM ai_runs")).scalar_one() == 1
        assert sa.inspect(connection).get_foreign_keys("ai_runs") == []
