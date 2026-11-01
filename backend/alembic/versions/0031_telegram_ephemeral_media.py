"""Metadata-only personal media queue; file bytes are never persisted."""
import sqlalchemy as sa
from alembic import op

revision = '0031_telegram_ephemeral_media'
down_revision = '0030_telegram_personal_queue'
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column['name'] for column in sa.inspect(op.get_bind()).get_columns('telegram_personal_jobs')}
    for column in [sa.Column('input_kind', sa.String(16), nullable=False, server_default='text'),
                   sa.Column('media_metadata', sa.Text(), nullable=True)]:
        if column.name not in columns:
            op.add_column('telegram_personal_jobs', column)


def downgrade() -> None:
    with op.batch_alter_table('telegram_personal_jobs') as batch:
        batch.drop_column('media_metadata')
        batch.drop_column('input_kind')
