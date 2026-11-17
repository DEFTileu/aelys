"""Remember how long a focus session is meant to run, so a pomodoro can end by itself."""
import sqlalchemy as sa
from alembic import op

revision = '0063_focus_planned_seconds'
down_revision = '0062_companion_voice'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if 'planned_seconds' not in {column['name'] for column in sa.inspect(op.get_bind()).get_columns('focus_sessions')}:
        op.add_column('focus_sessions', sa.Column('planned_seconds', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('focus_sessions', 'planned_seconds')
