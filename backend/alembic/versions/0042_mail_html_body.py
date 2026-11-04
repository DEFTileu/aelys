"""Retain bounded HTML alternatives for isolated mail reading."""
from alembic import op
from sqlalchemy import Column, Text, inspect

revision = '0042_mail_html_body'
down_revision = '0041_calendar_browser_handoff'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if 'body_html' not in {item['name'] for item in inspect(op.get_bind()).get_columns('mail_messages')}:
        op.add_column('mail_messages', Column('body_html', Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('mail_messages') as batch:
        batch.drop_column('body_html')
