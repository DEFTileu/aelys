"""Authenticated owner memory API over real encrypted SQLite persistence."""
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from app.ai import memory
from app.ai.errors import PolicyDenied
from app.ai.memory_api import router
from app.ai.memory_models import OwnerMemoryFact
from app.core import db as database
from app.core.api import router as core_router
from app.core.db import Base
from app.core.models import AuthSession, User
from app.core.security import create_token
from fastapi import FastAPI
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def setup(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/memory-api.db')
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(database, 'SessionLocal', sessions)
    app = FastAPI()
    app.include_router(core_router, prefix='/api/v1')
    app.include_router(router, prefix='/api/v1')
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/v1/auth/bootstrap', json={
                'email': 'memory-owner@example.test', 'password': 'synthetic memory password'})
            assert response.status_code == 200, response.text
            client.headers['Authorization'] = 'Bearer ' + response.json()['access_token']
            async with sessions() as session:
                owner = (await session.execute(select(User.id))).scalar_one()
                other = User(id='other', email='memory-other@example.test')
                session.add(other)
                auth = AuthSession(owner_id=other.id, refresh_token_hash='other-auth',
                                   expires_at=datetime.now(UTC) + timedelta(hours=1))
                session.add(auth)
                await session.flush()
                other_token = create_token(other.id, 'access', 3600, session_id=auth.id)
                await session.commit()
            yield client, sessions, owner, other_token
    finally:
        await engine.dispose()


async def test_memory_round_trip_encryption_provenance_and_stale_mutations(setup):
    client, sessions, owner, _ = setup
    expires = datetime.now(UTC) + timedelta(days=3)
    created = await client.post('/api/v1/ai/memory', json={
        'text': 'Prefer quiet mornings', 'kind': 'preference', 'expires_at': expires.isoformat()})
    assert created.status_code == 200, created.text
    fact = created.json()
    assert fact['owner_id'] == owner and fact['version'] == 1 and fact['source'] == 'api'
    assert fact['source_message_id'] is None and fact['created_at'] and fact['updated_at']
    assert 'normalized_hash' not in fact
    assert created.headers['cache-control'] == 'no-store'
    async with sessions() as session:
        raw = (await session.execute(text('SELECT text FROM owner_memory_facts WHERE id=:id'), {'id': fact['id']})).scalar_one()
        assert 'Prefer quiet mornings' not in raw
    path = '/api/v1/ai/memory/' + fact['id']
    changed = await client.patch(path, json={'version': 1, 'text': 'Prefer calm mornings'})
    assert changed.status_code == 200, changed.text
    updated = changed.json()
    assert updated['version'] == 2 and updated['kind'] == 'preference'
    assert datetime.fromisoformat(updated['expires_at']) == expires
    stale = await client.patch(path, json={'version': 1, 'text': 'Stale overwrite', 'kind': 'goal'})
    assert stale.status_code == 409 and stale.json()['detail']['code'] == 'VERSION_CONFLICT'
    stale_delete = await client.delete(path, params={'version': 1})
    assert stale_delete.status_code == 409 and stale_delete.json()['detail']['code'] == 'VERSION_CONFLICT'
    listed = await client.get('/api/v1/ai/memory')
    assert listed.json() == [updated]
    cleared = await client.patch(path, json={'version': 2, 'expires_at': None})
    assert cleared.status_code == 200 and cleared.json()['expires_at'] is None
    deleted = await client.delete(path, params={'version': 3})
    assert deleted.status_code == 200 and deleted.json() == {'deleted': True}
    assert (await client.get('/api/v1/ai/memory')).json() == []
    async with sessions() as session:
        item = await session.get(OwnerMemoryFact, fact['id'])
        assert item.deleted_at is not None and item.version == 4
        assert item.text == 'Prefer calm mornings'


async def test_expired_reads_and_owner_isolation(setup):
    client, sessions, owner, other_token = setup
    async with sessions() as session:
        live = await memory.remember(session, owner, 'Current owner context', kind='context')
        expired = await memory.remember(session, owner, 'Expired context', kind='context')
        expired.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await memory.remember(session, 'other', 'Foreign private memory')
        await session.commit()
        live_id = live.id
    listed = await client.get('/api/v1/ai/memory')
    assert [row['text'] for row in listed.json()] == ['Current owner context']
    client.headers['Authorization'] = 'Bearer ' + other_token
    foreign_update = await client.patch('/api/v1/ai/memory/' + live_id,
                                       json={'version': 1, 'text': 'Cross owner edit'})
    assert foreign_update.status_code == 404 and foreign_update.json()['detail']['code'] == 'NOT_FOUND'
    foreign_delete = await client.delete('/api/v1/ai/memory/' + live_id, params={'version': 1})
    assert foreign_delete.status_code == 404 and foreign_delete.json()['detail']['code'] == 'NOT_FOUND'
    assert [row['text'] for row in (await client.get('/api/v1/ai/memory')).json()] == ['Foreign private memory']
    client.headers.pop('Authorization')
    assert (await client.get('/api/v1/ai/memory')).status_code == 401


