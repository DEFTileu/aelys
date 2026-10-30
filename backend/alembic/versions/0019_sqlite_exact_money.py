"""Keep ledger decimals as text on SQLite rather than NUMERIC float affinity."""
from alembic import op
import sqlalchemy as sa

revision = "0019_sqlite_exact_money"
down_revision = "0018_focus_active_owner"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "sqlite":
        return
    for table, column in (("finance_transactions", "amount"), ("finance_budgets", "limit_amount")):
        stored_type = next(item["type"] for item in sa.inspect(connection).get_columns(table) if item["name"] == column)
        if not isinstance(stored_type, sa.String):
            with op.batch_alter_table(table) as batch:
                batch.alter_column(column, existing_type=stored_type, type_=sa.String(40), existing_nullable=False)


def downgrade() -> None:
    # A downgrade must not silently convert exact posted amounts back to floats.
    if op.get_bind().dialect.name == "sqlite":
        raise RuntimeError("Exact SQLite money storage requires forward migration; export before downgrading")
