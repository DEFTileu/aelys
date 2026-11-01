"""Encrypted memory survives owner export/restore and atomic key rotation."""
import copy
from datetime import UTC, datetime, timedelta

import pytest
from app.ai import memory
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.ai.errors import PolicyDenied
from app.ai.memory_models import OwnerMemoryFact
from app.ai.policy import ServerPolicyEngine
from app.core.config import get_settings
from app.core.db import Base
from app.core.export import (
    build_owner_export,
    read_encrypted_export,
    restore_owner_export,
    write_encrypted_export,
)
from app.core.models import AIProviderSecret, User
from cryptography.exceptions import InvalidTag
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from scripts import rotate_provider_secrets

OLD = 'memory-old-test-key-0123456789abcdef'
NEW = 'memory-new-test-key-0123456789abcdef'


@pytest.fixture
async def stores(tmp_path, monkeypatch):
    monkeypatch.setenv('AELYS_PROVIDER_ENCRYPTION_KEY', OLD)
    monkeypatch.setenv('AELYS_EXPORT_KEY', 'ab' * 32)
    get_settings.cache_clear()
    engines = []
    factories = []
    try:
        for name in ['source', 'target']:
            engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/{name}.db')
            engines.append(engine)
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            factories.append(async_sessionmaker(engine, expire_on_commit=False))
        async with factories[0]() as session:
            session.add_all([User(id='source', email='source@example.test'), User(id='unrelated', email='unrelated@example.test')])
            await session.commit()
            await memory.remember(session, 'source', 'Private lexical preference', kind='preference', source='api')
            expired = await memory.remember(session, 'source', 'Expired private fact')
            expired.expires_at = datetime.now(UTC) - timedelta(days=1)
            deleted = await memory.remember(session, 'source', 'Forgotten private fact')
            await memory.forget(session, 'source', fact_id=deleted.id, version=deleted.version)
            await memory.remember(session, 'unrelated', 'Other owner secret fact')
            await session.commit()
        async with factories[1]() as session:
            session.add_all([User(id='target', email='target@example.test'), User(id='other', email='other@example.test')])
            await session.commit()
        yield factories[0], factories[1], tmp_path
    finally:
        for engine in engines:
            await engine.dispose()
        get_settings.cache_clear()


async def test_encrypted_export_restores_new_owner_key_and_recomputes_hash(stores, monkeypatch):
    source, target, tmp_path = stores
    async with source() as session:
        payload = await build_owner_export(session, 'source@example.test')
    facts = payload['tables']['owner_memory_facts']
    assert len(facts) == 3 and all(row['owner_id'] == 'source' for row in facts)
    assert 'Other owner secret fact' not in str(payload)
    output = tmp_path / 'owner.aelys-export'
    write_encrypted_export(output, payload)
    raw = output.read_bytes()
    assert b'Private lexical preference' not in raw and b'Forgotten private fact' not in raw
    loaded = read_encrypted_export(output)
    monkeypatch.setenv('AELYS_PROVIDER_ENCRYPTION_KEY', NEW)
    get_settings.cache_clear()
    async with target() as session:
        await memory.remember(session, 'other', 'Private lexical preference', kind='preference')
        await session.commit()
        assert await restore_owner_export(session, 'target@example.test', loaded) == 3
        rows = list((await session.execute(select(OwnerMemoryFact).where(OwnerMemoryFact.owner_id == 'target'))).scalars())
        assert len(rows) == 3 and all(row.owner_id == 'target' for row in rows)
        active = await memory.list_memory(session, 'target')
        assert [row.text for row in active] == ['Private lexical preference']
        # The service must find/deduplicate the restored identity under the new
        # owner's normalization; source-owner hashes cannot be copied verbatim.
        replay = await memory.remember(session, 'target', '  PRIVATE lexical preference  ', kind='preference')
        assert replay.id == active[0].id
        await memory.forget(session, 'target', text='PRIVATE lexical preference', version=replay.version)
        await session.commit()
        assert await memory.list_memory(session, 'target') == []
        assert [row.text for row in await memory.list_memory(session, 'other')] == ['Private lexical preference']
        ciphertext = (await session.execute(text('SELECT text FROM owner_memory_facts WHERE id=:id'), {'id': replay.id})).scalar_one()
        assert decrypt_secret(ciphertext, NEW) == 'Private lexical preference'
        with pytest.raises(InvalidTag):
            decrypt_secret(ciphertext, OLD)


