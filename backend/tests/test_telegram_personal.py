"""Owner-only commands, durable ingestion, status and sync-gap evidence."""
from datetime import UTC, datetime

import pytest
from app.ai.errors import PolicyDenied
from app.core.models import NoteRevision
from app.integrations import telegram_personal
from app.integrations import telegram_service as service
from app.integrations.telegram_models import TelegramIntegration, TelegramUpdateReceipt
from app.integrations.telegram_transport import TelegramError
from sqlalchemy import select
from test_telegram_business import OWNER, connect, set_bound

pytest_plugins = ("test_telegram_business",)


def ordinary(update_id=1, text='/task Title\nDetails', **patch):
    data = {'text': text, 'from': {'id': OWNER, 'is_bot': False},
            'chat': {'id': OWNER, 'type': 'private'}}
    data.update(patch)
    return {'update_id': update_id, 'message': data}


async def bound(setup):
    client, sessions, fake = setup
    item = await connect(client)
    await set_bound(sessions, item['id'])
    return client, sessions, fake, item['id']


@pytest.mark.parametrize('patch', [
    {'from': {'id': 999}}, {'chat': {'id': OWNER, 'type': 'group'}},
    {'from': {'id': OWNER, 'is_bot': True}}, {'forward_origin': {'type': 'user'}},
    {'forward_from': {'id': 5}}, {'chat': {'id': 555, 'type': 'private'}},
])
async def test_untrusted_messages_are_silent(setup, patch):
    client, _, fake, integration_id = await bound(setup)
    fake.updates = [ordinary(**patch)]
    await service.poll_once(integration_id, timeout=0)
    assert (await client.get('/api/v1/tasks')).json() == []
    assert not fake.sent


async def test_capture_commits_before_confirmation_replay_and_revision(setup, monkeypatch):
    client, sessions, fake, integration_id = await bound(setup)
    original = fake.send_message
    async def send(self, chat_id, content, **kwargs):
        async with sessions() as db:
            assert await db.get(TelegramUpdateReceipt, (integration_id, 1))
        assert len((await client.get('/api/v1/tasks')).json()) == 1
        return await original(self, chat_id, content, **kwargs)
    monkeypatch.setattr(fake, 'send_message', send)
    fake.updates = [ordinary()]
    assert await service.poll_once(integration_id, timeout=0) == 1
    assert await service.poll_once(integration_id, timeout=0) == 0
    task = (await client.get('/api/v1/tasks')).json()[0]
    assert (task['title'], task['description']) == ('Title', 'Details')
    assert len(fake.sent) == 1 and fake.sent[0][0] == OWNER and fake.sent[0][2] == {}
    fake.updates = [ordinary(2, '/note@aelys_test_bot Note\nBody')]
    await service.poll_once(integration_id, timeout=0)
    note = (await client.get('/api/v1/notes')).json()[0]
    async with sessions() as db:
        revision = (await db.execute(select(NoteRevision).where(NoteRevision.note_id == note['id']))).scalar_one()
        assert (revision.revision_no, revision.body) == (1, 'Note\nBody')
    # Telegram and REST capture now commit the shared change-log with the object.
    device = (await client.post('/api/v1/devices/enroll', json={'platform': 'web', 'display_name': 'pull-test'})).json()
    client.headers['Authorization'] = 'Bearer ' + device['access_token']
    rest_task = await client.post('/api/v1/tasks', json={'title': 'REST gap comparison'})
    assert rest_task.status_code == 200
    pull_response = await client.get('/api/v1/sync/pull')
    assert pull_response.status_code == 200, pull_response.text
    pull = pull_response.json()
    assert {row['resource_id'] for row in pull['changes']} == {task['id'], note['id'], rest_task.json()['id']}
    assert all(row['version'] == 1 for row in pull['changes'])


async def test_confirmation_failure_keeps_write_and_polling_alive(setup):
    client, _, fake, integration_id = await bound(setup)
    fake.send_error = TelegramError('timeout')
    fake.updates = [ordinary(), ordinary(2, '/help')]
    assert await service.poll_once(integration_id, timeout=0) == 2
    assert len((await client.get('/api/v1/tasks')).json()) == 1
    assert await service.poll_once(integration_id, timeout=0) == 0
    assert len(fake.sent) == 2


