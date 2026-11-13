"""Command queue migration preserves prior owner identity and can roll back."""
import sqlalchemy as sa
from test_clean_migrations import run_alembic


def test_commands_upgrade_downgrade_preserves_identity(tmp_path):
    file = tmp_path / 'commands.db'
    url = f'sqlite+aiosqlite:///{file}'
    run_alembic(url, 'upgrade', '0052_telegram_owner_identity')
    engine = sa.create_engine(f'sqlite:///{file}')
    try:
        # Bootstrap uses current model metadata; reproduce an actually older DB.
        with engine.begin() as db:
            db.execute(sa.text('DROP TABLE IF EXISTS telegram_business_commands'))
            db.execute(sa.text("INSERT INTO users (id,created_at,settings_json) VALUES ('retained',CURRENT_TIMESTAMP,'{}')"))
        run_alembic(url, 'upgrade', 'head')
        run_alembic(url, 'check')
        assert sa.inspect(engine).has_table('telegram_business_commands')
        columns = {column['name']: column for column in sa.inspect(engine).get_columns('telegram_business_commands')}
        assert columns['quote']['nullable'] and not columns['query']['nullable']
        assert columns['session_id']['nullable'] and columns['answer']['nullable']
        assert not columns['knowledge_refs']['nullable']
        assert any(index['name'] == 'ix_telegram_business_commands_session_id' for index in sa.inspect(engine).get_indexes('telegram_business_commands'))
        with engine.connect() as db:
            assert db.scalar(sa.text('SELECT id FROM users')) == 'retained'
            assert db.scalar(sa.text('SELECT version_num FROM alembic_version')) == '0055_ai_action_sources'
        run_alembic(url, 'downgrade', '0052_telegram_owner_identity')
        assert not sa.inspect(engine).has_table('telegram_business_commands')
        run_alembic(url, 'upgrade', 'head')
        run_alembic(url, 'check')
    finally:
        engine.dispose()
