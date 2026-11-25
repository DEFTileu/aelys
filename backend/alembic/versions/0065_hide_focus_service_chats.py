"""Hide legacy empty Focus unlock helper conversations; retain runs and request history."""
from alembic import op

revision = "0065_hide_focus_service_chats"
down_revision = "0064_telegram_guest_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE ai_conversations SET deleted_at = CURRENT_TIMESTAMP, "
        "updated_at = CURRENT_TIMESTAMP, version = version + 1 "
        "WHERE title = 'FocusUnlock' AND deleted_at IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM ai_messages "
        "WHERE ai_messages.conversation_id = ai_conversations.id)"
    )


def downgrade() -> None:
    # Cannot distinguish migrated helpers from conversations the owner deleted.
    pass
