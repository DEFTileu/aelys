"""remove the duplicate refresh-token unique constraint on PostgreSQL"""
from alembic import op
import sqlalchemy as sa

revision = "0008_auth_index_compat"
down_revision = "0007_agent_run_task"
branch_labels = None
depends_on = None

def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    inspector = sa.inspect(bind)
    for constraint in inspector.get_unique_constraints("auth_sessions"):
        if constraint.get("column_names") == ["refresh_token_hash"]:
            op.drop_constraint(constraint["name"], "auth_sessions", type_="unique")

def downgrade():
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.create_unique_constraint("uq_auth_sessions_refresh_token_hash", "auth_sessions", ["refresh_token_hash"])
