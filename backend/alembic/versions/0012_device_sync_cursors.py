"""persist device acknowledgement cursors for safe sync compaction"""

from alembic import op
import sqlalchemy as sa


revision = "0012_device_sync_cursors"
down_revision = "0011_sync_compaction_watermarks"
branch_labels = None
depends_on = None


def upgrade():
    if not sa.inspect(op.get_bind()).has_table("device_sync_cursors"):
        op.create_table(
            "device_sync_cursors",
            sa.Column("owner_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("device_id", sa.String(length=36), sa.ForeignKey("devices.id"), nullable=False),
            sa.Column("last_ack_seq", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("owner_id", "device_id"),
        )


def downgrade():
    if sa.inspect(op.get_bind()).has_table("device_sync_cursors"):
        op.drop_table("device_sync_cursors")
