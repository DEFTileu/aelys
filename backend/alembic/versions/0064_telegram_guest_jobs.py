"""Add durable queue table for verified owner Telegram Guest Mode invocations."""

import sqlalchemy as sa
from alembic import op

revision = "0064_telegram_guest_jobs"
down_revision = "0063_focus_planned_seconds"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "telegram_guest_jobs" in inspector.get_table_names():
        return

    op.create_table(
        "telegram_guest_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_id", sa.String(length=36), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("integration_id", sa.String(length=36), nullable=False),
        sa.Column("telegram_update_id", sa.BigInteger(), nullable=False),
        sa.Column("guest_query_id_hash", sa.String(length=64), nullable=False),
        sa.Column("guest_query_id", sa.Text(), nullable=True),
        sa.Column("caller_telegram_id", sa.BigInteger(), nullable=False),
        sa.Column("chat_id", sa.BigInteger(), nullable=True),
        sa.Column("telegram_message_id", sa.BigInteger(), nullable=True),
        sa.Column("prompt_text", sa.Text(), nullable=False),
        sa.Column("quote", sa.Text(), nullable=True),
        sa.Column("tools_unlocked", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("state", sa.String(length=24), nullable=False, server_default=sa.text("'queued'")),
        sa.Column("delivery_status", sa.String(length=24), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("conversation_id", sa.String(length=36), nullable=True),
        sa.Column("run_id", sa.String(length=36), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error_code", sa.String(length=80), nullable=True),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["integration_id"], ["telegram_integrations.id"]),
        sa.ForeignKeyConstraint(["conversation_id"], ["ai_conversations.id"]),
        sa.ForeignKeyConstraint(["run_id"], ["ai_runs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("integration_id", "telegram_update_id", name="uq_telegram_guest_job_update"),
        sa.UniqueConstraint("integration_id", "guest_query_id_hash", name="uq_telegram_guest_job_query"),
    )
    op.create_index("ix_telegram_guest_jobs_owner_id", "telegram_guest_jobs", ["owner_id"], unique=False)
    op.create_index("ix_telegram_guest_jobs_integration_id", "telegram_guest_jobs", ["integration_id"], unique=False)
    op.create_index("ix_telegram_guest_jobs_state", "telegram_guest_jobs", ["state"], unique=False)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "telegram_guest_jobs" not in inspector.get_table_names():
        return

    for index_name in (
        "ix_telegram_guest_jobs_state",
        "ix_telegram_guest_jobs_integration_id",
        "ix_telegram_guest_jobs_owner_id",
    ):
        op.drop_index(index_name, table_name="telegram_guest_jobs")
    op.drop_table("telegram_guest_jobs")
