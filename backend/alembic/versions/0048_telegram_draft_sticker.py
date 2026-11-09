"""Telegram Business draft sticker: the chosen sticker reference for review and send."""
from alembic import op
from sqlalchemy import Column, Inspector, Text, inspect

revision = '0048_telegram_draft_sticker'
down_revision = '0047_english_course'
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector: Inspector = inspect(op.get_bind())
    if 'draft_sticker' not in {item['name'] for item in inspector.get_columns('telegram_business_messages')}:
        op.add_column('telegram_business_messages', Column('draft_sticker', Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('telegram_business_messages') as batch:
        batch.drop_column('draft_sticker')
