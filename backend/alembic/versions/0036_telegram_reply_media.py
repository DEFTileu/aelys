"""Optional Business reply reference and encrypted media metadata; never bytes."""

import sqlalchemy as sa
from alembic import op

revision = "0036_telegram_reply_media"
down_revision = "0035_telegram_chat_sends"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns(
            "telegram_business_messages"
        )
    }
    for column in [
        sa.Column("reply_to_telegram_message_id", sa.BigInteger(), nullable=True),
        sa.Column("media_metadata", sa.Text(), nullable=True),
    ]:
        if column.name not in columns:
            op.add_column("telegram_business_messages", column)


def downgrade() -> None:
    with op.batch_alter_table("telegram_business_messages") as batch:
        batch.drop_column("media_metadata")
        batch.drop_column("reply_to_telegram_message_id")
