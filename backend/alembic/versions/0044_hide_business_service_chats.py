"""Hide business reply service chats that AI Chat listed before they were created hidden."""
from alembic import op

revision = '0044_hide_business_service_chats'
down_revision = '0043_ai_message_steps'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE ai_conversations SET deleted_at = CURRENT_TIMESTAMP, version = version + 1 "
        "WHERE title = 'TelegramBusiness' AND deleted_at IS NULL "
        "AND id NOT IN (SELECT conversation_id FROM ai_messages WHERE conversation_id IS NOT NULL)"
    )


def downgrade() -> None:
    pass
