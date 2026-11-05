"""Keep the tool steps of an AI answer so the chat still shows them after a reload."""
from alembic import op
from sqlalchemy import JSON, Column, inspect

revision = '0043_ai_message_steps'
down_revision = '0042_mail_html_body'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if 'steps_json' not in {item['name'] for item in inspect(op.get_bind()).get_columns('ai_messages')}:
        op.add_column('ai_messages', Column('steps_json', JSON(), nullable=False, server_default='[]'))


def downgrade() -> None:
    with op.batch_alter_table('ai_messages') as batch:
        batch.drop_column('steps_json')
