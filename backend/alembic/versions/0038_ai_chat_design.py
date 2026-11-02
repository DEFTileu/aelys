"""AI Chat: pinned conversations, message feedback/attachments, pending actions, attachments."""
import sqlalchemy as sa
from alembic import op

revision = "0038_ai_chat_design"
down_revision = "0037_merge_telegram_knowledge"
branch_labels = None
depends_on = None


def _owned() -> list[sa.Column]:
    return [
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    ]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    conversation_columns = {c["name"] for c in inspector.get_columns("ai_conversations")}
    if "pinned" not in conversation_columns:
        op.add_column("ai_conversations", sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()))
    message_columns = {c["name"] for c in inspector.get_columns("ai_messages")}
    if "feedback" not in message_columns:
        op.add_column("ai_messages", sa.Column("feedback", sa.String(4), nullable=True))
    if "attachments_json" not in message_columns:
        op.add_column("ai_messages", sa.Column("attachments_json", sa.JSON(), nullable=False, server_default="[]"))
    tables = set(inspector.get_table_names())
    if "ai_actions" not in tables:
        op.create_table(
            "ai_actions", *_owned(),
            sa.Column("conversation_id", sa.String(36), sa.ForeignKey("ai_conversations.id"), nullable=False, index=True),
            sa.Column("run_id", sa.String(36), sa.ForeignKey("ai_runs.id"), nullable=False, index=True),
            sa.Column("message_id", sa.String(36), nullable=True),
            sa.Column("tool", sa.String(80), nullable=False),
            sa.Column("arguments_json", sa.JSON(), nullable=False),
            sa.Column("title", sa.String(300), nullable=False),
            sa.Column("summary", sa.Text(), nullable=False),
            sa.Column("items_json", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("result_json", sa.JSON(), nullable=False),
        )
    if "ai_attachments" not in tables:
        op.create_table(
            "ai_attachments", *_owned(),
            sa.Column("name", sa.String(200), nullable=False),
            sa.Column("size", sa.Integer(), nullable=False),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("ai_attachments")
    op.drop_table("ai_actions")
    with op.batch_alter_table("ai_messages") as batch:
        batch.drop_column("attachments_json")
        batch.drop_column("feedback")
    with op.batch_alter_table("ai_conversations") as batch:
        batch.drop_column("pinned")
