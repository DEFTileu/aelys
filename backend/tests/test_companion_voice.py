import pytest
from app.ai.tools import ToolValidationError
from app.companion.voice import VOICE_TOOLS, voice_registry


def test_voice_registry_excludes_other_tools():
    registry = voice_registry(None, 'owner', 'event')
    assert {schema['name'] for schema in registry.schemas()} == VOICE_TOOLS
    with pytest.raises(ToolValidationError):
        registry.descriptor('complete_task')

import asyncio
from decimal import Decimal
from types import SimpleNamespace

from app.ai import api as ai_api
from app.ai.crypto import encrypt_secret
from app.ai.models import ProviderKind, Usage
from app.companion import voice
from app.companion.models import CompanionState
from app.core import db
from app.core.models import (
    AIAction,
    AIConversation,
    AIMessage,
    AIProvider,
    AIProviderSecret,
    AIRun,
    Task,
    now,
)
from app.core.security import decode_token
from sqlalchemy import select

pytest_plugins = ('test_companion_channel',)


class FakeService:
    def __init__(self, call=None):
        self.call = call
        self.requests = []
    async def complete(self, run_id, request, messages, **kwargs):
        self.requests.append(messages)
        calls = (self.call,) if self.call and len(self.requests) == 1 else ()
        return SimpleNamespace(provider=ProviderKind.CLAUDE, model='test',
            response=SimpleNamespace(text='' if calls else 'личный ответ', tool_calls=calls),
            usage=SimpleNamespace(usage=Usage(5, 2), estimated_cost=Decimal('0.01')))


async def setup_voice(owner_id, device_id):
    async with db.SessionLocal() as session:
        if not await session.get(CompanionState, device_id):
            session.add(CompanionState(device_id=device_id, owner_id=owner_id))
        for kind in ('elevenlabs', 'claude'):
            provider = AIProvider(owner_id=owner_id, kind=kind, enabled=True,
                model_policy_json={'monthly_budget': '10', 'models': [{'name': 'test', 'capabilities': ['tool_calling']}]})
            session.add(provider)
            await session.flush()
            session.add(AIProviderSecret(provider_id=provider.id, owner_id=owner_id, encrypted_value=encrypt_secret('fake-key')))
        await session.commit()


async def execute_turn(monkeypatch, owner_id, device_id, turn_id, service, *, speak=False):
    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: service)
    async def stt(*args):
        return 'личная расшифровка'
    async def tts(*args):
        yield b'\x01\x02'
    monkeypatch.setattr(voice, 'transcribe_pcm', stt)
    monkeypatch.setattr(voice, 'speak_pcm', tts)
    sent = []
    async def send(item):
        sent.append(item)
    await voice.run_voice_turn(owner_id, device_id, turn_id, b'\x00\x00', speak, send, send)
    return sent


@pytest.mark.asyncio
async def test_voice_create_task_and_no_history_reuse_and_recreate(paired, monkeypatch, caplog):
    owner, device_id, _ = paired
    owner_id = decode_token(owner['access_token'])['sub']
    await setup_voice(owner_id, device_id)
    service = FakeService({'id': 'call1', 'name': 'create_task', 'input': {'title': 'купить молоко'}})
    sent = await execute_turn(monkeypatch, owner_id, device_id, 'first', service, speak=True)
    assert [x if isinstance(x, bytes) else x.get('state', x['type']) for x in sent] == ['thinking', 'voice_text', 'speaking', b'\x01\x02', 'done']
    async with db.SessionLocal() as session:
        assert (await session.execute(select(Task).where(Task.title == 'купить молоко'))).scalar_one()
        assert not (await session.execute(select(AIAction))).scalars().all()
        board = await session.get(CompanionState, device_id)
        first = board.voice_conversation_id
        session.add(AIMessage(conversation_id=first, role='assistant', content='old secret history'))
        await session.commit()
    service2 = FakeService()
    await execute_turn(monkeypatch, owner_id, device_id, 'second', service2)
    assert 'old secret history' not in repr(service2.requests)
    async with db.SessionLocal() as session:
        board = await session.get(CompanionState, device_id)
        assert board.voice_conversation_id == first
        conversation = await session.get(AIConversation, first)
        conversation.deleted_at = now()
        await session.commit()
    await execute_turn(monkeypatch, owner_id, device_id, 'third', FakeService())
    async with db.SessionLocal() as session:
        assert (await session.get(CompanionState, device_id)).voice_conversation_id != first
        runs = (await session.execute(select(AIRun).where(AIRun.provider == 'elevenlabs'))).scalars().all()
        assert len(runs) == 3 and all(run.cost_estimate == Decimal('0.05') and run.status == 'completed' for run in runs)
    assert 'личная расшифровка' not in caplog.text and 'личный ответ' not in caplog.text


