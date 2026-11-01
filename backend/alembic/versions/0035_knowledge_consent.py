"""Explicit knowledge opt-in; existing notes remain private from retrieval."""
import sqlalchemy as sa
from alembic import op

revision = "0035_knowledge_consent"
down_revision = "0034_google_calendar"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("notes")}
    if "knowledge_enabled" not in columns:
        op.add_column("notes", sa.Column("knowledge_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
    if op.get_bind().dialect.name == "postgresql":
        op.execute("CREATE INDEX IF NOT EXISTS ix_notes_knowledge_fts ON notes USING gin (to_tsvector('simple', title || ' ' || markdown_body)) WHERE knowledge_enabled AND deleted_at IS NULL")


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.drop_index("ix_notes_knowledge_fts", table_name="notes")
    with op.batch_alter_table("notes") as batch:
        batch.drop_column("knowledge_enabled")
