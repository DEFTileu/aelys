"""Exercise the upgrade against notes created before organization fields existed."""
import os
import subprocess
import sys
from pathlib import Path

import sqlalchemy as sa


def test_existing_notes_survive_organization_upgrade(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    path = tmp_path / 'notes.db'
    url = f'sqlite+aiosqlite:///{path}'
    env = os.environ | {'AELYS_DATABASE_URL': url, 'AELYS_SECRET_KEY': 'migration-test-key-' * 3, 'PYTHONPATH': str(root)}
    def upgrade(target: str) -> None:
        subprocess.run([sys.executable, '-m', 'alembic', 'upgrade', target], cwd=root, env=env, check=True, capture_output=True, text=True)
    upgrade('0022_telegram_business')
    engine = sa.create_engine(f'sqlite:///{path}')
    with engine.begin() as connection:
        # The initial migration uses current metadata; recreate the old shape.
        connection.execute(sa.text('ALTER TABLE notes DROP COLUMN folder'))
        connection.execute(sa.text('ALTER TABLE notes DROP COLUMN tags'))
        connection.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES ('owner', CURRENT_TIMESTAMP, '{}')"))
        connection.execute(sa.text("INSERT INTO notes (id, owner_id, version, created_at, updated_at, title, markdown_body, parent_id) VALUES ('note', 'owner', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'Existing', 'body', 'parent')"))
    upgrade('head')
    with engine.connect() as connection:
        row = connection.execute(sa.text('SELECT title, markdown_body, parent_id, version, folder, tags FROM notes WHERE id = :id'), {'id': 'note'}).one()
        assert tuple(row) == ('Existing', 'body', 'parent', 4, None, '[]')
    engine.dispose()
