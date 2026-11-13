"""Store the verified Telegram owner display name encrypted at rest."""

import sqlalchemy as sa
from alembic import op

revision = "0052_telegram_owner_identity"
down_revision = "0051_companion_v11"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "telegram_integrations" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("telegram_integrations")}
    if "owner_name" not in columns:
        op.add_column("telegram_integrations", sa.Column("owner_name", sa.Text(), nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "telegram_integrations" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("telegram_integrations")}
    if "owner_name" in columns:
        op.drop_column("telegram_integrations", "owner_name")
