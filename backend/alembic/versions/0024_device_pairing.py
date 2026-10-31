"""Add setup tokens, device login challenges and QR pairing sessions."""
import sqlalchemy as sa
from alembic import op

revision = "0024_device_pairing"
down_revision = "0023_note_organization"
branch_labels = None
depends_on = None


def upgrade() -> None:
    existing = set(sa.inspect(op.get_bind()).get_table_names())
    if "setup_tokens" not in existing:
        op.create_table(
            "setup_tokens",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("token_hash", sa.String(64), nullable=False),
            sa.Column("purpose", sa.String(16), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("consumed_at", sa.DateTime(timezone=True)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_setup_tokens_token_hash", "setup_tokens", ["token_hash"], unique=True)
    if "device_challenges" not in existing:
        op.create_table(
            "device_challenges",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("device_id", sa.String(36), sa.ForeignKey("devices.id"), nullable=False),
            sa.Column("nonce", sa.String(64), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used_at", sa.DateTime(timezone=True)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_device_challenges_device_id", "device_challenges", ["device_id"])
    if "pairing_sessions" not in existing:
        op.create_table(
            "pairing_sessions",
            sa.Column("id", sa.String(36), primary_key=True),
            sa.Column("kind", sa.String(10), nullable=False),
            sa.Column("state", sa.String(12), nullable=False),
            sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id")),
            sa.Column("created_by_device_id", sa.String(36), sa.ForeignKey("devices.id")),
            sa.Column("secret_hash", sa.String(64), nullable=False),
            sa.Column("platform", sa.String(20)),
            sa.Column("display_name", sa.String(200)),
            sa.Column("public_key", sa.String(255)),
            sa.Column("failed_attempts", sa.Integer, nullable=False, server_default="0"),
            sa.Column("device_id", sa.String(36)),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("approved_at", sa.DateTime(timezone=True)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_pairing_sessions_owner_id", "pairing_sessions", ["owner_id"])


def downgrade() -> None:
    op.drop_table("pairing_sessions")
    op.drop_table("device_challenges")
    op.drop_table("setup_tokens")
