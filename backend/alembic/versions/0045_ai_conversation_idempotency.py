"""Bind conversation create keys to their owner and immutable original request."""

import sqlalchemy as sa
from alembic import op

revision = "0045_ai_conversation_idempotency"
down_revision = "0044_hide_business_service_chats"
branch_labels = None
depends_on = None

INDEX = "ix_ai_conversation_owner_idempotency"


def upgrade() -> None:
    # 0001 creates current metadata on fresh installs. Legacy rows intentionally
    # keep NULL keys/fingerprints: their original requests cannot be recovered.
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("ai_conversations")}
    for name, length in (("idempotency_key", 150), ("request_fingerprint", 64)):
        if name not in columns:
            op.add_column(
                "ai_conversations", sa.Column(name, sa.String(length), nullable=True)
            )
    if INDEX not in {
        index["name"] for index in inspector.get_indexes("ai_conversations")
    }:
        op.create_index(
            INDEX, "ai_conversations", ["owner_id", "idempotency_key"], unique=True
        )


def downgrade() -> None:
    op.drop_index(INDEX, table_name="ai_conversations")
    with op.batch_alter_table("ai_conversations") as batch:
        batch.drop_column("request_fingerprint")
        batch.drop_column("idempotency_key")
