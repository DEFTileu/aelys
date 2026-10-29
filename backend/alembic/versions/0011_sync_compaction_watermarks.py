"""persist owner-scoped sync compaction boundaries"""

from alembic import op
import sqlalchemy as sa


revision = "0011_sync_compaction_watermarks"
down_revision = "0010_ai_run_idempotency"
branch_labels = None
depends_on = None


def upgrade():
    if not sa.inspect(op.get_bind()).has_table("sync_compaction_watermarks"):
        op.create_table(
            "sync_compaction_watermarks",
            sa.Column("owner_id", sa.String(length=36), sa.ForeignKey("users.id"), primary_key=True),
            sa.Column("watermark", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )


def downgrade():
    if sa.inspect(op.get_bind()).has_table("sync_compaction_watermarks"):
        op.drop_table("sync_compaction_watermarks")
