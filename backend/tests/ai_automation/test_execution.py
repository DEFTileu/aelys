from decimal import Decimal
from uuid import uuid4
import pytest
from app.ai.execution import AIExecutionService
from app.ai.crypto import decrypt_secret, encrypt_secret
from app.ai.models import ChatMessage, ModelSpec, ProviderKind, ProviderResponse, RoutingRequest, TaskKind, Capability, PrivacyClass, Usage
from app.core.config import get_settings

class FakeAdapter:
    kind=ProviderKind.CLAUDE
    async def complete(self, request): return ProviderResponse("ok", Usage(2,3))
    async def stream(self, request):
        yield "o"; yield "k"

@pytest.mark.asyncio
async def test_execution_routes_records_decimal_usage_and_streams():
    model=ModelSpec(ProviderKind.CLAUDE,"claude-test",frozenset({Capability.STREAMING}),4096,Decimal("0.01"),Decimal("0.02"),privacy_classes=frozenset({PrivacyClass.PERSONAL}))
    service=AIExecutionService([model],{ProviderKind.CLAUDE:FakeAdapter()})
    request=RoutingRequest(TaskKind.SUMMARY,privacy=PrivacyClass.PERSONAL,request_budget=Decimal("1"))
    run=uuid4(); result=await service.complete(run,request,(ChatMessage("user","hello"),)); assert result.response.text=="ok" and result.usage.estimated_cost==Decimal("0.00008")
    events=[x async for x in service.stream_sse(uuid4(),request,(ChatMessage("user","hello"),))]
    assert "ai.text.delta" in "".join(events) and "ai.run.completed" in events[-1]

@pytest.mark.asyncio
async def test_execution_never_sends_local_only_data_to_external_models():
    model=ModelSpec(ProviderKind.CLAUDE,"external",frozenset(),4096,Decimal("0.01"),Decimal("0.01"),privacy_classes=frozenset({PrivacyClass.PERSONAL}))
    service=AIExecutionService([model],{ProviderKind.CLAUDE:FakeAdapter()})
    request=RoutingRequest(TaskKind.LOCAL_SESSION,privacy=PrivacyClass.LOCAL_ONLY)
    events=[x async for x in service.stream_sse(uuid4(),request,(ChatMessage("user","private"),))]
    assert "MODEL_UNAVAILABLE" in "".join(events)

@pytest.mark.asyncio
async def test_execution_honors_durable_cancellation_check():
    model=ModelSpec(ProviderKind.CLAUDE,"claude-test",frozenset({Capability.STREAMING}),4096,Decimal("0.01"),Decimal("0.02"),privacy_classes=frozenset({PrivacyClass.PERSONAL}))
    service=AIExecutionService([model],{ProviderKind.CLAUDE:FakeAdapter()})
    request=RoutingRequest(TaskKind.SUMMARY,privacy=PrivacyClass.PERSONAL,request_budget=Decimal("1"))
    events=[x async for x in service.stream_sse(uuid4(),request,(ChatMessage("user","hello"),),cancel_check=lambda: _cancelled())]
    assert "ai.run.cancelled" in events[-1] and "ai.run.completed" not in "".join(events)

async def _cancelled() -> bool:
    return True

def test_provider_secret_envelope_is_authenticated_and_not_plaintext():
    encrypted=encrypt_secret("sk-live-example-1234")
    assert "sk-live-example" not in encrypted
    assert decrypt_secret(encrypted)=="sk-live-example-1234"

def test_provider_secret_can_use_a_separate_encryption_key(monkeypatch):
    monkeypatch.setenv("AELYS_PROVIDER_ENCRYPTION_KEY", "p" * 32)
    get_settings.cache_clear()
    encrypted = encrypt_secret("provider-secret")
    assert decrypt_secret(encrypted) == "provider-secret"
    monkeypatch.setenv("AELYS_PROVIDER_ENCRYPTION_KEY", "q" * 32)
    get_settings.cache_clear()
    with pytest.raises(Exception):
        decrypt_secret(encrypted)
    get_settings.cache_clear()

def test_provider_secret_can_be_reencrypted_between_key_versions():
    old_key = "o" * 32
    new_key = "n" * 32
    encrypted = encrypt_secret("provider-secret", old_key)
    rotated = encrypt_secret(decrypt_secret(encrypted, old_key), new_key)
    assert decrypt_secret(rotated, new_key) == "provider-secret"
    with pytest.raises(Exception):
        decrypt_secret(rotated, old_key)
