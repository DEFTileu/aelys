import base64
import hashlib
import secrets
from datetime import timedelta

import pytest
import pytest_asyncio
from app.core import db
from app.core.config import get_settings
from app.core.device_auth import issue_setup_token, sas_code
from app.core.models import PairingSession, now
from app.main import app
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

B = '/api/v1'


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


class Key:
    """A test device key: what a Secure Enclave, Keystore or WebCrypto key does on a real client."""

    def __init__(self):
        self.private = ec.generate_private_key(ec.SECP256R1())
        self.public = b64(self.private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))

    def sign(self, message: str, raw: bool = False) -> str:
        der = self.private.sign(message.encode(), ec.ECDSA(hashes.SHA256()))
        if not raw:
            return b64(der)
        r, s = decode_dss_signature(der)
        return b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))


def new_secret():
    value = secrets.token_urlsafe(32)
    return value, hashlib.sha256(value.encode()).hexdigest()


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/pairing.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http
    await engine.dispose()


async def setup_token(purpose='first_owner'):
    async with db.SessionLocal() as session:
        return await issue_setup_token(session, purpose)


async def claim_owner(client, key=None, name='Mac'):
    key = key or Key()
    response = await client.post(f'{B}/auth/setup/claim', json={'token': await setup_token(), 'public_key': key.public, 'platform': 'macos', 'display_name': name})
    assert response.status_code == 200, response.text
    return key, response.json()


def bearer(session):
    return {'Authorization': f"Bearer {session['access_token']}"}


@pytest.mark.asyncio
async def test_setup_token_creates_a_passwordless_owner_once(client):
    key, session = await claim_owner(client)
    me = (await client.get(f'{B}/me', headers=bearer(session))).json()
    assert me['device_id'] == session['device_id'] and me['email'] is None
    reused = await client.post(f'{B}/auth/setup/claim', json={'token': 'x' * 32, 'public_key': Key().public, 'platform': 'macos', 'display_name': 'Other'})
    assert reused.status_code == 401 and reused.json()['detail']['code'] == 'INVALID_SETUP_TOKEN'
    second = await setup_token()
    assert (await client.post(f'{B}/auth/setup/claim', json={'token': second, 'public_key': Key().public, 'platform': 'macos', 'display_name': 'Late'})).status_code == 409


@pytest.mark.asyncio
async def test_setup_token_rejects_expired_and_malformed_keys(client):
    token = await setup_token()
    assert (await client.post(f'{B}/auth/setup/claim', json={'token': token, 'public_key': 'not-a-key', 'platform': 'macos', 'display_name': 'Bad'})).status_code == 422
    from app.core.models import SetupToken
    async with db.SessionLocal() as session:
        await session.execute(update(SetupToken).values(expires_at=now() - timedelta(minutes=1)))
        await session.commit()
    assert (await client.post(f'{B}/auth/setup/claim', json={'token': token, 'public_key': Key().public, 'platform': 'macos', 'display_name': 'Late'})).status_code == 401


@pytest.mark.asyncio
async def test_device_login_needs_a_fresh_valid_signature_and_refresh_still_rotates(client):
    key, session = await claim_owner(client)
    device_id = session['device_id']
    challenge = (await client.post(f'{B}/auth/device/challenge', json={'device_id': device_id})).json()
    message = f"aelys-device-login-v1\n{device_id}\n{challenge['nonce']}"
    login = await client.post(f'{B}/auth/device/login', json={'challenge_id': challenge['challenge_id'], 'signature': key.sign(message, raw=True)})
    assert login.status_code == 200 and login.json()['device_id'] == device_id
    replay = await client.post(f'{B}/auth/device/login', json={'challenge_id': challenge['challenge_id'], 'signature': key.sign(message)})
    assert replay.status_code == 401
    rotated = await client.post(f'{B}/auth/refresh', json={'refresh_token': login.json()['refresh_token']})
    assert rotated.status_code == 200
    assert (await client.get(f'{B}/me', headers=bearer(rotated.json()))).json()['device_id'] == device_id

    forged = (await client.post(f'{B}/auth/device/challenge', json={'device_id': device_id})).json()
    wrong = await client.post(f'{B}/auth/device/login', json={'challenge_id': forged['challenge_id'], 'signature': Key().sign(f"aelys-device-login-v1\n{device_id}\n{forged['nonce']}")})
    assert wrong.status_code == 401
    # The burned challenge cannot be retried with the right key.
    assert (await client.post(f'{B}/auth/device/login', json={'challenge_id': forged['challenge_id'], 'signature': key.sign(f"aelys-device-login-v1\n{device_id}\n{forged['nonce']}")})).status_code == 401


