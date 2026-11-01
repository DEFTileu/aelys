"""Shared PKCE state is owner/session bound, expiring and consumed once."""
import asyncio
import base64
import hashlib
from datetime import UTC, datetime, timedelta

import pytest
from app.ai.crypto import encrypt_secret
from app.core.db import Base
from app.core.models import AuthSession, Device, GmailOAuthState, User
from app.domains.google_calendar_models import GoogleCalendarOAuthState
from app.domains.google_oauth import consume_oauth_state, create_pkce
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture(params=[GmailOAuthState, GoogleCalendarOAuthState])
async def oauth_state(tmp_path, request):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/state.db')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    state, verifier, _ = create_pkce()
    model = request.param
    async with sessions() as db:
        db.add_all([User(id='owner'), User(id='other')])
        db.add(Device(id='device', owner_id='owner', platform='web', display_name='OAuth', credential_hash='synthetic'))
        db.add(AuthSession(id='session', owner_id='owner', device_id='device', refresh_token_hash='synthetic', expires_at=datetime.now(UTC) + timedelta(hours=1)))
        db.add(model(state_hash=hashlib.sha256(state.encode()).hexdigest(), owner_id='owner', session_id='session',
            encrypted_verifier=encrypt_secret(verifier), expires_at=datetime.now(UTC) + timedelta(minutes=10)))
        await db.commit()
    try:
        yield sessions, model, state, verifier
    finally:
        await engine.dispose()


def test_pkce_randomness_and_s256_contract():
    state, verifier, challenge = create_pkce()
    assert len(state) >= 43 and 43 <= len(verifier) <= 128
    assert challenge == base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    assert state != verifier and create_pkce() != (state, verifier, challenge)


async def test_state_cookie_and_single_use_commit(oauth_state):
    sessions, model, state, verifier = oauth_state
    async with sessions() as db:
        with pytest.raises(HTTPException) as error:
            await consume_oauth_state(db, model, state, 'wrong-cookie')
        assert error.value.status_code == 400
        record, recovered = await consume_oauth_state(db, model, state, state)
        assert record.owner_id == 'owner' and recovered == verifier
    async with sessions() as db:
        assert (await db.execute(select(model))).scalars().all() == []
        with pytest.raises(HTTPException) as error:
            await consume_oauth_state(db, model, state, state)
        assert error.value.status_code == 400


@pytest.mark.parametrize('invalid', ['state_expired', 'session_expired', 'session_revoked', 'device_revoked', 'device_deleted', 'session_owner', 'device_owner'])
async def test_invalid_authority_never_consumes_state(oauth_state, invalid):
    sessions, model, state, _ = oauth_state
    async with sessions() as db:
        row = (await db.execute(select(model))).scalar_one()
        session = await db.get(AuthSession, 'session')
        device = await db.get(Device, 'device')
        if invalid == 'state_expired': row.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        elif invalid == 'session_expired': session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        elif invalid == 'session_revoked': session.revoked_at = datetime.now(UTC)
        elif invalid == 'device_revoked': device.revoked_at = datetime.now(UTC)
        elif invalid == 'device_deleted': device.deleted_at = datetime.now(UTC)
        elif invalid == 'session_owner': session.owner_id = 'other'
        else: device.owner_id = 'other'
        await db.commit()
        with pytest.raises(HTTPException) as error:
            await consume_oauth_state(db, model, state, state)
        assert error.value.status_code == (400 if invalid == 'state_expired' else 401)
        assert (await db.execute(select(model))).scalar_one().state_hash == row.state_hash


async def test_parallel_state_consumption_has_exactly_one_winner(oauth_state):
    sessions, model, state, _ = oauth_state
    async def consume():
        async with sessions() as db:
            try:
                await consume_oauth_state(db, model, state, state)
                return 'consumed'
            except HTTPException as error:
                assert error.status_code == 400
                return 'rejected'
    assert sorted(await asyncio.gather(consume(), consume())) == ['consumed', 'rejected']
