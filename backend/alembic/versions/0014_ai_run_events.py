"""persist redacted AI run events for reconnect and replay"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0014_ai_run_events"
down_revision = "0013_ai_run_request_binding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "ai_run_events" not in inspect(bind).get_table_names():
        op.create_table(
            "ai_run_events",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("run_id", sa.String(length=36), sa.ForeignKey("ai_runs.id"), nullable=False),
            sa.Column("sequence", sa.Integer(), nullable=False),
            sa.Column("event_id", sa.String(length=100), nullable=False),
            sa.Column("event_type", sa.String(length=80), nullable=False),
            sa.Column("payload", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json") if bind.dialect.name == "postgresql" else sa.text("'{}'")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("run_id", "sequence", name="uq_ai_run_event_sequence"),
            sa.UniqueConstraint("run_id", "event_id", name="uq_ai_run_event_id"),
        )
        op.create_index("ix_ai_run_events_run_id", "ai_run_events", ["run_id"])


def downgrade() -> None:
    bind = op.get_bind()
    if "ai_run_events" in inspect(bind).get_table_names():
        op.drop_index("ix_ai_run_events_run_id", table_name="ai_run_events")
        op.drop_table("ai_run_events")
