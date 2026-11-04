"""Bind Calendar native handoff to a one-use system-browser start."""
from alembic import op
from sqlalchemy import Column, String, inspect

revision = "0041_calendar_browser_handoff"
down_revision = "0040_gmail_browser_handoff"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "browser_state" not in {item["name"] for item in inspect(op.get_bind()).get_columns("google_calendar_oauth_states")}:
        op.add_column("google_calendar_oauth_states", Column("browser_state", String(16), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("google_calendar_oauth_states") as batch:
        batch.drop_column("browser_state")
