"""HTML migration preserves existing plaintext and read state."""
import sqlalchemy as sa
from test_clean_migrations import run_alembic


def test_mail_html_migration_preserves_existing_message(tmp_path):
    filename = tmp_path / 'mail-html.db'
    url = f'sqlite+aiosqlite:///{filename}'
    run_alembic(url, 'upgrade', '0041_calendar_browser_handoff')
    engine = sa.create_engine(f'sqlite:///{filename}')
    try:
        with engine.begin() as db:
            if 'body_html' in {item['name'] for item in sa.inspect(db).get_columns('mail_messages')}:
                db.execute(sa.text('ALTER TABLE mail_messages DROP COLUMN body_html'))
            db.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES ('owner', CURRENT_TIMESTAMP, '{}')"))
            db.execute(sa.text("INSERT INTO mail_messages (id,owner_id,version,created_at,updated_at,sender,recipients,subject,body,received_at,sync_origin,is_read) VALUES ('message','owner',3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'sender','[]','subject','preserved text',CURRENT_TIMESTAMP,'gmail',1)"))
        run_alembic(url, 'upgrade', 'head')
        run_alembic(url, 'check')
        with engine.connect() as db:
            assert db.execute(sa.text('SELECT body,version,is_read,body_html FROM mail_messages')).one() == ('preserved text',3,1,None)
        run_alembic(url, 'downgrade', '0041_calendar_browser_handoff')
        with engine.connect() as db:
            assert db.scalar(sa.text('SELECT body FROM mail_messages')) == 'preserved text'
        run_alembic(url, 'upgrade', 'head')
        run_alembic(url, 'check')
    finally:
        engine.dispose()
