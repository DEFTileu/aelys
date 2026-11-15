"""Remember each board's voice conversation."""
import sqlalchemy as sa
from alembic import op

revision = '0061_companion_voice'
down_revision = '0060_companion_weather'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if 'voice_conversation_id' not in {column['name'] for column in sa.inspect(op.get_bind()).get_columns('companion_state')}:
        op.add_column('companion_state', sa.Column('voice_conversation_id', sa.String(36), nullable=True))


def downgrade() -> None:
    op.drop_column('companion_state', 'voice_conversation_id')
