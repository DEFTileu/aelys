"""bind mounted AI runs to their prompt and request payload"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0013_ai_run_request_binding"
down_revision = "0012_device_sync_cursors"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in inspect(bind).get_columns("ai_runs")}
    if "prompt_message_id" not in columns:
        op.add_column("ai_runs", sa.Column("prompt_message_id", sa.String(length=36), nullable=True))
    if "request_fingerprint" not in columns:
        op.add_column("ai_runs", sa.Column("request_fingerprint", sa.String(length=64), nullable=True))
    if "tool_scope_json" not in columns:
        op.add_column("ai_runs", sa.Column("tool_scope_json", sa.JSON(), nullable=False, server_default=sa.text("{}")))


def downgrade() -> None:
    bind = op.get_bind()
    columns = {column["name"] for column in inspect(bind).get_columns("ai_runs")}
    if "request_fingerprint" in columns:
        op.drop_column("ai_runs", "request_fingerprint")
    if "tool_scope_json" in columns:
        op.drop_column("ai_runs", "tool_scope_json")
    if "prompt_message_id" in columns:
        op.drop_column("ai_runs", "prompt_message_id")
