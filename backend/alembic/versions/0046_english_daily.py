"""English daily words (Leitner review) and corrected daily reports."""
from alembic import op
from sqlalchemy import inspect

revision = "0046_english_daily"
down_revision = "0045_ai_conversation_idempotency"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0001 creates current metadata on fresh installs, so these may already exist.
    from app.core.models import EnglishProfile, EnglishReport, EnglishWord
    bind = op.get_bind()
    existing = set(inspect(bind).get_table_names())
    for model in (EnglishWord, EnglishReport, EnglishProfile):
        if model.__tablename__ not in existing:
            model.__table__.create(bind=bind)


def downgrade() -> None:
    op.drop_table("english_profiles")
    op.drop_table("english_reports")
    op.drop_table("english_words")
