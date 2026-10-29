"""initial Aelys schema"""
from alembic import op
from app.core.db import Base
from app.core import models  # noqa
revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None
def upgrade():
    bind = op.get_bind()
    for table in Base.metadata.sorted_tables:
        if table.name not in {"project_grants", "ai_provider_secrets", "auth_sessions", "sync_compaction_watermarks", "device_sync_cursors"}:
            table.create(bind=bind, checkfirst=True)
def downgrade():
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        if table.name not in {"project_grants", "ai_provider_secrets", "auth_sessions", "sync_compaction_watermarks", "device_sync_cursors"}:
            table.drop(bind=bind, checkfirst=True)
