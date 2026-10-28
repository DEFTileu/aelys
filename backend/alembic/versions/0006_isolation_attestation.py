"""add project isolation attestation challenge state"""
from alembic import op
import sqlalchemy as sa
revision="0006_isolation_attestation"
down_revision="0005_auth_sessions"
branch_labels=None
depends_on=None
def upgrade():
    op.add_column("project_grants",sa.Column("isolation_nonce",sa.String(length=100)))
    op.add_column("project_grants",sa.Column("isolation_validated_at",sa.DateTime(timezone=True)))
def downgrade():
    op.drop_column("project_grants","isolation_validated_at")
    op.drop_column("project_grants","isolation_nonce")
