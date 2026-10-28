"""add durable idempotency for mounted AI runs"""
from alembic import op
import sqlalchemy as sa

revision = "0010_ai_run_idempotency"
down_revision = "0009_agent_run_idempotency"
branch_labels = None
depends_on = None

def upgrade():
    bind=op.get_bind(); columns={x["name"] for x in sa.inspect(bind).get_columns("ai_runs")}; indexes={x["name"] for x in sa.inspect(bind).get_indexes("ai_runs")}
    if "idempotency_key" not in columns: op.add_column("ai_runs",sa.Column("idempotency_key",sa.String(length=150),nullable=True))
    if "ix_ai_run_owner_idempotency" not in indexes: op.create_index("ix_ai_run_owner_idempotency","ai_runs",["owner_id","idempotency_key"],unique=True)

def downgrade():
    op.drop_index("ix_ai_run_owner_idempotency",table_name="ai_runs")
    op.drop_column("ai_runs","idempotency_key")
