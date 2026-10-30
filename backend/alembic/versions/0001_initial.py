"""initial Aelys schema"""
from alembic import op
from app.core import models  # noqa
from app.core.db import Base

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None
# Created in revision 0016, after auth_sessions exists in revision 0005.
# The legacy initial revision otherwise creates tables from current metadata.
LATER_TABLES = {"project_grants", "ai_provider_secrets", "auth_sessions", "sync_compaction_watermarks", "device_sync_cursors", "gmail_oauth_states"}
def upgrade():
    bind = op.get_bind()
    for table in Base.metadata.sorted_tables:
        if table.name not in LATER_TABLES:
            table.create(bind=bind, checkfirst=True)
def downgrade():
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        if table.name not in LATER_TABLES:
            table.drop(bind=bind, checkfirst=True)
