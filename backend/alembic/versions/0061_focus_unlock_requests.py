"""Focus guard: AI unlock requests (history and daily caps)."""
import sqlalchemy as sa
from alembic import op

revision = "0061_focus_unlock_requests"
down_revision = "0060_companion_weather"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The legacy initial revision creates current metadata on a clean install, so the table may already exist.
    if sa.inspect(op.get_bind()).has_table("focus_unlock_requests"):
        return
    op.create_table(
        "focus_unlock_requests",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("owner_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("app_id", sa.String(length=40), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("granted", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("message", sa.Text(), nullable=False, server_default=""),
        sa.Column("ai_run_id", sa.String(length=36), nullable=True),
    )
    op.create_index("ix_focus_unlock_requests_owner_id", "focus_unlock_requests", ["owner_id"])
    op.create_index("ix_focus_unlock_requests_day", "focus_unlock_requests", ["day"])


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("focus_unlock_requests"):
        op.drop_table("focus_unlock_requests")
