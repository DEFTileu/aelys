import hashlib

import pytest
import pytest_asyncio
from app.companion.ota_models import CompanionFirmware
from app.core import db
from app.core.device_auth import sas_code
from app.main import app
from companion_helpers import (
    B,
    Key,
    bearer,
    companion_token,
    new_secret,
    pair_companion,
)
from firmware_fixtures import make_image, sha256
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

CAP = 4 * 1024 * 1024


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/firmware.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http
    await engine.dispose()


async def put(client, owner, version, data=None, *, digest=None, min_version='0.0.0'):
    data = make_image(version) if data is None else data
    return await client.put(f'{B}/companion/firmware/{version}', params={'min_version': min_version}, content=data,
                            headers={**bearer(owner), 'X-Content-Sha256': digest or sha256(data), 'Content-Type': 'application/octet-stream'})


@pytest_asyncio.fixture
async def paired(client):
    owner, board_key, device_id = await pair_companion(client)
    return owner, {'Authorization': f'Bearer {await companion_token(client, board_key, device_id)}'}, device_id


@pytest.mark.asyncio
async def test_upload_then_board_reads_metadata(client, paired):
    owner, board, device_id = paired
    image = make_image('0.4.2')
    uploaded = await put(client, owner, '0.4.2', image, min_version='0.4.0')
    expected = {'version': '0.4.2', 'sha256': sha256(image), 'size': len(image), 'min_version': '0.4.0'}
    assert uploaded.status_code == 201 and uploaded.json() == expected
    meta = await client.get(f'{B}/devices/{device_id}/firmware', headers=board)
    assert meta.status_code == 200
    assert meta.json() == {**expected, 'url': '/api/v1/companion/firmware/0.4.2/image'}


@pytest.mark.asyncio
async def test_board_downloads_image_bytes(client, paired):
    owner, board, device_id = paired
    image = make_image('1.0.0', size=16384)
    await put(client, owner, '1.0.0', image)
    meta = (await client.get(f'{B}/devices/{device_id}/firmware', headers=board)).json()
    body = await client.get(meta['url'], headers={**board, 'Accept-Encoding': 'identity'})  # a board never asks for gzip
    assert body.status_code == 200 and body.headers['content-type'] == 'application/octet-stream'
    assert int(body.headers['content-length']) == meta['size'] == len(image)
    assert hashlib.sha256(body.content).hexdigest() == meta['sha256']
    assert (await client.get(f'{B}/companion/firmware/9.9.9/image', headers=board)).json()['detail']['code'] == 'FIRMWARE_NONE'
    assert (await client.get(meta['url'], headers=bearer(owner))).content == image  # an owner device may read it too


@pytest.mark.asyncio
async def test_board_cannot_upload(client, paired):
    _, board, _ = paired
    image = make_image('1.0.0')
    response = await client.put(f'{B}/companion/firmware/1.0.0', content=image, headers={**board, 'X-Content-Sha256': sha256(image)})
    assert response.status_code == 403 and response.json()['detail']['code'] == 'DEVICE_SCOPE_DENIED'
    async with db.SessionLocal() as session:
        assert (await session.execute(select(CompanionFirmware))).first() is None


@pytest.mark.asyncio
async def test_board_cannot_read_other_board_firmware(client, paired):
    owner, board, _ = paired
    secret, secret_hash = new_secret()
    key_b = Key()
    request = (await client.post(f'{B}/pairing/request', json={'secret_hash': secret_hash, 'public_key': key_b.public, 'platform': 'companion', 'display_name': 'B'})).json()
    pid = request['pairing_id']
    assert (await client.post(f'{B}/pairing/{pid}/approve', headers=bearer(owner), json={'secret': secret, 'sas': sas_code(secret, pid, key_b.public)})).status_code == 200
    finished = await client.post(f'{B}/pairing/{pid}/finish', json={'signature': key_b.sign(f'aelys-pairing-finish-v1\n{pid}', raw=True)})
    other_id = finished.json()['device_id']
    await put(client, owner, '1.0.0')
    denied = await client.get(f'{B}/devices/{other_id}/firmware', headers=board)
    assert denied.status_code == 403 and denied.json()['detail']['code'] == 'DEVICE_SCOPE_DENIED'
    assert (await client.get(f'{B}/devices/{other_id}/firmware', headers=bearer(owner))).status_code == 200  # the owner may
    missing = await client.get(f'{B}/devices/00000000-0000-4000-8000-000000000000/firmware', headers=bearer(owner))
    assert missing.status_code == 404 and missing.json()['detail']['code'] == 'NOT_FOUND'


