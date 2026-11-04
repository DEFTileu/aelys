"""Upgrade/downgrade deployed Gmail state without losing its owner/session binding."""
import sqlalchemy as sa
from test_clean_migrations import run_alembic


def test_gmail_browser_migration_preserves_existing_state(tmp_path):
    filename = tmp_path / "gmail-handoff.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "0039_read_path_indexes")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        with engine.begin() as db:
            # The legacy bootstrap creates current metadata even at old revisions.
            if "browser_state" in {item["name"] for item in sa.inspect(db).get_columns("gmail_oauth_states")}:
                db.execute(sa.text("ALTER TABLE gmail_oauth_states DROP COLUMN browser_state"))
            db.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES ('owner', CURRENT_TIMESTAMP, '{}')"))
            db.execute(sa.text("INSERT INTO auth_sessions (id, owner_id, refresh_token_hash, expires_at, created_at) VALUES ('session', 'owner', 'synthetic-hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"))
            db.execute(sa.text("INSERT INTO gmail_oauth_states (state_hash,owner_id,session_id,encrypted_verifier,expires_at) VALUES ('synthetic-state','owner','session','preserved-ciphertext',CURRENT_TIMESTAMP)"))
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        with engine.connect() as db:
            row = db.execute(sa.text("SELECT owner_id, session_id, encrypted_verifier, browser_state FROM gmail_oauth_states")).one()
            assert row == ("owner", "session", "preserved-ciphertext", None)
        run_alembic(url, "downgrade", "0039_read_path_indexes")
        with engine.connect() as db:
            assert db.scalar(sa.text("SELECT encrypted_verifier FROM gmail_oauth_states")) == "preserved-ciphertext"
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()
