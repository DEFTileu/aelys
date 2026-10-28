"""add encrypted provider secret envelopes"""
from alembic import op
import sqlalchemy as sa
revision="0004_ai_provider_secrets"
down_revision="0003_sync_seq_sqlite_compat"
branch_labels=None
depends_on=None
def upgrade():
    op.create_table("ai_provider_secrets",
        sa.Column("provider_id",sa.String(length=36),sa.ForeignKey("ai_providers.id"),primary_key=True),
        sa.Column("owner_id",sa.String(length=36),sa.ForeignKey("users.id"),nullable=False),
        sa.Column("encrypted_value",sa.Text(),nullable=False),
        sa.Column("key_version",sa.Integer(),nullable=False,server_default="1"),
        sa.Column("updated_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_ai_provider_secrets_owner_id","ai_provider_secrets",["owner_id"])
def downgrade():
    op.drop_index("ix_ai_provider_secrets_owner_id",table_name="ai_provider_secrets")
    op.drop_table("ai_provider_secrets")
