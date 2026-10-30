"""Store note folders and tags without changing note hierarchy."""
import sqlalchemy as sa
from alembic import op

revision = "0023_note_organization"
down_revision = "0022_telegram_business"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("notes")}
    if "folder" not in columns:
        op.add_column("notes", sa.Column("folder", sa.String(120), nullable=True))
    if "tags" not in columns:
        op.add_column("notes", sa.Column("tags", sa.JSON(), nullable=False, server_default="[]"))


def downgrade() -> None:
    with op.batch_alter_table("notes") as batch:
        batch.drop_column("tags")
        batch.drop_column("folder")
