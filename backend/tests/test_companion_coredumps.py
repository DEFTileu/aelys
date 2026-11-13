import asyncio
import hashlib
import uuid

import pytest
import pytest_asyncio
from app.companion.ota_models import CompanionCoredump
from app.core import db
from app.core.models import Device, User
from app.main import app
from companion_helpers import B, Key, bearer, companion_token, pair_companion
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

CAP = 65536
ELF = 'AB' * 32


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/coredumps.db')
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, 'SessionLocal', async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as http:
        yield http
    await engine.dispose()


@pytest_asyncio.fixture
async def paired(client):
    owner, board_key, device_id = await pair_companion(client)
    return owner, {'Authorization': f'Bearer {await companion_token(client, board_key, device_id)}'}, device_id


async def post(client, board, data=b'\x01crash', version='0.4.2', **extra):
    return await client.post(f'{B}/companion/coredumps', content=data, headers={**board, 'X-Fw-Version': version, **extra})


@pytest.mark.asyncio
async def test_board_uploads_dump(client, paired):
    _, board, device_id = paired
    response = await post(client, board, b'dump-bytes', **{'X-Elf-Sha256': ELF})
    assert response.status_code == 201
    async with db.SessionLocal() as session:
        row = (await session.execute(select(CompanionCoredump))).scalar_one()
    assert response.json() == {'id': row.id}
    assert (row.device_id, row.fw_version, row.size, row.data) == (device_id, '0.4.2', 10, b'dump-bytes')
    assert row.elf_sha256 == ELF.lower() and row.sha256 == hashlib.sha256(b'dump-bytes').hexdigest()


@pytest.mark.asyncio
async def test_same_dump_stored_once(client, paired):
    _, board, _ = paired
    first = await post(client, board)
    second = await post(client, board)
    assert (first.status_code, second.status_code) == (201, 200) and first.json() == second.json()
    both = await asyncio.gather(post(client, board, b'racy'), post(client, board, b'racy'))
    assert {r.status_code for r in both} <= {200, 201} and both[0].json() == both[1].json()
    async with db.SessionLocal() as session:
        assert len((await session.execute(select(CompanionCoredump.id))).all()) == 2


@pytest.mark.asyncio
async def test_dump_too_large_is_413(client, paired):
    _, board, _ = paired
    assert (await post(client, board, b'x' * CAP)).status_code == 201
    over = await post(client, board, b'x' * (CAP + 1))
    assert over.status_code == 413 and over.json()['detail']['code'] == 'COREDUMP_TOO_LARGE'


@pytest.mark.asyncio
async def test_bad_input_is_422(client, paired):
    _, board, _ = paired
    for response in (await post(client, board, b''), await post(client, board, version='1.2'),
                     await post(client, board, **{'X-Elf-Sha256': 'zz'}), await post(client, board, **{'X-Elf-Sha256': 'a' * 63})):
        assert response.status_code == 422 and response.json()['detail']['code'] == 'VALIDATION_ERROR'
    assert (await client.post(f'{B}/companion/coredumps', content=b'x', headers=board)).status_code == 422  # version is required


@pytest.mark.asyncio
async def test_owner_cannot_upload(client, paired):
    owner, _, _ = paired
    response = await post(client, bearer(owner))
    assert response.status_code == 403 and response.json()['detail']['code'] == 'COMPANION_ONLY'


@pytest.mark.asyncio
async def test_owner_lists_and_downloads(client, paired):
    owner, board, device_id = paired
    old = (await post(client, board, b'old', version='0.4.1')).json()['id']
    new = (await post(client, board, b'newer', **{'X-Elf-Sha256': ELF})).json()['id']
    listing = await client.get(f'{B}/companion/devices/{device_id}/coredumps', headers=bearer(owner))
    assert listing.status_code == 200
    rows = listing.json()
    assert [r['id'] for r in rows] == [new, old]
    assert set(rows[0]) == {'id', 'fw_version', 'elf_sha256', 'size', 'created_at'}
    assert (rows[0]['size'], rows[0]['elf_sha256'], rows[1]['elf_sha256']) == (5, ELF.lower(), None)
    dump = await client.get(f'{B}/companion/devices/{device_id}/coredumps/{new}', headers=bearer(owner))
    assert dump.status_code == 200 and dump.content == b'newer' and dump.headers['content-type'] == 'application/octet-stream'
    missing = await client.get(f'{B}/companion/devices/{device_id}/coredumps/nope', headers=bearer(owner))
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_board_cannot_list_dumps(client, paired):
    _, board, device_id = paired
    dump_id = (await post(client, board)).json()['id']
    for tail in ('', f'/{dump_id}'):
        response = await client.get(f'{B}/companion/devices/{device_id}/coredumps{tail}', headers=board)
        assert response.status_code == 403 and response.json()['detail']['code'] == 'DEVICE_SCOPE_DENIED'


@pytest.mark.asyncio
async def test_other_owner_device_is_404(client, paired):
    owner, board, device_id = paired
    mine = (await post(client, board)).json()['id']
    async with db.SessionLocal() as session:
        stranger = User(email=None, password_hash=None)
        session.add(stranger)
        await session.flush()
        foreign = Device(owner_id=stranger.id, platform='companion', display_name='X', public_key=Key().public, credential_hash='x')
        session.add(foreign)
        await session.flush()
        dump = CompanionCoredump(owner_id=stranger.id, device_id=foreign.id, fw_version='1.0.0', sha256='f' * 64, size=1, data=b'x')
        session.add(dump)
        await session.commit()
        foreign_id, foreign_dump = foreign.id, dump.id
    for path in (f'{foreign_id}/coredumps', f'{foreign_id}/coredumps/{foreign_dump}', f'{device_id}/coredumps/{foreign_dump}', f'{uuid.uuid4()}/coredumps'):
        assert (await client.get(f'{B}/companion/devices/{path}', headers=bearer(owner))).status_code == 404, path
    assert (await client.get(f'{B}/companion/devices/{device_id}/coredumps/{mine}', headers=bearer(owner))).status_code == 200


@pytest.mark.asyncio
async def test_keeps_five_newest(client, paired):
    owner, board, device_id = paired
    ids = [(await post(client, board, f'dump-{i}'.encode())).json()['id'] for i in range(7)]
    rows = (await client.get(f'{B}/companion/devices/{device_id}/coredumps', headers=bearer(owner))).json()
    assert [r['id'] for r in rows] == ids[:1:-1]
