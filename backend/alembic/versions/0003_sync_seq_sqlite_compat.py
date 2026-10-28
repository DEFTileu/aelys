"""normalize sync sequence type for SQLite test and local stores"""
from alembic import op
import sqlalchemy as sa
revision = "0003_sync_seq_sqlite_compat"
down_revision = "0002_project_grants"
branch_labels = None
depends_on = None
def upgrade():
    with op.batch_alter_table("sync_changes") as batch:
        batch.alter_column("seq", existing_type=sa.BigInteger(), type_=sa.Integer(), existing_nullable=False)
def downgrade():
    with op.batch_alter_table("sync_changes") as batch:
        batch.alter_column("seq", existing_type=sa.Integer(), type_=sa.BigInteger(), existing_nullable=False)
