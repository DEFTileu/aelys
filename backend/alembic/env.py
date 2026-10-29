from logging.config import fileConfig
from sqlalchemy import create_engine, pool
from alembic import context
from app.core.db import Base
from app.core import models  # noqa
from app.core.config import get_settings
config = context.config
if config.config_file_name and config.get_section("loggers"):
    fileConfig(config.config_file_name)
target_metadata = Base.metadata

def sync_database_url() -> str:
    """Use the configured application database with a synchronous Alembic driver."""
    return (get_settings().database_url
            .replace("+aiosqlite", "")
            .replace("+asyncpg", "+psycopg"))

def run_migrations_offline():
    context.configure(url=sync_database_url(), target_metadata=target_metadata, literal_binds=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()
def run_migrations_online():
    connectable = create_engine(sync_database_url(), poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
