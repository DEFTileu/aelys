"""Add reminders attached to calendar events."""
from alembic import op
from sqlalchemy import inspect
from app.core.models import CalendarReminder

revision = "0017_calendar_reminders"
down_revision = "0016_gmail_connection"
branch_labels = None
depends_on = None

def upgrade() -> None:
    bind = op.get_bind()
    if CalendarReminder.__table__.name not in inspect(bind).get_table_names():
        CalendarReminder.__table__.create(bind)

def downgrade() -> None:
    op.drop_table(CalendarReminder.__table__.name)
