"""Persist encrypted Telegram command session context and references."""

import sqlalchemy as sa
from alembic import op

revision = "0054_telegram_command_sessions"
down_revision = "0053_telegram_business_commands"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "telegram_business_commands" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("telegram_business_commands")}
    if "session_id" not in columns:
        op.add_column("telegram_business_commands", sa.Column("session_id", sa.String(length=36), nullable=True))
    if "answer" not in columns:
        op.add_column("telegram_business_commands", sa.Column("answer", sa.Text(), nullable=True))
    if "knowledge_refs" not in columns:
        op.add_column(
            "telegram_business_commands",
            sa.Column("knowledge_refs", sa.JSON(), server_default=sa.text("'[]'"), nullable=False),
        )

    indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("telegram_business_commands")}
    if "ix_telegram_business_commands_session_id" not in indexes:
        op.create_index(
            "ix_telegram_business_commands_session_id",
            "telegram_business_commands",
            ["session_id"],
            unique=False,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "telegram_business_commands" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("telegram_business_commands")}
    indexes = {index["name"] for index in inspector.get_indexes("telegram_business_commands")}
    if "ix_telegram_business_commands_session_id" in indexes:
        op.drop_index("ix_telegram_business_commands_session_id", table_name="telegram_business_commands")
    for name in ("knowledge_refs", "answer", "session_id"):
        if name in columns:
            op.drop_column("telegram_business_commands", name)
