from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from app.ai.crypto import encrypt_secret
from app.ai.models import PrivacyClass, TaskKind
from app.core.db import Base
from app.core.models import (
    AIConversation,
    AIMessage,
    AIProvider,
    AIProviderSecret,
    AIRun,
    User,
)
from app.integrations import telegram_ai
from app.integrations.telegram_models import (
    TelegramBusinessMessage,
    TelegramIntegration,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def state(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/telegram-ai.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as db:
        db.add_all([User(id="owner"), User(id="other")])
        provider = AIProvider(id="provider", owner_id="owner", kind="claude", enabled=True, model_policy_json={"monthly_budget": "20"})
        db.add(provider)
        db.add(AIProviderSecret(provider_id="provider", owner_id="owner", encrypted_value=encrypt_secret("provider-key-secret")))
        integration = TelegramIntegration(id="integration", owner_id="owner", bot_id=1, bot_username="bot", bot_name="Bot", business_capable=True, provider_id="provider", model="model-x", instructions="Be concise", encrypted_token="bot-token-secret")
        db.add(integration)
        now = datetime.now(UTC)
        target = TelegramBusinessMessage(id="target", owner_id="owner", integration_id="integration", business_connection_id="connection", chat_id=10, telegram_message_id=30, sent_at=now, text="customer question", direction="inbound")
        db.add(target)
        for i in range(14):
            db.add(TelegramBusinessMessage(id=f"history-{i}", owner_id="owner", integration_id="integration", business_connection_id="connection", chat_id=10, telegram_message_id=i, sent_at=now-timedelta(minutes=14-i), text=f"history-{i}", direction="outbound" if i == 13 else "inbound"))
        db.add_all([
            TelegramBusinessMessage(id="foreign-chat", owner_id="owner", integration_id="integration", business_connection_id="connection", chat_id=11, telegram_message_id=31, sent_at=now, text="private other chat", direction="inbound"),
            TelegramBusinessMessage(id="foreign-owner", owner_id="other", integration_id="integration", business_connection_id="connection", chat_id=10, telegram_message_id=32, sent_at=now, text="private other owner", direction="inbound"),
            TelegramBusinessMessage(id="deleted", owner_id="owner", integration_id="integration", business_connection_id="connection", chat_id=10, telegram_message_id=29, sent_at=now, deleted_at=now, text="deleted secret", direction="inbound"),
        ])
        await db.commit()
        calls = []
        result = SimpleNamespace(provider=SimpleNamespace(value="claude"), model="model-x", response=SimpleNamespace(text="A helpful reply", tool_calls=()), usage=SimpleNamespace(usage=SimpleNamespace(input_tokens=10, output_tokens=4), estimated_cost=Decimal("0.012")))
        class FakeService:
            async def complete(self, run_id, request, messages, **kwargs):
                calls.append((run_id, request, messages, kwargs))
                return result
        def service(configured, key):
            assert configured.id == "provider" and key == "provider-key-secret"
            return FakeService()
        monkeypatch.setattr(telegram_ai.ai_api, "_service", service)
        yield db, integration, target, calls, result
    await engine.dispose()


@pytest.mark.asyncio
async def test_context_isolation_policy_and_usage(state, monkeypatch):
    db, integration, target, calls, _ = state
    authorizations = []
    original = telegram_ai.ServerPolicyEngine.authorize
    def authorize(self, descriptor, call, context):
        authorizations.append((descriptor, call, context))
        return original(self, descriptor, call, context)
    monkeypatch.setattr(telegram_ai.ServerPolicyEngine, "authorize", authorize)
    assert await telegram_ai.generate_business_draft(db, integration, target) == "A helpful reply"
    _, request, messages, kwargs = calls[0]
    assert request.task_kind == TaskKind.UNKNOWN and request.privacy == PrivacyClass.PERSONAL
    assert request.manual_model == "model-x" and request.request_budget == Decimal(20)
    assert kwargs == {"max_tokens": 800, "tools": ()}
    assert len(messages) == 13 and messages[-1].content == "customer question"
    system = messages[0].content
    assert "Never invent business facts, prices, opening hours, schedules" in system
    assert "ask the customer for clarification" in system
    assert "owner will follow up" in system and "Identify yourself as an assistant" in system
    assert messages[-2].role == "assistant" and messages[-1].untrusted
    contents = repr(messages)
    for forbidden in ("private other chat", "private other owner", "deleted secret", "provider-key-secret", "bot-token-secret", "history-0"):
        assert forbidden not in contents
    descriptor, call, context = authorizations[0]
    assert descriptor.name == call.name == "telegram.ai" and descriptor.external_effect
    assert context.scopes == frozenset({"telegram.ai"}) and context.allow_external_effects
    assert (await db.execute(select(AIMessage))).scalars().all() == []
    run = (await db.execute(select(AIRun))).scalar_one()
    assert run.prompt_message_id is None and run.token_counts == {"input": 10, "output": 4}
    assert run.cost_estimate == Decimal("0.012") and run.tool_scope_json == {}
    assert (await db.execute(select(AIConversation))).scalar_one().title == "TelegramBusiness"
    await db.rollback()
    assert (await db.execute(select(AIRun))).scalars().all() == []


@pytest.mark.asyncio
@pytest.mark.parametrize("condition", ["missing", "foreign", "disabled", "deleted", "secret_missing", "secret_foreign"])
async def test_provider_must_be_owned_enabled_and_have_owned_secret(state, condition):
    db, integration, target, calls, _ = state
    provider = await db.get(AIProvider, "provider")
    secret = await db.get(AIProviderSecret, "provider")
    if condition == "missing": integration.provider_id = None
    elif condition == "foreign": provider.owner_id = "other"
    elif condition == "disabled": provider.enabled = False
    elif condition == "deleted": provider.deleted_at = datetime.now(UTC)
    elif condition == "secret_missing": await db.delete(secret); await db.flush()
    else: secret.owner_id = "other"
    with pytest.raises(telegram_ai.TelegramAIError, match="PROVIDER_REQUIRED") as exc:
        await telegram_ai.generate_business_draft(db, integration, target)
    assert exc.value.code == "PROVIDER_REQUIRED" and not calls


@pytest.mark.asyncio
async def test_budget_and_message_scope(state):
    db, integration, target, calls, _ = state
    provider = await db.get(AIProvider, "provider")
    provider.model_policy_json = {"monthly_budget": "0"}
    with pytest.raises(telegram_ai.TelegramAIError, match="BUDGET_EXCEEDED"):
        await telegram_ai.generate_business_draft(db, integration, target)
    assert not calls
    target.owner_id = "other"
    with pytest.raises(telegram_ai.TelegramAIError, match="AI_UNAVAILABLE"):
        await telegram_ai.generate_business_draft(db, integration, target)


@pytest.mark.asyncio
@pytest.mark.parametrize("text,tool_calls", [("", ()), ("   ", ()), ("x" * 4097, ()), ("valid", ({"name": "delete"},))])
async def test_bad_answers_are_rejected_but_usage_recorded(state, text, tool_calls):
    db, integration, target, _, result = state
    result.response.text = text
    result.response.tool_calls = tool_calls
    with pytest.raises(telegram_ai.TelegramAIError, match="AI_UNAVAILABLE"):
        await telegram_ai.generate_business_draft(db, integration, target)
    assert (await db.execute(select(AIRun))).scalar_one().cost_estimate == Decimal("0.012")
    assert (await db.execute(select(AIMessage))).scalars().all() == []


@pytest.mark.asyncio
async def test_errors_are_redacted_and_instructions_bounded(state, monkeypatch):
    db, integration, target, calls, _ = state
    integration.instructions = "x" * 10001
    with pytest.raises(telegram_ai.TelegramAIError, match="AI_UNAVAILABLE"):
        await telegram_ai.generate_business_draft(db, integration, target)
    assert not calls
    integration.instructions = "Be helpful"
    def explode(*args):
        raise RuntimeError("provider-key-secret customer question")
    monkeypatch.setattr(telegram_ai.ai_api, "_service", explode)
    with pytest.raises(telegram_ai.TelegramAIError) as exc:
        await telegram_ai.generate_business_draft(db, integration, target)
    assert str(exc.value) == "AI_UNAVAILABLE" and exc.value.__cause__ is None


@pytest.mark.asyncio
async def test_sent_draft_history_future_exclusion_and_context_limit(state):
    db, integration, target, calls, _ = state
    previous = await db.get(TelegramBusinessMessage, "history-13")
    previous.direction = "inbound"
    previous.text = "Earlier customer"
    previous.draft_status = "sent"
    previous.draft_text = "Earlier sent reply"
    await db.flush()
    previous.updated_at = target.sent_at - timedelta(seconds=1)
    later_reply = await db.get(TelegramBusinessMessage, "history-12")
    later_reply.draft_status = "sent"
    later_reply.draft_text = "Reply sent after target"
    await db.flush()
    later_reply.updated_at = target.sent_at + timedelta(seconds=1)
    db.add(TelegramBusinessMessage(id="future", owner_id="owner", integration_id="integration", business_connection_id="connection", chat_id=10, telegram_message_id=31, sent_at=target.sent_at + timedelta(seconds=1), text="future secret", direction="inbound"))
    await db.flush()
    await telegram_ai.generate_business_draft(db, integration, target)
    turns = [(m.role, m.content) for m in calls[-1][2]]
    index = turns.index(("user", "Earlier customer"))
    assert turns[index + 1] == ("assistant", "Earlier sent reply")
    assert "Reply sent after target" not in repr(turns)
    assert "future secret" not in repr(turns)

    target.text = "Z" * 40000
    await db.flush()
    await telegram_ai.generate_business_draft(db, integration, target)
    messages = calls[-1][2]
    assert sum(len(m.content) for m in messages) == 30000
    assert messages[-1].role == "user" and messages[-1].content == "Z" * (30000 - len(messages[0].content))
