"""Enforce one active focus session per owner under concurrent device starts."""
from alembic import op
import sqlalchemy as sa

revision = "0018_focus_active_owner"
down_revision = "0017_calendar_reminders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    if "uq_focus_active_owner" not in {index["name"] for index in sa.inspect(connection).get_indexes("focus_sessions")}:
        # Existing duplicates require explicit owner resolution, never deletion.
        op.create_index("uq_focus_active_owner", "focus_sessions", ["owner_id"], unique=True,
                        sqlite_where=sa.text("status = 'active' AND deleted_at IS NULL"),
                        postgresql_where=sa.text("status = 'active' AND deleted_at IS NULL"))


def downgrade() -> None:
    op.drop_index("uq_focus_active_owner", table_name="focus_sessions")
