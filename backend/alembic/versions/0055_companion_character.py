"""Bounded character status with per-connection sequence fencing."""
import sqlalchemy as sa
from alembic import op

revision = '0055_companion_character'
down_revision = '0054_telegram_command_sessions'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The legacy initial revision creates current metadata on a clean install,
    # so any of these columns may already exist before this revision runs.
    existing = {column['name'] for column in sa.inspect(op.get_bind()).get_columns('companion_state')}
    columns = (
        sa.Column('character_epoch', sa.BigInteger(), nullable=False, server_default='0'),
        sa.Column('character_seq', sa.BigInteger(), nullable=False, server_default='-1'),
        sa.Column('character_json', sa.JSON(), nullable=True),
    )
    for column in columns:
        if column.name not in existing:
            op.add_column('companion_state', column)


def downgrade() -> None:
    with op.batch_alter_table('companion_state') as batch:
        batch.drop_column('character_json')
        batch.drop_column('character_seq')
        batch.drop_column('character_epoch')
