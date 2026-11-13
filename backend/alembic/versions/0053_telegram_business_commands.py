"""Durable encrypted ask/search jobs issued by the Business account owner."""
import sqlalchemy as sa
from alembic import op

revision = "0053_telegram_business_commands"
down_revision = "0052_telegram_owner_identity"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "telegram_business_commands" not in sa.inspect(op.get_bind()).get_table_names():
        from app.integrations.telegram_models import TelegramBusinessCommand
        TelegramBusinessCommand.__table__.create(bind=op.get_bind())


def downgrade() -> None:
    if "telegram_business_commands" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("telegram_business_commands")
