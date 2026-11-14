"""Add source metadata and expiry to proposed AI actions."""

import sqlalchemy as sa
from alembic import op

revision = "0055_ai_action_sources"
down_revision = "0054_telegram_command_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "ai_actions" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("ai_actions")}
    additions = (
        sa.Column("source_kind", sa.String(length=40), nullable=True),
        sa.Column("source_id", sa.String(length=36), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    for column in additions:
        if column.name not in columns:
            op.add_column("ai_actions", column)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "ai_actions" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("ai_actions")}
    for name in ("expires_at", "source_id", "source_kind"):
        if name in columns:
            op.drop_column("ai_actions", name)
