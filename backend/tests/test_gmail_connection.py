import base64
import json
import logging
import time
from urllib.parse import parse_qs, urlparse

import pytest
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.core import db
from app.core.config import get_settings
from app.core.db import Base
from app.core.models import GmailCredential, GmailDraftLink, GmailOAuthState
from app.domains import gmail
from app.main import OAuthAccessLogFilter, app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def gmail_client(tmp_path, monkeypatch):
    monkeypatch.setenv('AELYS_GMAIL_CLIENT_ID', 'test-client-id')
    monkeypatch.setenv('AELYS_GMAIL_CLIENT_SECRET', 'private-client-secret')
    monkeypatch.setenv('AELYS_GMAIL_REDIRECT_URI', 'http://test/api/v1/mail/gmail/callback')
    get_settings.cache_clear()
    # Test host is HTTPS because non-loopback plain HTTP redirects are disallowed.
    monkeypatch.setenv('AELYS_GMAIL_REDIRECT_URI', 'https://test/api/v1/mail/gmail/callback')
    get_settings.cache_clear()
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/gmail.db')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, 'SessionLocal', factory)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='https://test') as client:
        owner = await client.post('/api/v1/auth/bootstrap', json={'email':'owner@test.example','password':'gmail-test-password'})
        client.headers['Authorization'] = f"Bearer {owner.json()['access_token']}"
        yield client, factory
    await engine.dispose()
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_gmail_oauth_read_draft_and_disconnect(gmail_client, monkeypatch):
    client, factory = gmail_client
    calls = []
    async def fake_google(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if url.endswith('/token'):
            assert kwargs['data']['client_secret'] == 'private-client-secret'
            if kwargs['data']['grant_type'] == 'authorization_code':
                assert len(kwargs['data']['code_verifier']) >= 43
                return {'access_token':'google-access-secret','refresh_token':'google-refresh-secret','expires_in':3600,'scope':' '.join(gmail.SCOPES)}
            return {'access_token':'refreshed-access-secret','expires_in':3600}
        if url.endswith('/profile'): return {'emailAddress':'person@example.test'}
        if url.endswith('/messages'):
            assert kwargs['params']['maxResults'] == '25'
            return {'messages':[{'id':'external-1'}], 'nextPageToken':'next-page'}
        if url.endswith('/messages/external-1'):
            return {'threadId':'thread-1','internalDate':'1793264400000','payload':{'mimeType':'text/plain','headers':[{'name':'From','value':'person@example.test'},{'name':'Subject','value':'Gmail message'}],'body':{'data':base64.urlsafe_b64encode(b'Plain body').decode()}}}
        if '/drafts' in url:
            raw = base64.urlsafe_b64decode(kwargs['json']['message']['raw'])
            assert b'My Gmail reply' in raw
            return {'id':'gmail-draft-1'}
        if url.endswith('/revoke'): return {}
        raise AssertionError(url)
    monkeypatch.setattr(gmail, 'google', fake_google)
    start = await client.post('/api/v1/mail/gmail/connect')
    assert start.status_code == 200
    query = parse_qs(urlparse(start.json()['authorization_url']).query)
    state = query['state'][0]
    assert query['code_challenge_method'] == ['S256']
    assert set(query['scope'][0].split()) == gmail.SCOPES
    assert (await client.get('/api/v1/mail/gmail/callback', params={'state':'wrong','code':'code'})).status_code == 400
    callback = await client.get('/api/v1/mail/gmail/callback', params={'state':state,'code':'code'})
    assert callback.status_code == 303
    assert callback.headers['location'] == '/mail?gmail=connected'
    assert (await client.get('/api/v1/mail/gmail/callback', params={'state':state,'code':'code'})).status_code == 400
    accounts = await client.get('/api/v1/mail/accounts')
    assert 'google-access-secret' not in accounts.text and 'google-refresh-secret' not in accounts.text
    account_id = accounts.json()[0]['id']
    async with factory() as session:
        assert (await session.execute(select(GmailOAuthState))).scalars().all() == []
        credential = await session.get(GmailCredential, account_id)
        assert 'google-refresh-secret' not in credential.encrypted_tokens
        tokens = json.loads(decrypt_secret(credential.encrypted_tokens)); tokens['expires_at'] = time.time() - 1
        credential.encrypted_tokens = encrypt_secret(json.dumps(tokens)); await session.commit()
    path = f'/api/v1/mail/gmail/{account_id}'
    synced = await client.post(path + '/sync')
    assert synced.json() == {'imported':1,'next_page_token':'next-page'}
    assert (await client.post(path + '/sync', params={'page_token':'next-page'})).json()['imported'] == 0
    mail = (await client.get('/api/v1/mail/messages')).json()
    assert len(mail) == 1 and mail[0]['body'] == 'Plain body'
    draft = (await client.post('/api/v1/mail/drafts', json={'recipients':['person@example.test'],'subject':'Reply','content':'My Gmail reply'})).json()
    publish = path + f"/drafts/{draft['id']}"
    assert (await client.post(publish, json={'version':draft['version']})).status_code == 200
    assert (await client.post(publish, json={'version':draft['version']})).status_code == 200
    assert len([call for call in calls if call[0] == 'POST' and call[1].endswith('/drafts')]) == 1
    assert len([call for call in calls if call[0] == 'PUT' and call[1].endswith('/drafts/gmail-draft-1')]) == 1
    async with factory() as session:
        link = await session.get(GmailDraftLink, draft['id']); link.state = 'saving'; await session.commit()
    assert (await client.post(publish, json={'version':draft['version']})).status_code == 409
    disconnected = await client.post(path + '/disconnect')
    assert disconnected.json() == {'disconnected':True,'provider_revoked':True}
    assert (await client.post(path + '/sync')).status_code == 409
    assert not any('/send' in call[1] for call in calls)


@pytest.mark.asyncio
async def test_gmail_callback_rejects_revoked_session(gmail_client, monkeypatch):
    client, _ = gmail_client
    async def forbidden(*args, **kwargs): raise AssertionError('Revoked session must not exchange OAuth codes')
    monkeypatch.setattr(gmail, 'google', forbidden)
    start = await client.post('/api/v1/mail/gmail/connect')
    state = parse_qs(urlparse(start.json()['authorization_url']).query)['state'][0]
    await client.post('/api/v1/auth/logout')
    assert (await client.get('/api/v1/mail/gmail/callback', params={'state':state,'code':'private-code'})).status_code == 401


def test_callback_codes_are_redacted_from_access_logs():
    record = logging.LogRecord('uvicorn.access', logging.INFO, '', 0, '%s - %s %s %s %s', ('host','GET','/api/v1/mail/gmail/callback?code=private-code&state=private-state','1.1',303), None)
    OAuthAccessLogFilter().filter(record)
    assert 'private-code' not in record.getMessage() and 'private-state' not in record.getMessage()


@pytest.mark.asyncio
async def test_importing_existing_gmail_draft_does_not_overwrite_local_edits(gmail_client, monkeypatch):
    from app.core.models import MailAccount
    client, factory = gmail_client
    async with factory() as session:
        from app.core.models import User
        owner = (await session.execute(select(User))).scalar_one()
        account = MailAccount(owner_id=owner.id, provider='gmail', external_id='person@example.test', connection_status='connected')
        session.add(account); await session.flush()
        account_id = account.id
        session.add(GmailCredential(account_id=account_id, encrypted_tokens=encrypt_secret(json.dumps({'access_token':'access','expires_at':time.time()+3600}))))
        await session.commit()
    async def fake_google(method, url, **kwargs):
        if url.endswith('/drafts'): return {'drafts':[{'id':'remote-draft'}]}
        return {'message':{'threadId':'thread','payload':{'mimeType':'text/plain','headers':[{'name':'Subject','value':'Remote draft'},{'name':'To','value':'Person <person@example.test>'}],'body':{'data':base64.urlsafe_b64encode(b'Remote content').decode()}}}}
    monkeypatch.setattr(gmail, 'google', fake_google)
    path = f'/api/v1/mail/gmail/{account_id}/drafts/import'
    assert (await client.post(path)).json()['imported'] == 1
    draft = (await client.get('/api/v1/mail/drafts')).json()[0]
    assert draft['recipients'] == ['person@example.test']
    await client.patch(f"/api/v1/mail/drafts/{draft['id']}", json={'version':draft['version'],'content':'Local edit','subject':draft['subject']})
    assert (await client.post(path)).json()['imported'] == 0
    assert (await client.get('/api/v1/mail/drafts')).json()[0]['content'] == 'Local edit'
