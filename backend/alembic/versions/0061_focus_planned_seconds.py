"""Pomodoro length chosen in the app, so the desk board counts down the same session."""
import sqlalchemy as sa
from alembic import op

revision = "0061_focus_planned_seconds"
down_revision = "0060_companion_weather"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 creates current metadata on a clean install, so the column may already exist.
    if "planned_seconds" not in {column["name"] for column in sa.inspect(op.get_bind()).get_columns("focus_sessions")}:
        op.add_column("focus_sessions", sa.Column("planned_seconds", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("focus_sessions") as batch:
        batch.drop_column("planned_seconds")
