"""add explicit project/device autonomy grants"""
from alembic import op
import sqlalchemy as sa
revision = "0002_project_grants"
down_revision = "0001_initial"
branch_labels = None
depends_on = None
def upgrade():
    op.create_table(
        "project_grants",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("owner_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("device_id", sa.String(length=36), sa.ForeignKey("devices.id"), nullable=False),
        sa.Column("policy_id", sa.String(length=36), nullable=False),
        sa.Column("isolation_validated", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("network_allowed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("owner_id", "project_id", "device_id", name="uq_project_grant"),
    )
    op.create_index("ix_project_grants_owner_id", "project_grants", ["owner_id"])
def downgrade():
    op.drop_index("ix_project_grants_owner_id", table_name="project_grants")
    op.drop_table("project_grants")
