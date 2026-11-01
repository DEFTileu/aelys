"""Upgrading actual pre-clock rows must not invent historical work dates."""
import json

import sqlalchemy as sa
from test_merge_migrations import alembic


def test_pre_clock_upgrade_preserves_task_version_and_unknown_times(tmp_path):
    path=tmp_path/'task-clocks-upgrade.db'
    alembic(path,'upgrade','head')
    alembic(path,'downgrade','0032_owner_memory')
    engine=sa.create_engine(f'sqlite:///{path}')
    with engine.begin() as connection:
        assert 'started_at' not in {column['name'] for column in sa.inspect(connection).get_columns('tasks')}
        connection.execute(sa.text("INSERT INTO users (id,created_at,settings_json) VALUES ('legacy-owner',CURRENT_TIMESTAMP,'{}')"))
        connection.execute(sa.text("INSERT INTO tasks (id,owner_id,title,description,status,priority,version,created_at,updated_at) VALUES ('legacy-task','legacy-owner','Old in-progress task','','in_progress',2,4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"))
        connection.execute(sa.text('INSERT INTO sync_records (owner_id,resource_kind,resource_id,version,payload) VALUES (:owner,:kind,:id,4,:payload)'),
            {'owner':'legacy-owner','kind':'task','id':'legacy-task','payload':json.dumps({'id':'legacy-task','version':4,'title':'Old in-progress task','status':'in_progress'})})
    engine.dispose()
    alembic(path,'upgrade','head')
    alembic(path,'check')
    engine=sa.create_engine(f'sqlite:///{path}')
    try:
        with engine.connect() as connection:
            row=connection.execute(sa.text("SELECT version,status,started_at,completed_at FROM tasks WHERE id='legacy-task'")).one()
            assert tuple(row)==(4,'in_progress',None,None)
            assert connection.execute(sa.text("SELECT COUNT(*) FROM history_entries")).scalar_one()==0
            assert connection.execute(sa.text("SELECT version FROM sync_records WHERE resource_id='legacy-task'")).scalar_one()==4
    finally:engine.dispose()
