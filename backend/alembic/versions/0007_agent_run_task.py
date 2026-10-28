"""persist the redacted agent instruction needed for runtime execution"""
from alembic import op
import sqlalchemy as sa

revision = "0007_agent_run_task"
down_revision = "0006_isolation_attestation"
branch_labels = None
depends_on = None

def upgrade():
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("agent_runs")}
    if "task" not in existing:
        op.add_column("agent_runs", sa.Column("task", sa.Text(), nullable=False, server_default=""))
    if "lease_id" not in existing:
        op.add_column("agent_runs", sa.Column("lease_id", sa.String(length=36), nullable=True))
    if "cancellation_requested" not in existing:
        op.add_column("agent_runs", sa.Column("cancellation_requested", sa.Boolean(), nullable=False, server_default=sa.false()))

def downgrade():
    op.drop_column("agent_runs", "cancellation_requested")
    op.drop_column("agent_runs", "lease_id")
    op.drop_column("agent_runs", "task")