@pytest.mark.asyncio
async def test_status_tells_clients_whether_password_setup_is_still_offered(client, monkeypatch):
    monkeypatch.setattr(get_settings(), 'password_bootstrap_enabled', False)
    assert (await client.get(f'{B}/auth/browser/status')).json() == {'initialized': False, 'can_resume': False, 'password_setup': False}
    assert (await client.get(f'{B}/auth/native/status')).json() == {'initialized': False, 'password_setup': False}
    monkeypatch.setattr(get_settings(), 'password_bootstrap_enabled', True)
    assert (await client.get(f'{B}/auth/browser/status')).json()['password_setup'] is True
    await claim_owner(client)
    assert (await client.get(f'{B}/auth/browser/status')).json()['initialized'] is True


@pytest.mark.asyncio
async def test_unanswered_challenges_are_capped_per_device(client):
    _, session = await claim_owner(client)
    codes = [(await client.post(f'{B}/auth/device/challenge', json={'device_id': session['device_id']})).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429


@pytest.mark.asyncio
async def test_revoked_devices_and_unknown_devices_cannot_log_in(client):
    key, session = await claim_owner(client)
    assert (await client.post(f'{B}/devices/{session["device_id"]}/revoke', headers=bearer(session))).status_code == 200
    assert (await client.post(f'{B}/auth/device/challenge', json={'device_id': session['device_id']})).status_code == 401
    assert (await client.post(f'{B}/auth/device/challenge', json={'device_id': 'missing'})).status_code == 401


@pytest.mark.asyncio
async def test_password_bootstrap_can_be_disabled_for_public_hosts(client, monkeypatch):
    monkeypatch.setattr(get_settings(), 'password_bootstrap_enabled', False)
    blocked = await client.post(f'{B}/auth/bootstrap', json={'email': 'owner@example.test', 'password': 'synthetic-password'})
    assert blocked.status_code == 403 and blocked.json()['detail']['code'] == 'BOOTSTRAP_DISABLED'
    await claim_owner(client)


@pytest.mark.asyncio
async def test_password_owner_can_migrate_to_a_key_bound_device(client):
    owner = (await client.post(f'{B}/auth/bootstrap', json={'email': 'migrate@example.test', 'password': 'synthetic-password'})).json()
    headers = bearer(owner)
    me = (await client.get(f'{B}/me', headers=headers)).json()
    key = Key()
    bad = await client.post(f'{B}/devices/register-key', headers=headers, json={'public_key': key.public, 'platform': 'macos', 'display_name': 'Mac', 'proof': Key().sign(f"aelys-device-register-v1\n{me['id']}\n{key.public}")})
    assert bad.status_code == 401
    good = await client.post(f'{B}/devices/register-key', headers=headers, json={'public_key': key.public, 'platform': 'macos', 'display_name': 'Mac', 'proof': key.sign(f"aelys-device-register-v1\n{me['id']}\n{key.public}")})
    assert good.status_code == 200 and good.json()['device_id']
    # A password session has no key-bound device, so it cannot hand out pairings.
    assert (await client.post(f'{B}/pairing/invite', headers=headers, json={'secret_hash': new_secret()[1]})).status_code == 403


async def pair_by_invite(client, trusted_session):
    secret, secret_hash = new_secret()
    invite = (await client.post(f'{B}/pairing/invite', headers=bearer(trusted_session), json={'secret_hash': secret_hash})).json()
    phone = Key()
    claim = await client.post(f"{B}/pairing/{invite['pairing_id']}/claim", json={'secret': secret, 'public_key': phone.public, 'platform': 'android', 'display_name': 'Pixel'})
    assert claim.status_code == 200, claim.text
    return invite['pairing_id'], secret, phone


@pytest.mark.asyncio
async def test_qr_invite_pairs_a_phone_only_after_the_code_is_confirmed(client):
    _, trusted = await claim_owner(client)
    pairing_id, secret, phone = await pair_by_invite(client, trusted)
    path = f'{B}/pairing/{pairing_id}'
    finish_message = f'aelys-pairing-finish-v1\n{pairing_id}'
    pending = await client.post(f'{path}/finish', json={'signature': phone.sign(finish_message)})
    assert pending.status_code == 409 and pending.json()['detail']['code'] == 'PAIRING_PENDING'
    info = (await client.post(f'{path}/inspect', headers=bearer(trusted), json={'secret': secret})).json()
    assert info['display_name'] == 'Pixel' and info['platform'] == 'android' and len(info['key_fingerprint']) == 16
    wrong = await client.post(f'{path}/approve', headers=bearer(trusted), json={'secret': secret, 'sas': '000000' if sas_code(secret, pairing_id, phone.public) != '000000' else '000001'})
    assert wrong.status_code == 403 and wrong.json()['detail']['code'] == 'SAS_MISMATCH'
    approved = await client.post(f'{path}/approve', headers=bearer(trusted), json={'secret': secret, 'sas': sas_code(secret, pairing_id, phone.public)})
    assert approved.status_code == 200
    stranger = await client.post(f'{path}/finish', json={'signature': Key().sign(finish_message)})
    assert stranger.status_code == 403
    done = await client.post(f'{path}/finish', json={'signature': phone.sign(finish_message, raw=True)})
    assert done.status_code == 200
    me = (await client.get(f'{B}/me', headers=bearer(done.json()))).json()
    assert me['device_id'] == approved.json()['device_id'] != trusted['device_id']
    assert (await client.post(f'{path}/finish', json={'signature': phone.sign(finish_message)})).status_code == 410
    async with db.SessionLocal() as session:
        row = await session.get(PairingSession, pairing_id)
        assert row.secret_hash == hashlib.sha256(secret.encode()).hexdigest() and secret not in str(row.__dict__.values())


@pytest.mark.asyncio
async def test_a_new_device_can_show_the_qr_and_a_trusted_phone_approves_it(client):
    _, trusted = await claim_owner(client)
    secret, secret_hash = new_secret()
    browser = Key()
    request = (await client.post(f'{B}/pairing/request', json={'secret_hash': secret_hash, 'public_key': browser.public, 'platform': 'web', 'display_name': 'Chrome'})).json()
    path = f"{B}/pairing/{request['pairing_id']}"
    assert (await client.post(f'{path}/inspect', headers=bearer(trusted), json={'secret': new_secret()[0]})).status_code == 403
    approved = await client.post(f'{path}/approve', headers=bearer(trusted), json={'secret': secret, 'sas': sas_code(secret, request['pairing_id'], browser.public)})
    assert approved.status_code == 200
    done = await client.post(f'{path}/finish', json={'signature': browser.sign(f"aelys-pairing-finish-v1\n{request['pairing_id']}")})
    assert done.status_code == 200 and done.json()['device_id'] == approved.json()['device_id']


@pytest.mark.asyncio
async def test_pairing_resists_reuse_guessing_and_expiry(client):
    _, trusted = await claim_owner(client)
    pairing_id, secret, phone = await pair_by_invite(client, trusted)
    path = f'{B}/pairing/{pairing_id}'
    again = await client.post(f'{path}/claim', json={'secret': secret, 'public_key': Key().public, 'platform': 'android', 'display_name': 'Thief'})
    assert again.status_code == 409 and again.json()['detail']['code'] == 'PAIRING_ALREADY_CLAIMED'

    second_secret, second_hash = new_secret()
    second = (await client.post(f'{B}/pairing/invite', headers=bearer(trusted), json={'secret_hash': second_hash})).json()
    attempts = [await client.post(f"{B}/pairing/{second['pairing_id']}/claim", json={'secret': new_secret()[0], 'public_key': Key().public, 'platform': 'android', 'display_name': 'Guess'}) for _ in range(get_settings().pairing_max_attempts)]
    assert {item.status_code for item in attempts} == {403}
    locked = await client.post(f"{B}/pairing/{second['pairing_id']}/claim", json={'secret': second_secret, 'public_key': Key().public, 'platform': 'android', 'display_name': 'Owner'})
    assert locked.status_code == 423

    async with db.SessionLocal() as session:
        await session.execute(update(PairingSession).where(PairingSession.id == pairing_id).values(expires_at=now() - timedelta(seconds=1)))
        await session.commit()
    expired = await client.post(f'{path}/approve', headers=bearer(trusted), json={'secret': secret, 'sas': sas_code(secret, pairing_id, phone.public)})
    assert expired.status_code == 410


@pytest.mark.asyncio
async def test_recovery_token_adds_a_device_to_the_existing_owner(client):
    first_key, first = await claim_owner(client)
    owner_id = (await client.get(f'{B}/me', headers=bearer(first))).json()['id']
    recovered_key = Key()
    response = await client.post(f'{B}/auth/setup/claim', json={'token': await setup_token('recovery'), 'public_key': recovered_key.public, 'platform': 'macos', 'display_name': 'New Mac'})
    assert response.status_code == 200
    assert (await client.get(f'{B}/me', headers=bearer(response.json()))).json()['id'] == owner_id
