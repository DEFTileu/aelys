"""Add owner-enabled Telegram groups and their encrypted message archive."""
import sqlalchemy as sa
from alembic import op

revision = "0067_telegram_groups"
down_revision = "0066_companion_firmware"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The initial revision uses current metadata for some clean installs.
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "telegram_groups" not in existing:
        op.create_table(
            "telegram_groups",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("integration_id", sa.String(36), sa.ForeignKey("telegram_integrations.id"), nullable=False),
            sa.Column("chat_id", sa.BigInteger(), nullable=False),
            sa.Column("conversation_id", sa.String(36), sa.ForeignKey("ai_conversations.id"), nullable=False),
            sa.UniqueConstraint("integration_id", "chat_id", name="uq_telegram_group_chat"),
        )
    if "telegram_group_messages" in existing:
        return
    op.create_table(
        "telegram_group_messages",
        sa.Column("group_id", sa.String(36), sa.ForeignKey("telegram_groups.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("message_id", sa.BigInteger(), primary_key=True),
        sa.Column("thread_id", sa.BigInteger(), nullable=False),
        sa.Column("sender_name", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reply_to_id", sa.BigInteger()),
        sa.Column("reply_state", sa.String(16), nullable=False),
        sa.Column("queued_at", sa.DateTime(timezone=True)),
        sa.Column("claimed_at", sa.DateTime(timezone=True)),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("ai_runs.id")),
    )
    op.create_index("ix_telegram_group_history", "telegram_group_messages", ["group_id", "thread_id", "message_id"])
    op.create_index("ix_telegram_group_pending", "telegram_group_messages", ["group_id", "reply_state", "queued_at"])


def downgrade() -> None:
    op.drop_table("telegram_group_messages")
    op.drop_table("telegram_groups")
