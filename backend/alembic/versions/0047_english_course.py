"""IELTS course: profile goals, daily lessons and mock tests."""
import sqlalchemy as sa
from alembic import op

revision = "0047_english_course"
down_revision = "0046_english_daily"
branch_labels = None
depends_on = None

COLUMNS = (
    ("goal", sa.String(24), "ielts_academic"),
    ("target_band", sa.String(4), "6.5"),
    ("level", sa.String(8), "b1b2"),
    ("weak_skills", sa.JSON(), '["speaking", "listening"]'),
    ("minutes_per_day", sa.Integer(), "120"),
)


def upgrade() -> None:
    # 0001 creates current metadata on fresh installs, so these may already exist.
    from app.core.models import EnglishLesson, EnglishMock
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    for model in (EnglishLesson, EnglishMock):
        if model.__tablename__ not in existing:
            model.__table__.create(bind=bind)
    have = {column["name"] for column in sa.inspect(bind).get_columns("english_profiles")}
    for name, kind, default in COLUMNS:
        if name not in have:
            op.add_column("english_profiles", sa.Column(name, kind, nullable=False, server_default=default))
    for name in ("exam_date", "course_started_on"):
        if name not in have:
            op.add_column("english_profiles", sa.Column(name, sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_table("english_mocks")
    op.drop_table("english_lessons")
    with op.batch_alter_table("english_profiles") as batch:
        for name in ("course_started_on", "exam_date", *(c[0] for c in reversed(COLUMNS))):
            batch.drop_column(name)
