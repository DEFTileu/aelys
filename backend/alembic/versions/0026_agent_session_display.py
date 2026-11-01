"""Add non-secret display metadata to the agent session index."""
import sqlalchemy as sa
from alembic import op

revision = "0026_agent_session_display"
down_revision = "0025_focus_pause"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("agent_session_index")}
    if "workspace_path" not in columns:
        op.add_column("agent_session_index", sa.Column("workspace_path", sa.String(500), nullable=True))
    if "sandbox" not in columns:
        op.add_column("agent_session_index", sa.Column("sandbox", sa.String(80), nullable=True))
    if "network" not in columns:
        op.add_column("agent_session_index", sa.Column("network", sa.String(20), nullable=True))
    if "events" not in columns:
        op.add_column("agent_session_index", sa.Column("events", sa.JSON(), nullable=False, server_default="[]"))


def downgrade() -> None:
    with op.batch_alter_table("agent_session_index") as batch:
        batch.drop_column("events")
        batch.drop_column("network")
        batch.drop_column("sandbox")
        batch.drop_column("workspace_path")
