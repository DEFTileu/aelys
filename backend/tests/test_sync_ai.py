import pytest
from app.ai.service import EncryptedMemorySecretStore, Model, ModelRouter, sse_events
from app.sync.api import Operation


def test_sync_rejects_private_agent_content():
    with pytest.raises(ValueError):
        Operation(device_id="d", resource_kind="agent_session", resource_id="r", action="create", patch={"transcript":"secret"})
def test_router_and_secret_store():
    store = EncryptedMemorySecretStore(b"x"*32); store.put("k", "secret"); assert store.get("k") == "secret"
    model = ModelRouter().choose([Model("claude", "cheap", frozenset({"tools"}), .01)], required=frozenset({"tools"})); assert model.name == "cheap"
@pytest.mark.asyncio
async def test_sse_completion():
    class P:
        async def stream(self, model, messages):
            yield "hi"
    events = [x async for x in sse_events("r", P(), Model("p", "m", frozenset(), 0), [])]
    assert "ai.run.started" in events[0] and "ai.run.completed" in events[-1]
