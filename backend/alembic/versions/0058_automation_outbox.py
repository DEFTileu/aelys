"""Persist committed automation events until delivery."""

import sqlalchemy as sa
from alembic import op

revision = "0058_automation_outbox"
down_revision = "0057_automation_event_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("automation_outbox"):
        return
    op.create_table(
        "automation_outbox",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(80), nullable=False),
        sa.Column("event_id", sa.String(100), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.UniqueConstraint("owner_id", "kind", "event_id", name="uq_automation_outbox_event"),
    )
    op.create_index("ix_automation_outbox_due", "automation_outbox", ["available_at", "created_at", "id"])


def downgrade() -> None:
    op.drop_index("ix_automation_outbox_due", table_name="automation_outbox")
    op.drop_table("automation_outbox")
