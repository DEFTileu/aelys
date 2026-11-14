"""Exercise the character migration against an existing SQLite row."""
import importlib.util
from pathlib import Path

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, text


def test_character_migration_preserves_existing_state(monkeypatch):
    path = Path(__file__).parents[1] / 'alembic/versions/0055_companion_character.py'
    spec = importlib.util.spec_from_file_location('character_migration', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine('sqlite://')
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE companion_state (device_id VARCHAR PRIMARY KEY, owner_id VARCHAR NOT NULL)'))
        conn.execute(text("INSERT INTO companion_state VALUES ('board', 'owner')"))
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(conn)))
        migration.upgrade()
        row = conn.execute(text('SELECT owner_id, character_epoch, character_seq, character_json FROM companion_state')).one()
        assert tuple(row) == ('owner', 0, -1, None)
        migration.downgrade()
        assert {column['name'] for column in inspect(conn).get_columns('companion_state')} == {'device_id', 'owner_id'}
        assert conn.execute(text('SELECT owner_id FROM companion_state')).scalar_one() == 'owner'


def test_character_migration_preserves_partially_existing_columns(monkeypatch):
    """The legacy metadata bootstrap can have already created some new columns."""
    path = Path(__file__).parents[1] / 'alembic/versions/0055_companion_character.py'
    spec = importlib.util.spec_from_file_location('character_migration_partial', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine('sqlite://')
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE companion_state (device_id VARCHAR PRIMARY KEY, owner_id VARCHAR NOT NULL, character_epoch BIGINT NOT NULL DEFAULT 0)'))
        conn.execute(text("INSERT INTO companion_state VALUES ('board', 'owner', 42)"))
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(conn)))
        migration.upgrade()
        migration.upgrade()  # Existing columns must never be recreated.
        row = conn.execute(text('SELECT owner_id, character_epoch, character_seq, character_json FROM companion_state')).one()
        assert tuple(row) == ('owner', 42, -1, None)
        migration.downgrade()
        assert {column['name'] for column in inspect(conn).get_columns('companion_state')} == {'device_id', 'owner_id'}
        assert conn.execute(text('SELECT owner_id FROM companion_state')).scalar_one() == 'owner'


def test_character_migration_preserves_all_existing_character_values(monkeypatch):
    path = Path(__file__).parents[1] / 'alembic/versions/0055_companion_character.py'
    spec = importlib.util.spec_from_file_location('character_migration_existing', path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    engine = create_engine('sqlite://')
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE companion_state (device_id VARCHAR PRIMARY KEY, owner_id VARCHAR NOT NULL, character_epoch BIGINT NOT NULL, character_seq BIGINT NOT NULL, character_json JSON)'))
        conn.execute(text('INSERT INTO companion_state VALUES (:device, :owner, :epoch, :seq, :state)'),
                     {'device': 'board', 'owner': 'owner', 'epoch': 42, 'seq': 72, 'state': '{"current":"calm"}'})
        monkeypatch.setattr(migration, 'op', Operations(MigrationContext.configure(conn)))
        migration.upgrade()
        row = conn.execute(text('SELECT character_epoch, character_seq, character_json FROM companion_state')).one()
        assert tuple(row) == (42, 72, '{"current":"calm"}')