async def test_restore_collision_never_overwrites_another_owner(stores):
    source, target, _ = stores
    async with source() as session:
        payload = await build_owner_export(session, 'source@example.test')
    async with target() as session:
        existing = await memory.remember(session, 'other', 'Existing other owner fact')
        existing_id = existing.id
        await session.commit()
        conflicting = copy.deepcopy(payload)
        conflicting['tables']['owner_memory_facts'][0]['id'] = existing_id
        with pytest.raises(RuntimeError, match='[Cc]onflict|[Cc]ollision|[Ee]xist'):
            await restore_owner_export(session, 'target@example.test', conflicting)
        await session.rollback()
    async with target() as check:
        rows = list((await check.execute(select(OwnerMemoryFact))).scalars())
        assert len(rows) == 1 and rows[0].owner_id == 'other' and rows[0].text == 'Existing other owner fact'


async def test_restore_memory_policy_denial_inserts_no_fact(stores, monkeypatch):
    source, target, _ = stores
    async with source() as session:
        payload = await build_owner_export(session, 'source@example.test')
    checks = []

    def deny(self, descriptor, call, context):
        checks.append((descriptor.required_scope, context.actor, call.arguments))
        raise PolicyDenied('Memory restore denied')

    monkeypatch.setattr(ServerPolicyEngine, 'authorize', deny)
    async with target() as session:
        with pytest.raises(PolicyDenied, match='Memory restore denied'):
            await restore_owner_export(session, 'target@example.test', payload)
        assert checks == [('memory.write', 'owner:target', {})]
        # Check before rollback too: authorization precedes the first db.add.
        assert list((await session.execute(select(OwnerMemoryFact))).scalars()) == []
        async with target() as observer:
            assert list((await observer.execute(select(OwnerMemoryFact))).scalars()) == []
        await session.rollback()


async def test_rotation_reencrypts_active_expired_and_forgotten_memory_raw(stores, monkeypatch):
    source, _, _ = stores
    monkeypatch.setattr(rotate_provider_secrets, 'SessionLocal', source)
    monkeypatch.setenv('AELYS_PROVIDER_ENCRYPTION_KEY_OLD', OLD)
    async with source() as session:
        before = (await session.execute(text('SELECT id,text,version,normalized_hash FROM owner_memory_facts'))).mappings().all()
    monkeypatch.setenv('AELYS_PROVIDER_ENCRYPTION_KEY', NEW)
    get_settings.cache_clear()
    assert await rotate_provider_secrets.rotate() == 4
    async with source() as session:
        after = (await session.execute(text('SELECT id,text,version,normalized_hash FROM owner_memory_facts'))).mappings().all()
        prior = {row['id']: row for row in before}
        for row in after:
            old = prior[row['id']]
            assert row['text'] != old['text']
            assert decrypt_secret(row['text'], NEW) == decrypt_secret(old['text'], OLD)
            assert row['version'] == old['version'] and row['normalized_hash'] == old['normalized_hash']
            with pytest.raises(InvalidTag):
                decrypt_secret(row['text'], OLD)
        assert [row.text for row in await memory.list_memory(session, 'source')] == ['Private lexical preference']


async def test_bad_memory_ciphertext_rolls_back_provider_and_all_memory_rotation(stores, monkeypatch):
    source, _, _ = stores
    monkeypatch.setattr(rotate_provider_secrets, 'SessionLocal', source)
    monkeypatch.setenv('AELYS_PROVIDER_ENCRYPTION_KEY_OLD', OLD)
    async with source() as session:
        session.add(AIProviderSecret(provider_id='provider', owner_id='source',
            encrypted_value=encrypt_secret('synthetic-provider-key', OLD), key_version=1))
        row = (await session.execute(select(OwnerMemoryFact.id).limit(1))).scalar_one()
        await session.execute(text('UPDATE owner_memory_facts SET text=:value WHERE id=:id'),
                              {'value': encrypt_secret('wrong key text', NEW), 'id': row})
        await session.commit()
        before = (await session.execute(text('SELECT id,text FROM owner_memory_facts ORDER BY id'))).all()
    monkeypatch.setenv('AELYS_PROVIDER_ENCRYPTION_KEY', NEW)
    get_settings.cache_clear()
    with pytest.raises(InvalidTag):
        await rotate_provider_secrets.rotate()
    async with source() as check:
        provider = await check.get(AIProviderSecret, 'provider')
        assert provider.key_version == 1 and decrypt_secret(provider.encrypted_value, OLD) == 'synthetic-provider-key'
        assert (await check.execute(text('SELECT id,text FROM owner_memory_facts ORDER BY id'))).all() == before