async def test_expected_failures_advance_cursor_and_use_savepoint(setup, monkeypatch):
    client, sessions, fake, integration_id = await bound(setup)
    fake.updates = [ordinary(1, '/task ' + 'x' * 301)]
    assert await service.poll_once(integration_id, timeout=0) == 1
    assert '300' in fake.sent[-1][1]
    original_authorize = telegram_personal.ServerPolicyEngine.authorize
    def deny(self, descriptor, call, context):
        if descriptor.required_scope != "tasks.write":
            return original_authorize(self, descriptor, call, context)
        raise PolicyDenied('private policy detail')
    monkeypatch.setattr(telegram_personal.ServerPolicyEngine, 'authorize', deny)
    fake.updates = [ordinary(2)]
    assert await service.poll_once(integration_id, timeout=0) == 1
    assert 'private policy detail' not in fake.sent[-1][1]
    assert 'запрещено' in fake.sent[-1][1]
    assert (await client.get('/api/v1/tasks')).json() == []
    async with sessions() as db:
        assert (await db.get(TelegramIntegration, integration_id)).last_update_id == 2


async def test_busy_free_addressed_commands_and_help(setup):
    _, sessions, _, integration_id = await bound(setup)
    at = datetime(2026, 11, 1, 14, tzinfo=UTC)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        item.timezone = 'Asia/Almaty'
        assert await telegram_personal.handle_owner_message(db, item, '/task@otherbot nope', at) is None
        assert '/help' in await telegram_personal.handle_owner_message(db, item, 'hello', at)
        for bad in ['/busy', '/busy 25:00 bad', '/busy 18:00 ' + 'x' * 201]:
            assert '/busy 18:00' in await telegram_personal.handle_owner_message(db, item, bad, at)
        await telegram_personal.handle_owner_message(db, item, '/busy 18:00 занят', at)
        assert item.status_text == 'занят'
        assert item.status_until == datetime(2026, 11, 2, 13, tzinfo=UTC)
        await telegram_personal.handle_owner_message(db, item, '/free', at)
        assert item.status_text is None and item.status_until is None


async def test_failed_partial_capture_savepoint_does_not_block_following_update(setup, monkeypatch):
    from app.domains import capture
    from fastapi import HTTPException
    client, sessions, fake, integration_id = await bound(setup)
    original = capture.create_task
    async def fail_after_flush(*args, **kwargs):
        await original(*args, **kwargs)
        raise HTTPException(422, detail={'code': 'VALIDATION_ERROR'})
    monkeypatch.setattr(capture, 'create_task', fail_after_flush)
    fake.updates = [ordinary(), ordinary(2, '/note still works')]
    assert await service.poll_once(integration_id, timeout=0) == 2
    assert (await client.get('/api/v1/tasks')).json() == []
    assert len((await client.get('/api/v1/notes')).json()) == 1
    assert len(fake.sent) == 2
    async with sessions() as db:
        assert (await db.get(TelegramIntegration, integration_id)).last_update_id == 2


async def test_today_uses_configured_timezone_and_read_policy(setup, monkeypatch):
    _, sessions, _, integration_id = await bound(setup)
    seen = []
    original = telegram_personal.ServerPolicyEngine.authorize
    def authorize(self, descriptor, call, context):
        seen.append(descriptor.required_scope)
        return original(self, descriptor, call, context)
    monkeypatch.setattr(telegram_personal.ServerPolicyEngine, 'authorize', authorize)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        item.timezone = 'Asia/Almaty'
        result = await telegram_personal.handle_owner_message(db, item, '/today', datetime(2026, 11, 1, 20, tzinfo=UTC))
        assert result.startswith('2026-11-02 · Asia/Almaty')
        assert seen == ['tasks.read']


@pytest.mark.parametrize('at,expected', [
    (datetime(2026, 3, 8, 6, tzinfo=UTC), datetime(2026, 3, 9, 6, 30, tzinfo=UTC)),
    (datetime(2026, 11, 1, 5, 45, tzinfo=UTC), datetime(2026, 11, 1, 6, 30, tzinfo=UTC)),
])
async def test_busy_uses_next_real_wall_clock_occurrence_across_dst(setup, at, expected):
    _, sessions, _, integration_id = await bound(setup)
    clock = '02:30' if at.month == 3 else '01:30'
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        item.timezone = 'America/New_York'
        await telegram_personal.handle_owner_message(db, item, f'/busy {clock} занят', at)
        assert item.status_until == expected
        assert '/help' in await telegram_personal.handle_owner_message(db, item, 'hello@example', at)
