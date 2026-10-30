"""Add Telegram Business integration persistence."""
from alembic import op
import sqlalchemy as sa

revision = "0022_telegram_business"
down_revision = "0021_sqlite_ai_run_foreign_keys"
branch_labels = None
depends_on = None


def owned_columns():
    return (
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )


def upgrade() -> None:
    # Revision 0001 creates current metadata on fresh databases, so these tables
    # can already exist when the entire migration chain is run from scratch.
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "telegram_integrations" not in existing:
        op.create_table(
            "telegram_integrations", *owned_columns(),
            sa.Column("encrypted_token", sa.Text(), nullable=True),
            sa.Column("bot_id", sa.BigInteger(), nullable=False),
            sa.Column("bot_username", sa.String(64), nullable=False),
            sa.Column("bot_name", sa.String(200), nullable=False),
            sa.Column("business_capable", sa.Boolean(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("auto_reply", sa.Boolean(), nullable=False),
            sa.Column("instructions", sa.Text(), nullable=False),
            sa.Column("provider_id", sa.String(36), sa.ForeignKey("ai_providers.id"), nullable=True),
            sa.Column("model", sa.String(200), nullable=True),
            sa.Column("owner_telegram_id", sa.BigInteger(), nullable=True),
            sa.Column("binding_code_hash", sa.String(64), nullable=True),
            sa.Column("binding_expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_update_id", sa.BigInteger(), nullable=False),
            sa.Column("lease_owner", sa.String(64), nullable=True),
            sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_polled_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_error_code", sa.String(80), nullable=True),
            sa.UniqueConstraint("owner_id", name="uq_telegram_integrations_owner_id"),
        )
        op.create_index("ix_telegram_integrations_owner_id", "telegram_integrations", ["owner_id"])
    if "telegram_business_connections" not in existing:
        op.create_table(
            "telegram_business_connections",
            sa.Column("id", sa.String(256), primary_key=True),
            sa.Column("integration_id", sa.String(36), sa.ForeignKey("telegram_integrations.id"), nullable=False),
            sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("telegram_user_id", sa.BigInteger(), nullable=False),
            sa.Column("user_chat_id", sa.BigInteger(), nullable=False),
            sa.Column("enabled", sa.Boolean(), nullable=False),
            sa.Column("rights", sa.JSON(), nullable=False),
            sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
    if "telegram_business_messages" not in existing:
        op.create_table(
            "telegram_business_messages", *owned_columns(),
            sa.Column("integration_id", sa.String(36), sa.ForeignKey("telegram_integrations.id"), nullable=False),
            sa.Column("business_connection_id", sa.String(256), sa.ForeignKey("telegram_business_connections.id"), nullable=False),
            sa.Column("chat_id", sa.BigInteger(), nullable=False),
            sa.Column("telegram_message_id", sa.BigInteger(), nullable=False),
            sa.Column("sender_id", sa.BigInteger(), nullable=True),
            sa.Column("chat_title", sa.Text(), nullable=False),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("sent_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("direction", sa.String(16), nullable=False),
            sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("draft_text", sa.Text(), nullable=True),
            sa.Column("draft_status", sa.String(24), nullable=False),
            sa.Column("draft_error_code", sa.String(80), nullable=True),
            sa.Column("reply_message_id", sa.BigInteger(), nullable=True),
            sa.UniqueConstraint("integration_id", "business_connection_id", "chat_id", "telegram_message_id", name="uq_telegram_business_message_remote"),
        )
        op.create_index("ix_telegram_business_messages_owner_id", "telegram_business_messages", ["owner_id"])
    if "telegram_update_receipts" not in existing:
        op.create_table(
            "telegram_update_receipts",
            sa.Column("integration_id", sa.String(36), sa.ForeignKey("telegram_integrations.id"), primary_key=True),
            sa.Column("update_id", sa.BigInteger(), primary_key=True),
            sa.Column("processed_at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("telegram_update_receipts")
    op.drop_index("ix_telegram_business_messages_owner_id", table_name="telegram_business_messages")
    op.drop_table("telegram_business_messages")
    op.drop_table("telegram_business_connections")
    op.drop_index("ix_telegram_integrations_owner_id", table_name="telegram_integrations")
    op.drop_table("telegram_integrations")
