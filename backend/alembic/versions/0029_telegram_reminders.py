"""Opt-in deadline reminders and quiet hours for the existing Telegram worker."""
import sqlalchemy as sa
from alembic import op

revision = "0029_telegram_reminders"
down_revision = "0028_merge_personal_desktop"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('telegram_integrations')}
    for column in [sa.Column('deadline_reminders', sa.Boolean(), nullable=False, server_default=sa.false()),
                   sa.Column('quiet_start', sa.String(5), nullable=True),
                   sa.Column('quiet_end', sa.String(5), nullable=True),
                   sa.Column('pending_digest_on', sa.Date(), nullable=True),
                   sa.Column('pending_digest_at', sa.DateTime(timezone=True), nullable=True)]:
        if column.name not in columns:
            op.add_column('telegram_integrations', column)


def downgrade() -> None:
    with op.batch_alter_table('telegram_integrations') as batch:
        for name in ('pending_digest_at', 'pending_digest_on', 'quiet_end', 'quiet_start', 'deadline_reminders'):
            batch.drop_column(name)
