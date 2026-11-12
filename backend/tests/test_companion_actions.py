import uuid

import pytest_asyncio
from app.ai.errors import PolicyDenied
from app.ai.policy import ServerPolicyEngine
from app.core import db
from app.core.models import Notification
from app.main import app
from companion_helpers import B, bearer, claim_owner, companion_token, pair_companion
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/actions.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http
    await engine.dispose()


async def board(client):
    owner, key, device_id = await pair_companion(client)
    token = await companion_token(client, key, device_id)
    owner_id = (await client.get(f'{B}/me', headers=bearer(owner))).json()['id']
    return owner_id, {'Authorization': f'Bearer {token}'}


async def add_notification(owner_id):
    async with db.SessionLocal() as session:
        item = Notification(owner_id=owner_id, kind='task.due', title='Pay rent')
        session.add(item)
        await session.commit()
        return item.id


async def read_at(item_id):
    async with db.SessionLocal() as session:
        return (await session.get(Notification, item_id)).read_at


def action(kind='notification.read', **payload):
    return {'id': str(uuid.uuid4()), 'kind': kind, 'payload': payload}


async def test_read_notification_action_marks_read(client):
    owner_id, headers = await board(client)
    item_id = await add_notification(owner_id)
    body = action(notification_id=item_id)
    response = await client.post(f'{B}/companion/actions', headers=headers, json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {'id': body['id'], 'ok': True, 'error_code': None}
    assert await read_at(item_id) is not None


async def test_same_action_id_replays_result_without_second_effect(client):
    owner_id, headers = await board(client)
    item_id = await add_notification(owner_id)
    body = action(notification_id=item_id)
    first = await client.post(f'{B}/companion/actions', headers=headers, json=body)
    async with db.SessionLocal() as session:
        (await session.get(Notification, item_id)).read_at = None
        await session.commit()
    second = await client.post(f'{B}/companion/actions', headers=headers, json=body)
    assert second.json() == first.json()
    assert await read_at(item_id) is None, 'the replay must not run the effect again'
    from app.companion.models import CompanionAction
    async with db.SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(CompanionAction)) == 1


async def test_unknown_kind_returns_action_unknown(client):
    _, headers = await board(client)
    body = action('does.not.exist')
    response = await client.post(f'{B}/companion/actions', headers=headers, json=body)
    assert response.json() == {'id': body['id'], 'ok': False, 'error_code': 'ACTION_UNKNOWN'}


async def test_action_of_other_owner_notification_is_not_found(client):
    _, headers = await board(client)
    async with db.SessionLocal() as session:
        from app.core.models import User
        other = User(email='other@example.com')
        session.add(other)
        await session.commit()
        other_id = other.id
    item_id = await add_notification(other_id)
    response = await client.post(f'{B}/companion/actions', headers=headers, json=action(notification_id=item_id))
    assert response.json()['error_code'] == 'NOT_FOUND' and response.json()['ok'] is False
    assert await read_at(item_id) is None


async def test_policy_denied_maps_to_error_code(client, monkeypatch):
    owner_id, headers = await board(client)
    item_id = await add_notification(owner_id)

    def deny(self, tool, call, context):
        raise PolicyDenied('no')
    monkeypatch.setattr(ServerPolicyEngine, 'authorize', deny)
    response = await client.post(f'{B}/companion/actions', headers=headers, json=action(notification_id=item_id))
    assert response.json()['error_code'] == 'POLICY_DENIED' and response.json()['ok'] is False
    assert await read_at(item_id) is None


async def test_invalid_action_body_is_a_validation_error(client):
    _, headers = await board(client)
    assert (await client.post(f'{B}/companion/actions', headers=headers, json={'id': 'nope', 'kind': 'x', 'payload': {}})).status_code == 422
    assert (await client.post(f'{B}/companion/actions', headers=headers, json={'id': str(uuid.uuid4()), 'kind': 'x', 'payload': []})).status_code == 422


async def test_owner_session_cannot_post_actions(client):
    _, owner = await claim_owner(client)
    response = await client.post(f'{B}/companion/actions', headers=bearer(owner), json=action())
    assert response.status_code == 403 and response.json()['detail']['code'] == 'COMPANION_ONLY'


async def test_concurrent_first_requests_execute_once(client):
    import asyncio
    owner_id, headers = await board(client)
    item_id = await add_notification(owner_id)
    body = action(notification_id=item_id)
    first, second = await asyncio.gather(*(client.post(f'{B}/companion/actions', headers=headers, json=body) for _ in range(2)))
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() and first.json()['ok'] is True
