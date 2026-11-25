"""Legacy empty Focus helper conversations disappear without losing domain history."""
from datetime import UTC, datetime

import sqlalchemy as sa
from app.core.models import AIConversation, AIMessage, AIRun, FocusUnlockRequest, User
from sqlalchemy.orm import Session
from test_clean_migrations import run_alembic


def test_upgrade_hides_only_empty_focus_service_chats(tmp_path):
    filename = tmp_path / 'focus-chats.db'
    url = f'sqlite+aiosqlite:///{filename}'
    run_alembic(url, 'upgrade', '0064_telegram_guest_jobs')
    engine = sa.create_engine(f'sqlite:///{filename}')
    try:
        with Session(engine) as db:
            db.add(User(id='owner', email='test@example.com'))
            db.flush()
            db.add_all([
                AIConversation(id='service', owner_id='owner', title='FocusUnlock', pinned=True),
                AIConversation(id='user', owner_id='owner', title='FocusUnlock'),
                AIConversation(id='empty', owner_id='owner', title='My empty chat'),
                AIConversation(id='deleted', owner_id='owner', title='FocusUnlock', deleted_at=datetime(2020, 1, 1, tzinfo=UTC)),
            ])
            db.flush()
            db.add(AIMessage(id='message', conversation_id='user', role='user', content='Keep this'))
            db.add(AIRun(id='run', owner_id='owner', conversation_id='service', provider='claude', model='m', status='completed', token_counts={'input': 3, 'output': 4}))
            db.add(FocusUnlockRequest(id='request', owner_id='owner', day=datetime.now(UTC).date(), app_id='yt', reason='urgent work call', granted=True, minutes=5, message='ok', ai_run_id='run'))
            db.commit()
        run_alembic(url, 'upgrade', 'head')
        run_alembic(url, 'check')
        with Session(engine) as db:
            assert db.get(AIConversation, 'service').deleted_at is not None
            assert db.get(AIConversation, 'service').version == 2
            assert db.get(AIConversation, 'user').deleted_at is None
            assert db.get(AIConversation, 'empty').deleted_at is None
            assert db.get(AIConversation, 'deleted').version == 1
            assert db.get(AIConversation, 'deleted').deleted_at.year == 2020
            assert db.get(AIMessage, 'message').content == 'Keep this'
            assert db.get(AIRun, 'run').token_counts == {'input': 3, 'output': 4}
            request = db.get(FocusUnlockRequest, 'request')
            assert (request.reason, request.message, request.ai_run_id) == ('urgent work call', 'ok', 'run')
        run_alembic(url, 'downgrade', '0064_telegram_guest_jobs')
        run_alembic(url, 'upgrade', 'head')
        with Session(engine) as db:
            assert db.get(AIConversation, 'service').version == 2
    finally:
        engine.dispose()
