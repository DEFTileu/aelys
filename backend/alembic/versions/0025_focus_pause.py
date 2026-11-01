"""Add focus pause state; a paused session still occupies the owner's single timer slot."""
import sqlalchemy as sa
from alembic import op

revision = "0025_focus_pause"
down_revision = "0024_device_pairing"
branch_labels = None
depends_on = None

_WHERE = sa.text("status IN ('active', 'paused') AND deleted_at IS NULL")
_OLD_WHERE = sa.text("status = 'active' AND deleted_at IS NULL")


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("focus_sessions")}
    if "paused_at" not in columns:
        op.add_column("focus_sessions", sa.Column("paused_at", sa.DateTime(timezone=True), nullable=True))
    if "paused_seconds" not in columns:
        op.add_column("focus_sessions", sa.Column("paused_seconds", sa.Integer(), nullable=False, server_default="0"))
    op.drop_index("uq_focus_active_owner", table_name="focus_sessions")
    op.create_index("uq_focus_active_owner", "focus_sessions", ["owner_id"], unique=True, sqlite_where=_WHERE, postgresql_where=_WHERE)


def downgrade() -> None:
    op.drop_index("uq_focus_active_owner", table_name="focus_sessions")
    op.execute("UPDATE focus_sessions SET status = 'completed', ended_at = COALESCE(paused_at, started_at) WHERE status = 'paused'")
    op.create_index("uq_focus_active_owner", "focus_sessions", ["owner_id"], unique=True, sqlite_where=_OLD_WHERE, postgresql_where=_OLD_WHERE)
    with op.batch_alter_table("focus_sessions") as batch:
        batch.drop_column("paused_seconds")
        batch.drop_column("paused_at")
