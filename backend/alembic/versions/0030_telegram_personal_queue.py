"""Durable encrypted owner dialogue queue and persistent conversation binding."""
import sqlalchemy as sa
from alembic import op

revision = '0030_telegram_personal_queue'
down_revision = '0029_telegram_reminders'
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('telegram_integrations')}
    if 'personal_conversation_id' not in columns:
        # Batch recreates the SQLite table when adding the named foreign key.
        with op.batch_alter_table('telegram_integrations') as batch:
            batch.add_column(sa.Column('personal_conversation_id', sa.String(36), nullable=True))
            batch.create_foreign_key('fk_telegram_personal_conversation', 'ai_conversations', ['personal_conversation_id'], ['id'])
    if 'telegram_personal_jobs' not in sa.inspect(op.get_bind()).get_table_names():
        from app.integrations.telegram_models import TelegramPersonalJob
        TelegramPersonalJob.__table__.create(bind=op.get_bind())


def downgrade() -> None:
    op.drop_table('telegram_personal_jobs')
    with op.batch_alter_table('telegram_integrations') as batch:
        batch.drop_column('personal_conversation_id')
