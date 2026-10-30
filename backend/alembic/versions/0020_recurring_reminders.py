"""Persist the next occurrence and reminder offset for recurring calendar events."""
from alembic import op
import sqlalchemy as sa

revision = "0020_recurring_reminders"
down_revision = "0019_sqlite_exact_money"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("calendar_reminders")}
    if "offset_seconds" not in columns:
        op.add_column("calendar_reminders", sa.Column("offset_seconds", sa.Integer(), nullable=True))
    if "occurrence_at" not in columns:
        op.add_column("calendar_reminders", sa.Column("occurrence_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("calendar_reminders") as batch:
        batch.drop_column("occurrence_at")
        batch.drop_column("offset_seconds")
