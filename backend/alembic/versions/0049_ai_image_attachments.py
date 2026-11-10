"""AI chat image attachments: the image bytes and type, sent to the model as vision input."""
from alembic import op
from sqlalchemy import Column, Inspector, LargeBinary, String, inspect

revision = '0049_ai_image_attachments'
down_revision = '0048_telegram_draft_sticker'
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector: Inspector = inspect(op.get_bind())
    columns = {item['name'] for item in inspector.get_columns('ai_attachments')}
    if 'mime_type' not in columns:
        op.add_column('ai_attachments', Column('mime_type', String(50), nullable=True))
    if 'data' not in columns:
        op.add_column('ai_attachments', Column('data', LargeBinary(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('ai_attachments') as batch:
        batch.drop_column('data')
        batch.drop_column('mime_type')