@pytest.mark.asyncio
async def test_latest_is_highest_semver(client, paired):
    owner, board, device_id = paired
    await put(client, owner, '0.10.0')
    await put(client, owner, '0.9.0')
    assert (await client.get(f'{B}/devices/{device_id}/firmware', headers=board)).json()['version'] == '0.10.0'


@pytest.mark.asyncio
@pytest.mark.parametrize('case', ['hash', 'unsigned', 'version', 'project', 'min_above', 'bad_semver'])
async def test_upload_rejects(client, paired, case):
    owner, _, _ = paired
    if case == 'hash':
        response, code = await put(client, owner, '1.0.0', digest='0' * 64), 'FIRMWARE_HASH_MISMATCH'
    elif case == 'unsigned':
        response, code = await put(client, owner, '1.0.0', make_image('1.0.0', signed=False)), 'FIRMWARE_UNSIGNED'
    elif case == 'version':
        response, code = await put(client, owner, '1.0.0', make_image('1.0.1')), 'FIRMWARE_INVALID'
    elif case == 'project':
        response, code = await put(client, owner, '1.0.0', make_image('1.0.0', project='other')), 'FIRMWARE_INVALID'
    elif case == 'min_above':
        response, code = await put(client, owner, '1.0.0', min_version='1.0.1'), 'FIRMWARE_INVALID'
    else:
        response, code = await put(client, owner, 'v1', make_image('1.0.0')), 'FIRMWARE_INVALID'
    assert response.status_code == 422 and response.json()['detail']['code'] == code
    async with db.SessionLocal() as session:
        assert (await session.execute(select(CompanionFirmware))).first() is None


@pytest.mark.asyncio
async def test_upload_too_large_is_413(client, paired):
    owner, _, _ = paired
    sent = 0

    async def body():
        nonlocal sent
        for _ in range(64):  # 64 MiB offered, nowhere near all of it may be read
            sent += 1
            yield b'\x00' * (1024 * 1024)

    response = await client.put(f'{B}/companion/firmware/1.0.0', params={'min_version': '0.0.0'}, content=body(), headers={**bearer(owner), 'X-Content-Sha256': '0' * 64})
    assert response.status_code == 413 and response.json()['detail']['code'] == 'FIRMWARE_TOO_LARGE'
    assert sent <= 6
    over = await put(client, owner, '1.0.0', b'\x00' * (CAP + 1))
    assert over.status_code == 413


@pytest.mark.asyncio
async def test_same_version_same_hash_replays_other_hash_conflicts(client, paired):
    owner, _, _ = paired
    image = make_image('1.0.0')
    assert (await put(client, owner, '1.0.0', image)).status_code == 201
    replay = await put(client, owner, '1.0.0', image)
    assert replay.status_code == 200 and replay.json()['sha256'] == sha256(image)
    other = make_image('1.0.0', size=12288)
    conflict = await put(client, owner, '1.0.0', other)
    assert conflict.status_code == 409 and conflict.json()['detail']['code'] == 'FIRMWARE_EXISTS'


@pytest.mark.asyncio
async def test_keeps_three_highest(client, paired):
    owner, _, _ = paired
    for version in ('0.2.0', '0.10.0', '0.3.0', '0.1.0', '0.11.0'):
        assert (await put(client, owner, version)).status_code == 201
    async with db.SessionLocal() as session:
        kept = {row.version for row in (await session.execute(select(CompanionFirmware))).scalars()}
    assert kept == {'0.11.0', '0.10.0', '0.3.0'}


@pytest.mark.asyncio
async def test_no_release_is_404(client, paired):
    owner, board, device_id = paired
    for headers in (board, bearer(owner)):
        response = await client.get(f'{B}/devices/{device_id}/firmware', headers=headers)
        assert response.status_code == 404 and response.json()['detail']['code'] == 'FIRMWARE_NONE'
