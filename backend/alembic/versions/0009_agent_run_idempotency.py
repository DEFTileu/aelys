"""add a durable owner-scoped idempotency key for agent runs"""
from alembic import op
import sqlalchemy as sa

revision = "0009_agent_run_idempotency"
down_revision = "0008_auth_index_compat"
branch_labels = None
depends_on = None

def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("agent_runs")}
    indexes = {index["name"] for index in inspector.get_indexes("agent_runs")}
    if "idempotency_key" not in columns:
        op.add_column("agent_runs", sa.Column("idempotency_key", sa.String(length=150), nullable=True))
    if "ix_agent_run_owner_idempotency" not in indexes:
        op.create_index("ix_agent_run_owner_idempotency", "agent_runs", ["owner_id", "idempotency_key"], unique=True)

def downgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "ix_agent_run_owner_idempotency" in {index["name"] for index in inspector.get_indexes("agent_runs")}:
        op.drop_index("ix_agent_run_owner_idempotency", table_name="agent_runs")
    if "idempotency_key" in {column["name"] for column in inspector.get_columns("agent_runs")}:
        op.drop_column("agent_runs", "idempotency_key")