@pytest.mark.parametrize('payload', [
    {'text': ''}, {'text': ' '}, {'text': 'x' * 2001},
    {'text': 'Fact', 'kind': 'system'}, {'text': 'Fact', 'source': 'telegram_owner'},
    {'text': 'Fact', 'source_message_id': 'forged'}, {'text': 'Fact', 'owner_id': 'other'},
])
async def test_input_bounds_and_provenance_cannot_be_forged(setup, payload):
    client, _, _, _ = setup
    response = await client.post('/api/v1/ai/memory', json=payload)
    assert response.status_code == 422 and response.json()['detail']['code'] == 'VALIDATION_ERROR'
    assert payload.get('text', '') not in response.text if payload.get('text', '').strip() else True


async def test_versions_required_and_query_bounded(setup):
    client, _, _, _ = setup
    fact = (await client.post('/api/v1/ai/memory', json={'text': 'Versioned fact'})).json()
    path = '/api/v1/ai/memory/' + fact['id']
    for version in [None, 0, True, '1']:
        body = {'text': 'Changed'} if version is None else {'version': version, 'text': 'Changed'}
        response = await client.patch(path, json=body)
        assert response.status_code == 422 and response.json()['detail']['code'] == 'VALIDATION_ERROR'
    assert (await client.delete(path)).status_code == 422
    for params in [{'limit': 0}, {'limit': 101}, {'query': 'x' * 201}]:
        response = await client.get('/api/v1/ai/memory', params=params)
        assert response.status_code == 422 and response.json()['detail']['code'] == 'VALIDATION_ERROR'


async def test_policy_denial_is_typed_and_does_not_persist(setup, monkeypatch):
    from app.ai.policy import ServerPolicyEngine
    client, sessions, _, _ = setup

    def deny(self, descriptor, call, context):
        raise PolicyDenied('private policy details')

    monkeypatch.setattr(ServerPolicyEngine, 'authorize', deny)
    response = await client.post('/api/v1/ai/memory', json={'text': 'Private fact'})
    assert response.status_code == 403 and response.json()['detail']['code'] == 'POLICY_DENIED'
    assert 'private policy details' not in response.text
    async with sessions() as session:
        assert not list((await session.execute(select(OwnerMemoryFact))).scalars())


async def test_edit_rejects_an_update_between_patch_merge_and_service_lock(setup, monkeypatch):
    from sqlalchemy import update
    client, sessions, owner, _ = setup
    created = (await client.post('/api/v1/ai/memory', json={'text': 'Original fact'})).json()
    original_update = memory.update_fact
    intervened = False

    async def race(db, owner_id, fact_id, version, **values):
        nonlocal intervened
        if not intervened:
            intervened = True
            async with sessions() as concurrent:
                await concurrent.execute(update(OwnerMemoryFact).where(OwnerMemoryFact.id == fact_id).values(
                    text='Concurrent owner fact', version=2,
                    normalized_hash=memory.normalized_memory_hash(owner, 'Concurrent owner fact')))
                await concurrent.commit()
        return await original_update(db, owner_id, fact_id, version, **values)

    monkeypatch.setattr(memory, 'update_fact', race)
    response = await client.patch('/api/v1/ai/memory/' + created['id'],
                                  json={'version': 1, 'kind': 'goal'})
    assert response.status_code == 409 and response.json()['detail']['code'] == 'VERSION_CONFLICT'
    listed = (await client.get('/api/v1/ai/memory')).json()
    assert len(listed) == 1
    assert listed[0]['text'] == 'Concurrent owner fact' and listed[0]['kind'] == 'fact' and listed[0]['version'] == 2


async def test_api_duplicate_memory_is_owner_deduplicated_and_searchable(setup):
    client, _, _, _ = setup
    original = (await client.post('/api/v1/ai/memory', json={'text': 'Prefer quiet mornings', 'kind': 'preference'})).json()
    replay = await client.post('/api/v1/ai/memory', json={'text': '  PREFER quiet mornings  ', 'kind': 'preference'})
    assert replay.status_code == 200 and replay.json()['id'] == original['id']
    assert replay.json()['version'] == original['version']
    await client.post('/api/v1/ai/memory', json={'text': 'A different goal', 'kind': 'goal'})
    matched = await client.get('/api/v1/ai/memory', params={'query': 'quiet'})
    assert [row['id'] for row in matched.json()] == [original['id']]
