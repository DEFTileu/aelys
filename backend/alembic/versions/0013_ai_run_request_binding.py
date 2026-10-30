"""bind mounted AI runs to their prompt and request payload"""

import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

revision = "0013_ai_run_request_binding"
down_revision = "0012_device_sync_cursors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in inspect(bind).get_columns("ai_runs")}
    conversation_columns = {column["name"] for column in inspect(bind).get_columns("ai_conversations")}
    if "tool_scope_json" not in conversation_columns:
        default = sa.text("'{}'::json") if bind.dialect.name == "postgresql" else sa.text("'{}'")
        op.add_column("ai_conversations", sa.Column("tool_scope_json", sa.JSON(), nullable=False, server_default=default))
    if "prompt_message_id" not in columns:
        op.add_column("ai_runs", sa.Column("prompt_message_id", sa.String(length=36), nullable=True))
    if "request_fingerprint" not in columns:
        op.add_column("ai_runs", sa.Column("request_fingerprint", sa.String(length=64), nullable=True))
    if "tool_scope_json" not in columns:
        default = sa.text("'{}'::json") if bind.dialect.name == "postgresql" else sa.text("'{}'")
        op.add_column("ai_runs", sa.Column("tool_scope_json", sa.JSON(), nullable=False, server_default=default))
    if "provider_id" not in columns:
        op.add_column("ai_runs", sa.Column("provider_id", sa.String(length=36), nullable=True))
    op.execute(sa.text("""
        UPDATE ai_runs
        SET prompt_message_id = (
            SELECT m.id FROM ai_messages AS m
            WHERE m.conversation_id = ai_runs.conversation_id AND m.role = 'user'
            ORDER BY m.created_at DESC LIMIT 1
        )
        WHERE prompt_message_id IS NULL
    """))
    op.execute(sa.text("""
        UPDATE ai_runs
        SET provider_id = (
            SELECT p.id FROM ai_providers AS p
            WHERE p.owner_id = ai_runs.owner_id AND p.kind = ai_runs.provider
            ORDER BY p.created_at LIMIT 1
        )
        WHERE provider_id IS NULL
    """))
    if bind.dialect.name == "postgresql":
        existing = {
            (tuple(fk["constrained_columns"]), fk["referred_table"], tuple(fk["referred_columns"]))
            for fk in inspect(bind).get_foreign_keys("ai_runs")
        }
        for name, column, target in (
            ("fk_ai_runs_prompt_message", "prompt_message_id", "ai_messages"),
            ("fk_ai_runs_provider", "provider_id", "ai_providers"),
        ):
            if ((column,), target, ("id",)) not in existing:
                op.create_foreign_key(name, "ai_runs", target, [column], ["id"])


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in inspect(bind).get_columns("ai_runs")}
    if "request_fingerprint" in columns:
        op.drop_column("ai_runs", "request_fingerprint")
    if "tool_scope_json" in columns:
        op.drop_column("ai_runs", "tool_scope_json")
    if "provider_id" in columns:
        if bind.dialect.name == "postgresql" and "fk_ai_runs_provider" in {fk["name"] for fk in inspect(bind).get_foreign_keys("ai_runs")}:
            op.drop_constraint("fk_ai_runs_provider", "ai_runs", type_="foreignkey")
        op.drop_column("ai_runs", "provider_id")
    if "prompt_message_id" in columns:
        if bind.dialect.name == "postgresql" and "fk_ai_runs_prompt_message" in {fk["name"] for fk in inspect(bind).get_foreign_keys("ai_runs")}:
            op.drop_constraint("fk_ai_runs_prompt_message", "ai_runs", type_="foreignkey")
        op.drop_column("ai_runs", "prompt_message_id")
    conversation_columns = {column["name"] for column in inspect(bind).get_columns("ai_conversations")}
    if "tool_scope_json" in conversation_columns:
        op.drop_column("ai_conversations", "tool_scope_json")
