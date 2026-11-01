"""Join deployed Knowledge and Telegram migrations without rewriting either."""

revision = "0037_merge_telegram_knowledge"
down_revision = ("0036_telegram_reply_media", "0035_knowledge_consent")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
