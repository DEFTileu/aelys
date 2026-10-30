"""Repair foreign keys omitted by the legacy SQLite upgrade in revision 0013."""
from alembic import op
import sqlalchemy as sa

revision = "0021_sqlite_ai_run_foreign_keys"
down_revision = "0020_recurring_reminders"
branch_labels = None
depends_on = None

REFERENCES = (("prompt_message_id", "ai_messages", "fk_ai_runs_prompt_message"),
              ("provider_id", "ai_providers", "fk_ai_runs_provider"))


def upgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "sqlite":
        return
    existing = {tuple(item["constrained_columns"]) for item in sa.inspect(connection).get_foreign_keys("ai_runs")}
    missing = [(column, target, name) for column, target, name in REFERENCES if (column,) not in existing]
    for column, target, _ in missing:
        orphan = connection.execute(sa.text(
            f"SELECT 1 FROM ai_runs r LEFT JOIN {target} t ON r.{column}=t.id "
            f"WHERE r.{column} IS NOT NULL AND t.id IS NULL LIMIT 1"
        )).first()
        if orphan:
            raise RuntimeError(f"Resolve orphan ai_runs.{column} references before migrating; no records were deleted")
    if missing:
        with op.batch_alter_table("ai_runs") as batch:
            for column, target, name in missing:
                batch.create_foreign_key(name, target, [column], ["id"])


def downgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "sqlite":
        return
    names = {item["name"] for item in sa.inspect(connection).get_foreign_keys("ai_runs")}
    with op.batch_alter_table("ai_runs") as batch:
        for _, _, name in REFERENCES:
            if name in names:
                batch.drop_constraint(name, type_="foreignkey")
