"""Personal commands, daily digest and structured secretary decisions."""
import sqlalchemy as sa
from alembic import op

revision = '0025_telegram_personal'
down_revision = '0024_device_pairing'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The historical initial migration creates current metadata on fresh installs.
    existing = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('telegram_integrations')}
    for column in [
        sa.Column('timezone', sa.String(64), nullable=False, server_default='UTC'),
        sa.Column('digest_time', sa.String(5), nullable=True),
        sa.Column('last_digest_on', sa.Date(), nullable=True),
        sa.Column('reply_delay_seconds', sa.Integer(), nullable=False, server_default='90'),
        sa.Column('status_text', sa.Text(), nullable=True),
        sa.Column('status_until', sa.DateTime(timezone=True), nullable=True),
    ]:
        if column.name not in existing:
            op.add_column('telegram_integrations', column)
    messages = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('telegram_business_messages')}
    if 'owner_note' not in messages:
        op.add_column('telegram_business_messages', sa.Column('owner_note', sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('telegram_business_messages') as batch:
        batch.drop_column('owner_note')
    with op.batch_alter_table('telegram_integrations') as batch:
        for name in ('timezone', 'digest_time', 'last_digest_on', 'reply_delay_seconds', 'status_text', 'status_until'):
            batch.drop_column(name)
