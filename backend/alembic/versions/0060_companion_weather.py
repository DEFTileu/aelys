"""Per-owner weather city (coarse coordinates) and cached forecast for the desk board."""
import sqlalchemy as sa
from alembic import op

revision = "0060_companion_weather"
down_revision = "0059_companion_character"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The legacy initial revision creates current metadata on a clean install, so the table may already exist.
    if sa.inspect(op.get_bind()).has_table("companion_weather"):
        return
    op.create_table(
        "companion_weather",
        sa.Column("owner_id", sa.String(length=36), sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("name", sa.String(length=64), nullable=False),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lon", sa.Float(), nullable=False),
        sa.Column("forecast_json", sa.JSON(), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("companion_weather"):
        op.drop_table("companion_weather")
