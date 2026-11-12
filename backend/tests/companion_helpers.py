"""Shared helpers for tests that drive device pairing and the companion principal."""
import base64
import hashlib
import secrets

from app.core import db
from app.core.device_auth import issue_setup_token, sas_code
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

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


async def pair_companion(client):
    """Pair a board through the request flow; returns the owner session, the board's key and its device id."""
    _, owner = await claim_owner(client)
    secret, secret_hash = new_secret()
    board = Key()
    request = (await client.post(f'{B}/pairing/request', json={'secret_hash': secret_hash, 'public_key': board.public, 'platform': 'companion', 'display_name': 'Desk'})).json()
    pairing_id = request['pairing_id']
    approved = await client.post(f'{B}/pairing/{pairing_id}/approve', headers=bearer(owner), json={'secret': secret, 'sas': sas_code(secret, pairing_id, board.public)})
    assert approved.status_code == 200, approved.text
    done = await client.post(f'{B}/pairing/{pairing_id}/finish', json={'signature': board.sign(f'aelys-pairing-finish-v1\n{pairing_id}', raw=True)})
    assert done.status_code == 200, done.text
    return owner, board, done.json()['device_id']


async def companion_login(client, key, device_id):
    challenge = (await client.post(f'{B}/auth/device/challenge', json={'device_id': device_id})).json()
    message = f"aelys-device-login-v1\n{device_id}\n{challenge['nonce']}"
    return await client.post(f'{B}/auth/device/login', json={'challenge_id': challenge['challenge_id'], 'signature': key.sign(message, raw=True)})


async def companion_token(client, key, device_id):
    login = await companion_login(client, key, device_id)
    assert login.status_code == 200, login.text
    return login.json()['access_token']
