"""add atomic finance transfer linkage"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0015_finance_transfer_integrity"
down_revision = "0014_ai_run_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in inspect(bind).get_columns("finance_transactions")}
    if "related_transfer_id" not in columns:
        op.add_column(
            "finance_transactions",
            sa.Column("related_transfer_id", sa.String(length=36), nullable=True),
        )
    indexes = {index["name"] for index in inspect(bind).get_indexes("finance_transactions")}
    if "ix_finance_transactions_related_transfer_id" not in indexes:
        op.create_index(
            "ix_finance_transactions_related_transfer_id",
            "finance_transactions",
            ["related_transfer_id"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    indexes = {index["name"] for index in inspect(bind).get_indexes("finance_transactions")}
    if "ix_finance_transactions_related_transfer_id" in indexes:
        op.drop_index("ix_finance_transactions_related_transfer_id", table_name="finance_transactions")
    columns = {column["name"] for column in inspect(bind).get_columns("finance_transactions")}
    if "related_transfer_id" in columns:
        op.drop_column("finance_transactions", "related_transfer_id")
