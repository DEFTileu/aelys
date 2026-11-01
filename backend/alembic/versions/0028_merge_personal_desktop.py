"""Join Telegram personal and desktop data migration branches."""

revision = "0028_merge_personal_desktop"
down_revision = ("0025_telegram_personal", "0027_note_pinned_mail_read")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
