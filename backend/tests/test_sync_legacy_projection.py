"""Upgrade compatibility when historical device records have no domain row."""
import httpx
import pytest
from app.core import db
from app.core.db import Base
from app.core.models import Note, SyncChange, SyncRecord, Task, User
from app.main import app
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def legacy_sync(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/legacy.db')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'SessionLocal', sessions)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/api/v1/auth/bootstrap', json={'email': 'legacy@example.test', 'password': 'correct horse battery staple'})
            client.headers['Authorization'] = 'Bearer ' + response.json()['access_token']
            device = (await client.post('/api/v1/devices/enroll', json={'platform': 'web', 'display_name': 'Legacy'})).json()
            client.headers['Authorization'] = 'Bearer ' + device['access_token']
            async with sessions() as session:
                owner = (await session.execute(select(User.id))).scalar_one()
            yield client, sessions, owner, device['device_id']
    finally:
        await engine.dispose()


async def push(client, device, *, kind='task', action='update', base=3, patch=None):
    return await client.post('/api/v1/sync/push', json={'device_id': device, 'operations': [{
        'device_id': device, 'resource_kind': kind, 'resource_id': 'legacy', 'action': action,
        'base_version': base, 'patch': patch or {},
    }]})


@pytest.mark.parametrize('patch', [{'status': 'done'}, {'title': 'new title'}])
async def test_legacy_projection_update_preserves_other_fields(legacy_sync, patch):
    client, sessions, owner, device = legacy_sync
    async with sessions() as session:
        session.add(SyncRecord(owner_id=owner, resource_kind='task', resource_id='legacy', version=3,
            payload={'title': 'old title', 'description': 'must survive', 'priority': 2}))
        await session.commit()
    response = await push(client, device, patch=patch)
    assert response.status_code == 200, response.text
    assert response.json()['results'][0]['version'] == 4
    async with sessions() as session:
        row = await session.get(Task, 'legacy')
        assert row.description == 'must survive' and row.priority == 2 and row.version == 4
        assert row.title == patch.get('title', 'old title')
        assert row.status == patch.get('status', 'todo')
        changes = list((await session.execute(select(SyncChange))).scalars())
        assert len(changes) == 1 and changes[0].version == 4


async def test_stale_create_does_not_resurrect_tombstone(legacy_sync):
    from app.core.models import now
    client, sessions, owner, device = legacy_sync
    async with sessions() as session:
        session.add(Task(id='legacy', owner_id=owner, title='deleted', version=3, deleted_at=now()))
        session.add(SyncRecord(owner_id=owner, resource_kind='task', resource_id='legacy', version=3, deleted_at=now(), payload={}))
        await session.commit()
    response = await push(client, device, action='create', base=0, patch={'title': 'stale recreate'})
    assert response.status_code == 200
    assert response.json()['results'][0]['status'] == 'conflict'
    async with sessions() as session:
        row = await session.get(Task, 'legacy')
        assert row.deleted_at is not None and row.version == 3
        assert not list((await session.execute(select(SyncChange))).scalars())


async def test_domain_note_conflict_contains_current_server_body_without_projection(legacy_sync):
    client, sessions, owner, device = legacy_sync
    async with sessions() as session:
        session.add(Note(id='legacy', owner_id=owner, title='note', markdown_body='retained server body', version=3))
        await session.commit()
    response = await push(client, device, kind='note', base=2, patch={'markdown_body': 'offline client body'})
    assert response.status_code == 200
    conflict = response.json()['results'][0]['conflict']
    assert conflict['server_version'] == 3
    assert conflict['branches'][0]['payload']['markdown_body'] == 'retained server body'
    assert conflict['branches'][1]['payload']['markdown_body'] == 'offline client body'


async def test_project_status_must_be_typed(legacy_sync):
    client, _, _, device = legacy_sync
    response = await push(client, device, kind='project', action='create', base=0, patch={'name': 'P', 'status': {}})
    assert response.status_code == 422


async def test_legacy_projection_delete_without_domain_row(legacy_sync):
    client, sessions, owner, device = legacy_sync
    async with sessions() as session:
        session.add(SyncRecord(owner_id=owner, resource_kind='task', resource_id='legacy', version=3,
            payload={'title': 'legacy task', 'description': 'before delete'}))
        await session.commit()
    response = await push(client, device, action='delete')
    assert response.status_code == 200, response.text
    assert response.json()['results'][0]['status'] == 'applied'
    pulled = (await client.get('/api/v1/sync/pull')).json()['changes']
    assert len(pulled) == 1 and pulled[0]['operation'] == 'delete' and pulled[0]['version'] == 4
    assert pulled[0]['payload'] == {}


async def test_preexisting_domain_row_is_indexed_on_first_sync(legacy_sync):
    client, sessions, owner, _ = legacy_sync
    async with sessions() as session:
        session.add(Task(id='old-rest', owner_id=owner, title='Before unified log', version=4))
        await session.commit()
    pulled = await client.get('/api/v1/sync/pull')
    assert pulled.status_code == 200, pulled.text
    matches = [row for row in pulled.json()['changes'] if row['resource_id'] == 'old-rest']
    assert len(matches) == 1 and matches[0]['version'] == 4
    assert matches[0]['payload']['title'] == 'Before unified log'
    snapshot = await client.get('/api/v1/sync/bootstrap')
    assert snapshot.status_code == 200
    assert any(row['resource_id'] == 'old-rest' for row in snapshot.json()['resources'])
    await client.get('/api/v1/sync/pull')
    async with sessions() as session:
        assert len(list((await session.execute(select(SyncChange).where(SyncChange.resource_id == 'old-rest'))).scalars())) == 1


@pytest.mark.parametrize('version,title', [(5, 'newer mirror'), (4, 'divergent mirror')])
async def test_preexisting_divergence_fails_closed_without_overwriting(legacy_sync, version, title):
    client, sessions, owner, _ = legacy_sync
    async with sessions() as session:
        session.add(Task(id='ambiguous', owner_id=owner, title='domain title', version=4))
        session.add(SyncRecord(owner_id=owner, resource_kind='task', resource_id='ambiguous',
                               version=version, payload={'title': title}))
        await session.commit()
    response = await client.get('/api/v1/sync/bootstrap')
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'SYNC_RECONCILIATION_REQUIRED'
    async with sessions() as session:
        assert (await session.get(Task, 'ambiguous')).title == 'domain title'
        assert (await session.get(SyncRecord, (owner, 'task', 'ambiguous'))).payload == {'title': title}
        assert not list((await session.execute(select(SyncChange))).scalars())


@pytest.mark.parametrize('tombstone', [False, True])
async def test_write_cannot_hide_equal_version_historical_divergence(legacy_sync, tombstone):
    from app.core.models import now
    client, sessions, owner, device = legacy_sync
    async with sessions() as session:
        session.add(Task(id='legacy', owner_id=owner, title='domain title', version=4))
        session.add(SyncRecord(owner_id=owner, resource_kind='task', resource_id='legacy', version=4,
            payload={} if tombstone else {'title': 'mirror title'}, deleted_at=now() if tombstone else None))
        await session.commit()
    response = await push(client, device, base=4, patch={'priority': 2})
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'SYNC_RECONCILIATION_REQUIRED'
    async with sessions() as session:
        assert (await session.get(Task, 'legacy')).version == 4
        assert (await session.get(SyncRecord, (owner, 'task', 'legacy'))).version == 4
        assert not list((await session.execute(select(SyncChange))).scalars())
