"""Explicit encrypted owner facts, separate from Business conversation data."""
from alembic import op
from sqlalchemy import inspect

revision = '0032_owner_memory'
down_revision = '0031_telegram_ephemeral_media'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if 'owner_memory_facts' not in inspect(op.get_bind()).get_table_names():
        from app.ai.memory_models import OwnerMemoryFact
        OwnerMemoryFact.__table__.create(bind=op.get_bind())


def downgrade() -> None:
    op.drop_table('owner_memory_facts')
