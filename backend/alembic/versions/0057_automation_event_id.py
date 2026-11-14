"""Allow domain event identifiers in automation execution receipts."""

import sqlalchemy as sa
from alembic import op

revision = "0057_automation_event_id"
down_revision = "0056_telegram_task_suggestions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("automation_executions") as batch:
        batch.alter_column("event_id", existing_type=sa.String(36), type_=sa.String(100), existing_nullable=False)


def downgrade() -> None:
    connection = op.get_bind()
    if connection.execute(sa.text("SELECT 1 FROM automation_executions WHERE length(event_id) > 36 LIMIT 1")).first():
        raise RuntimeError("Cannot narrow automation event IDs while longer values exist")
    with op.batch_alter_table("automation_executions") as batch:
        batch.alter_column("event_id", existing_type=sa.String(100), type_=sa.String(36), existing_nullable=False)
