"""Add the companion action ledger and per-device board state."""
import sqlalchemy as sa
from alembic import op

revision = "0050_companion"
down_revision = "0049_ai_image_attachments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "companion_actions" not in existing:
        op.create_table(
            "companion_actions",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
            sa.Column("kind", sa.String(40), nullable=False),
            sa.Column("result_json", sa.JSON, nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("device_id", "id", name="uq_companion_actions_device_id_id"),
        )
        op.create_index("ix_companion_actions_owner_id", "companion_actions", ["owner_id"])
    if "companion_state" not in existing:
        op.create_table(
            "companion_state",
            sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), primary_key=True),
            sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("fw_version", sa.String(40)),
            sa.Column("board", sa.String(60)),
            sa.Column("last_hello_at", sa.DateTime(timezone=True)),
            sa.Column("last_metrics_json", sa.JSON),
            sa.Column("lost_mode_json", sa.JSON),
            sa.Column("ice_json", sa.JSON),
            sa.Column("pending_commands_json", sa.JSON, nullable=False),
            sa.Column("last_wifi_scan_json", sa.JSON),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_companion_state_owner_id", "companion_state", ["owner_id"])


def downgrade() -> None:
    op.drop_table("companion_state")
    op.drop_table("companion_actions")