@pytest.mark.asyncio
async def test_voice_rejects_completion_and_skips_tts(paired, monkeypatch):
    owner, device_id, _ = paired
    owner_id = decode_token(owner['access_token'])['sub']
    await setup_voice(owner_id, device_id)
    async with db.SessionLocal() as session:
        task = Task(owner_id=owner_id, title='open')
        session.add(task)
        await session.commit()
        task_id = task.id
    service = FakeService({'id': 'call1', 'name': 'complete_task', 'input': {'task_id': task_id, 'version': 1}})
    sent = await execute_turn(monkeypatch, owner_id, device_id, 'reject', service)
    assert [x.get('state', x['type']) for x in sent] == ['thinking', 'voice_text', 'done']
    assert 'unknown tool' in repr(service.requests)
    async with db.SessionLocal() as session:
        assert (await session.get(Task, task_id)).status != 'done'


@pytest.mark.asyncio
async def test_voice_cancel_marks_reserved_run_failed(paired, monkeypatch):
    owner, device_id, _ = paired
    owner_id = decode_token(owner['access_token'])['sub']
    await setup_voice(owner_id, device_id)
    started = asyncio.Event()
    async def stt(*args):
        started.set()
        await asyncio.Event().wait()
    async def send(item):
        pass
    monkeypatch.setattr(voice, 'transcribe_pcm', stt)
    task = asyncio.create_task(voice.run_voice_turn(owner_id, device_id, 'cancel', b'00', False, send, send))
    await asyncio.wait_for(started.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    async with db.SessionLocal() as session:
        run = (await session.execute(select(AIRun).where(AIRun.idempotency_key.like('%:cancel')))).scalar_one()
        assert run.status == 'failed' and run.cost_estimate == Decimal('0.05')

@pytest.mark.asyncio
@pytest.mark.parametrize(('mode', 'expected'), [('unconfigured', 'VOICE_NOT_CONFIGURED'), ('budget', 'BUDGET_EXCEEDED'), ('empty', 'VOICE_EMPTY')])
async def test_voice_failure_branches(paired, monkeypatch, mode, expected):
    owner, device_id, _ = paired
    owner_id = decode_token(owner['access_token'])['sub']
    if mode != 'unconfigured':
        await setup_voice(owner_id, device_id)
    else:
        async with db.SessionLocal() as session:
            session.add(CompanionState(device_id=device_id, owner_id=owner_id))
            await session.commit()
    if mode == 'budget':
        async with db.SessionLocal() as session:
            provider = (await session.execute(select(AIProvider).where(AIProvider.kind == 'elevenlabs'))).scalar_one()
            provider.model_policy_json = {'monthly_budget': '0.01'}
            await session.commit()
    async def stt(*args):
        raise voice.VoiceError('VOICE_EMPTY')
    monkeypatch.setattr(voice, 'transcribe_pcm', stt)
    sent = []
    async def send(item):
        sent.append(item)
    await voice.run_voice_turn(owner_id, device_id, 'failure', b'00', False, send, send)
    assert sent[-1]['state'] == 'error' and sent[-1]['error_code'] == expected
    async with db.SessionLocal() as session:
        runs = (await session.execute(select(AIRun))).scalars().all()
        assert not any(run.provider == 'claude' for run in runs)
        assert all(run.status == 'failed' for run in runs)

@pytest.mark.asyncio
async def test_voice_lost_mode_during_chat_prevents_tool_and_accounts_usage(paired, monkeypatch):
    owner, device_id, _ = paired
    owner_id = decode_token(owner['access_token'])['sub']
    await setup_voice(owner_id, device_id)
    class LostService(FakeService):
        async def complete(self, *args, **kwargs):
            async with db.SessionLocal() as session:
                board = await session.get(CompanionState, device_id)
                board.lost_mode_json = {'on': True}
                await session.commit()
            return await super().complete(*args, **kwargs)
    service = LostService({'id': '1', 'name': 'create_task', 'input': {'title': 'must not exist'}})
    sent = await execute_turn(monkeypatch, owner_id, device_id, 'lost', service)
    assert sent[-1]['error_code'] == 'VOICE_UNAVAILABLE'
    async with db.SessionLocal() as session:
        assert not (await session.execute(select(Task).where(Task.title == 'must not exist'))).scalars().all()
        run = (await session.execute(select(AIRun).where(AIRun.provider == 'claude'))).scalar_one()
        assert run.status == 'failed' and run.cost_estimate == Decimal('0.01')
        assert run.token_counts['actual_cost'] == '0.01'


@pytest.mark.asyncio
async def test_voice_chat_budget_reservation_blocks_concurrent_turn(paired, monkeypatch):
    owner, device_id, _ = paired
    owner_id = decode_token(owner['access_token'])['sub']
    await setup_voice(owner_id, device_id)
    started, release = asyncio.Event(), asyncio.Event()
    class WaitingService(FakeService):
        async def complete(self, *args, **kwargs):
            started.set()
            await release.wait()
            return await super().complete(*args, **kwargs)
    service = WaitingService()
    first = asyncio.create_task(execute_turn(monkeypatch, owner_id, device_id, 'one', service))
    await asyncio.wait_for(started.wait(), 3)
    try:
        second = await execute_turn(monkeypatch, owner_id, device_id, 'two', FakeService())
        assert second[-1]['error_code'] == 'BUDGET_EXCEEDED'
    finally:
        release.set()
        await first

@pytest.mark.asyncio
async def test_session_revocation_stops_tool_and_preserves_usage(paired, monkeypatch):
    owner, device_id, _ = paired
    owner_id = decode_token(owner['access_token'])['sub']
    await setup_voice(owner_id, device_id)
    permitted = True
    class RevokedService(FakeService):
        async def complete(self, *args, **kwargs):
            nonlocal permitted
            permitted = False
            return await super().complete(*args, **kwargs)
    service = RevokedService({'id': '1', 'name': 'create_task', 'input': {'title': 'revoked task'}})
    monkeypatch.setattr(ai_api, '_service', lambda *args, **kwargs: service)
    async def stt(*args):
        return 'private speech'
    async def authorized(session):
        return permitted
    monkeypatch.setattr(voice, 'transcribe_pcm', stt)
    sent = []
    async def send(item):
        sent.append(item)
    await voice.run_voice_turn(owner_id, device_id, 'revoked', b'00', False, send, send, authorized=authorized)
    assert sent[-1]['state'] == 'error'
    async with db.SessionLocal() as session:
        assert not (await session.execute(select(Task).where(Task.title == 'revoked task'))).scalars().all()
        run = (await session.execute(select(AIRun).where(AIRun.provider == 'claude'))).scalar_one()
        assert run.status == 'failed' and run.cost_estimate == Decimal('0.01')


@pytest.mark.asyncio
async def test_voice_duplicate_turn_never_replays_provider(paired, monkeypatch):
    owner, device_id, _ = paired
    owner_id = decode_token(owner['access_token'])['sub']
    await setup_voice(owner_id, device_id)
    first = await execute_turn(monkeypatch, owner_id, device_id, 'same', FakeService())
    second_service = FakeService()
    second = await execute_turn(monkeypatch, owner_id, device_id, 'same', second_service)
    assert first[-1]['state'] == 'done'
    assert second[-1]['error_code'] == 'VOICE_UNAVAILABLE' and not second_service.requests
