"""Independent, content-free idempotency receipts for manual chat messages."""

import sqlalchemy as sa
from alembic import op

revision = "0035_telegram_chat_sends"
down_revision = "0034_google_calendar"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "telegram_chat_sends" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "telegram_chat_sends",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column(
                "owner_id",
                sa.String(36),
                sa.ForeignKey("users.id"),
                nullable=False,
                index=True,
            ),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "integration_id",
                sa.String(36),
                sa.ForeignKey("telegram_integrations.id"),
                nullable=False,
            ),
            sa.Column(
                "business_connection_id",
                sa.String(256),
                sa.ForeignKey("telegram_business_connections.id"),
                nullable=False,
            ),
            sa.Column("chat_id", sa.BigInteger(), nullable=False),
            sa.Column("idempotency_key", sa.String(150), nullable=False),
            sa.Column("request_hash", sa.String(64), nullable=False),
            sa.Column("send_status", sa.String(24), nullable=False),
            sa.Column("error_code", sa.String(80), nullable=True),
            sa.Column(
                "message_id",
                sa.String(36),
                sa.ForeignKey("telegram_business_messages.id", ondelete="SET NULL"),
                nullable=True,
            ),
            sa.UniqueConstraint(
                "owner_id", "idempotency_key", name="uq_telegram_chat_send_key"
            ),
        )


def downgrade() -> None:
    op.drop_table("telegram_chat_sends")
