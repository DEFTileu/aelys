"""Add note pinning and mail read state for the desktop widgets."""
import sqlalchemy as sa
from alembic import op

revision = "0027_note_pinned_mail_read"
down_revision = "0026_agent_session_display"
branch_labels = None
depends_on = None


def _missing(table: str, column: str) -> bool:
    return column not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if _missing("notes", "pinned"):
        op.add_column("notes", sa.Column("pinned", sa.Boolean(), nullable=False, server_default=sa.false()))
    if _missing("mail_messages", "is_read"):
        op.add_column("mail_messages", sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("mail_messages") as batch:
        batch.drop_column("is_read")
    with op.batch_alter_table("notes") as batch:
        batch.drop_column("pinned")
