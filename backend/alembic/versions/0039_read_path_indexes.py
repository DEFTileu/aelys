"""Index project filtering and owner-scoped chronological reads."""
import sqlalchemy as sa
from alembic import op

revision = "0039_read_path_indexes"
down_revision = "0038_ai_chat_design"
branch_labels = None
depends_on = None

INDEXES = (
    ("ix_tasks_owner_project_live", "tasks", ["owner_id", "project_id"], True),
    ("ix_finance_owner_occurred_live", "finance_transactions", ["owner_id", "occurred_at"], True),
    ("ix_mail_owner_received_live", "mail_messages", ["owner_id", "received_at"], True),
    ("ix_activity_owner_occurred", "activity_events", ["owner_id", "occurred_at"], False),
    ("ix_history_owner_created", "history_entries", ["owner_id", "created_at"], False),
    ("ix_notifications_owner_created_live", "notifications", ["owner_id", "created_at"], True),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for name, table, columns, live in INDEXES:
        # 0001 uses current metadata on clean installations; existing installs
        # reach this revision without the new indexes.
        if name not in {index["name"] for index in inspector.get_indexes(table)}:
            predicate = sa.text("deleted_at IS NULL")
            options = {"sqlite_where": predicate, "postgresql_where": predicate} if live else {}
            op.create_index(name, table, columns, **options)


def downgrade() -> None:
    for name, table, _columns, _live in reversed(INDEXES):
        op.drop_index(name, table_name=table)
