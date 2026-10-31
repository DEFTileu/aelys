import pytest
from app.core import db
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
async def test_note_stale_save_does_not_replace_body_or_add_revision(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/notes.db")
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        owner = await client.post('/api/v1/auth/bootstrap', json={'email': 'note-version@example.test', 'password': 'synthetic-note-password'})
        client.headers['Authorization'] = f"Bearer {owner.json()['access_token']}"
        created = (await client.post('/api/v1/notes', json={'title': 'Versioned', 'markdown_body': 'original'})).json()
        path = f"/api/v1/notes/{created['id']}"
        first = await client.patch(path, params={'version': created['version']}, json={'title': 'New title', 'markdown_body': 'server body'})
        assert first.status_code == 200
        assert first.json()['version'] == created['version'] + 1
        conflict = await client.patch(path, params={'version': created['version']}, json={'title': 'Stale title', 'markdown_body': 'draft body'})
        assert conflict.status_code == 409
        assert conflict.json()['detail']['code'] == 'VERSION_CONFLICT'
        assert (await client.get(path)).json() == first.json()
        revisions = (await client.get(path + '/revisions')).json()
        assert [item['body'] for item in revisions] == ['original', 'server body']
        assert (await client.patch(path, params={'version': 0}, json={'title': 'Invalid'})).status_code == 422
        legacy = await client.patch(path, json={'title': 'Compatible', 'markdown_body': 'legacy client'})
        assert legacy.status_code == 200
        assert legacy.json()['version'] == first.json()['version'] + 1
    await engine.dispose()


@pytest.mark.asyncio
async def test_note_organization_is_versioned_and_legacy_updates_preserve_it(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/organization.db")
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        owner = await client.post('/api/v1/auth/bootstrap', json={'email': 'organization@example.test', 'password': 'synthetic-note-password'})
        client.headers['Authorization'] = f"Bearer {owner.json()['access_token']}"
        created = (await client.post('/api/v1/notes', json={'title': 'Note', 'folder': ' Work ', 'tags': ['#design', 'design', 'plan']})).json()
        assert created['folder'] == 'Work' and created['tags'] == ['design', 'plan']
        path = f"/api/v1/notes/{created['id']}"
        legacy = await client.patch(path, params={'version': created['version']}, json={'title': 'Legacy edit', 'markdown_body': 'body'})
        assert legacy.json()['folder'] == 'Work' and legacy.json()['tags'] == ['design', 'plan']
        conflict = await client.patch(path, params={'version': created['version']}, json={'title': 'Stale', 'folder': 'Other', 'tags': []})
        assert conflict.status_code == 409
        assert (await client.get(path)).json() == legacy.json()
        changed = await client.patch(path, params={'version': legacy.json()['version']}, json={'title': 'Legacy edit', 'markdown_body': 'body', 'folder': None, 'tags': []})
        assert changed.json()['folder'] is None and changed.json()['tags'] == []
        assert [revision['body'] for revision in (await client.get(path + '/revisions')).json()] == ['', 'body']
    await engine.dispose()


@pytest.mark.asyncio
async def test_note_responses_expose_the_last_update_instant(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/updated-at.db")
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        owner = await client.post('/api/v1/auth/bootstrap', json={'email': 'note-updated@example.test', 'password': 'synthetic-note-password'})
        client.headers['Authorization'] = f"Bearer {owner.json()['access_token']}"
        created = (await client.post('/api/v1/notes', json={'title': 'Dated', 'markdown_body': 'body'})).json()
        assert created['updated_at']
        listed = (await client.get('/api/v1/notes')).json()
        assert listed[0]['updated_at'] == created['updated_at']
    await engine.dispose()
