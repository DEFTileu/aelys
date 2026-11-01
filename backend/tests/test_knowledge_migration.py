"""Old notes must remain disabled for AI after upgrading."""
import os
import subprocess
import sys
from pathlib import Path

import sqlalchemy as sa


def test_knowledge_upgrade_preserves_notes_and_defaults_to_disabled(tmp_path: Path) -> None:
    backend = Path(__file__).resolve().parents[1]
    path = tmp_path / 'knowledge.db'
    env = os.environ | {'AELYS_DATABASE_URL': f'sqlite+aiosqlite:///{path}', 'AELYS_SECRET_KEY': 'knowledge-migration-test-' * 3, 'PYTHONPATH': str(backend)}
    def upgrade(target: str) -> None:
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', target], cwd=backend, env=env, check=True, capture_output=True, text=True)
    upgrade('0034_google_calendar')
    engine = sa.create_engine(f'sqlite:///{path}')
    with engine.begin() as connection:
        connection.execute(sa.text('ALTER TABLE notes DROP COLUMN knowledge_enabled'))
        connection.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES ('owner', CURRENT_TIMESTAMP, '{}')"))
        connection.execute(sa.text("INSERT INTO notes (id, owner_id, version, created_at, updated_at, title, markdown_body, tags, pinned) VALUES ('note', 'owner', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'Existing', 'private body', '[]', 0)"))
    upgrade('head')
    with engine.connect() as connection:
        row = connection.execute(sa.text("SELECT title, markdown_body, version, knowledge_enabled FROM notes WHERE id='note'")).one()
        assert tuple(row) == ('Existing', 'private body', 7, 0)
    engine.dispose()
