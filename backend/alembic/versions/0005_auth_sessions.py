"""persist hashed rotating refresh sessions"""
from alembic import op
import sqlalchemy as sa
revision="0005_auth_sessions"
down_revision="0004_ai_provider_secrets"
branch_labels=None
depends_on=None
def upgrade():
    op.create_table("auth_sessions",
        sa.Column("id",sa.String(length=36),primary_key=True),
        sa.Column("owner_id",sa.String(length=36),sa.ForeignKey("users.id"),nullable=False),
        sa.Column("device_id",sa.String(length=36),sa.ForeignKey("devices.id")),
        sa.Column("refresh_token_hash",sa.String(length=64),nullable=False),
        sa.Column("expires_at",sa.DateTime(timezone=True),nullable=False),
        sa.Column("revoked_at",sa.DateTime(timezone=True)),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_auth_sessions_owner_id","auth_sessions",["owner_id"])
    op.create_index("ix_auth_sessions_refresh_token_hash","auth_sessions",["refresh_token_hash"],unique=True)
def downgrade():
    op.drop_index("ix_auth_sessions_refresh_token_hash",table_name="auth_sessions")
    op.drop_index("ix_auth_sessions_owner_id",table_name="auth_sessions")
    op.drop_table("auth_sessions")
