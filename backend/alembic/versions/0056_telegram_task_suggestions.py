"""Add opt-in task suggestion settings and per-message processing state."""

import sqlalchemy as sa
from alembic import op

revision = "0056_telegram_task_suggestions"
down_revision = "0055_ai_action_sources"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    if "telegram_integrations" in tables:
        columns = {
            column["name"] for column in inspector.get_columns("telegram_integrations")
        }
        if "task_suggestions_chat_id" not in columns:
            op.add_column(
                "telegram_integrations",
                sa.Column("task_suggestions_chat_id", sa.BigInteger(), nullable=True),
            )
        if "task_suggestions_enabled_at" not in columns:
            op.add_column(
                "telegram_integrations",
                sa.Column(
                    "task_suggestions_enabled_at",
                    sa.DateTime(timezone=True),
                    nullable=True,
                ),
            )

    if "telegram_business_messages" in tables:
        columns = {
            column["name"]
            for column in inspector.get_columns("telegram_business_messages")
        }
        if "task_suggestion_state" not in columns:
            op.add_column(
                "telegram_business_messages",
                sa.Column("task_suggestion_state", sa.String(length=24), nullable=True),
            )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    if "telegram_business_messages" in tables:
        columns = {
            column["name"]
            for column in inspector.get_columns("telegram_business_messages")
        }
        if "task_suggestion_state" in columns:
            op.drop_column("telegram_business_messages", "task_suggestion_state")

    if "telegram_integrations" in tables:
        columns = {
            column["name"] for column in inspector.get_columns("telegram_integrations")
        }
        for name in ("task_suggestions_enabled_at", "task_suggestions_chat_id"):
            if name in columns:
                op.drop_column("telegram_integrations", name)
