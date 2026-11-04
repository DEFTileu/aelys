"""Both already-deployed migration branches converge without losing owner data."""

import pytest
import sqlalchemy as sa
from test_clean_migrations import run_alembic


@pytest.mark.parametrize(
    "starting_revision", ["0035_knowledge_consent", "0036_telegram_reply_media"]
)
def test_upgrade_from_either_branch_keeps_consent_and_telegram_data(
    tmp_path, starting_revision
):
    filename = tmp_path / "merged.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", starting_revision)
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        with engine.begin() as db:
            # The legacy bootstrap uses current metadata. Remove the other
            # branch's future fields to reproduce an actual deployed schema.
            if starting_revision == "0035_knowledge_consent":
                db.execute(sa.text("DROP TABLE telegram_chat_sends"))
                db.execute(sa.text("ALTER TABLE telegram_business_messages DROP COLUMN media_metadata"))
                db.execute(sa.text("ALTER TABLE telegram_business_messages DROP COLUMN reply_to_telegram_message_id"))
            else:
                db.execute(sa.text("ALTER TABLE notes DROP COLUMN knowledge_enabled"))
            db.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES ('owner', CURRENT_TIMESTAMP, '{}')"))
            fields = "id, owner_id, version, created_at, updated_at, title, markdown_body, tags, pinned"
            values = "'note', 'owner', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'Existing', 'private body', '[]', 0"
            if starting_revision == "0035_knowledge_consent":
                fields += ", knowledge_enabled"
                values += ", 1"
            db.execute(sa.text(f"INSERT INTO notes ({fields}) VALUES ({values})"))
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        with engine.connect() as db:
            assert db.execute(sa.text("SELECT version_num FROM alembic_version")).scalars().all() == ["0041_calendar_browser_handoff"]
            note = db.execute(sa.text("SELECT title, markdown_body, version, knowledge_enabled FROM notes WHERE id='note'")).one()
            assert tuple(note) == ("Existing", "private body", 7, int(starting_revision == "0035_knowledge_consent"))
        inspector = sa.inspect(engine)
        assert inspector.has_table("telegram_chat_sends")
        columns = {column["name"] for column in inspector.get_columns("telegram_business_messages")}
        assert {"media_metadata", "reply_to_telegram_message_id"} <= columns
    finally:
        engine.dispose()
