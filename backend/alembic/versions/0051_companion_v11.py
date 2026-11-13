"""Companion protocol v1.1: board contacts, Wi-Fi state, settings and the command log."""
import sqlalchemy as sa
from alembic import op

revision = "0051_companion_v11"
down_revision = "0050_companion"
branch_labels = None
depends_on = None

COLUMNS = ("contacts_json", "wifi_json", "settings_json", "command_log_json")


def upgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("companion_state")}
    for name in COLUMNS:
        if name not in existing:
            op.add_column("companion_state", sa.Column(name, sa.JSON))


def downgrade() -> None:
    existing = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("companion_state")}
    with op.batch_alter_table("companion_state") as batch:
        for name in COLUMNS:
            if name in existing:
                batch.drop_column(name)
