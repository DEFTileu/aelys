"""Server-owned current task work/completion instants; history reuses HistoryEntry."""
import sqlalchemy as sa
from alembic import op

revision = '0033_task_work_timestamps'
down_revision = '0032_owner_memory'
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column['name'] for column in sa.inspect(op.get_bind()).get_columns('tasks')}
    for name in ('started_at', 'completed_at'):
        if name not in columns:
            # Historical tasks have no trustworthy start/completion instant.
            op.add_column('tasks', sa.Column(name, sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('tasks') as batch:
        batch.drop_column('completed_at')
        batch.drop_column('started_at')
