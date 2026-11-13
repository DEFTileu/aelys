"""Add signed firmware releases and board core dumps."""
import sqlalchemy as sa
from alembic import op

revision = "0051_companion_firmware"
down_revision = "0050_companion"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "companion_firmware" not in existing:
        op.create_table(
            "companion_firmware",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("version", sa.String(11), nullable=False),
            sa.Column("min_version", sa.String(11), nullable=False),
            sa.Column("sha256", sa.String(64), nullable=False),
            sa.Column("size", sa.Integer, nullable=False),
            sa.Column("data", sa.LargeBinary, nullable=False),
            sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("owner_id", "version"),
        )
        op.create_index("ix_companion_firmware_owner_id", "companion_firmware", ["owner_id"])
    if "companion_coredumps" not in existing:
        op.create_table(
            "companion_coredumps",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
            sa.Column("fw_version", sa.String(11), nullable=False),
            sa.Column("elf_sha256", sa.String(64)),
            sa.Column("sha256", sa.String(64), nullable=False),
            sa.Column("size", sa.Integer, nullable=False),
            sa.Column("data", sa.LargeBinary, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("device_id", "sha256"),
        )
        op.create_index("ix_companion_coredumps_owner_id", "companion_coredumps", ["owner_id"])
        op.create_index("ix_companion_coredumps_device_id", "companion_coredumps", ["device_id"])


def downgrade() -> None:
    op.drop_table("companion_coredumps")
    op.drop_table("companion_firmware")
