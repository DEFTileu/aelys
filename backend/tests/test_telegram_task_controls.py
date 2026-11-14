from datetime import timedelta

import pytest
from app.core.models import AIAction, AIConversation, AIRun, now
from app.integrations import telegram_service as service
from app.integrations.telegram_models import (
    TelegramBusinessMessage,
    TelegramIntegration,
)
from sqlalchemy import select
from test_telegram_business import OWNER, connect, connection, message, set_bound

pytest_plugins = ("test_telegram_business",)


async def bound(setup):
    client, sessions, fake = setup
    integration = await connect(client)
    await set_bound(sessions, integration["id"])
    fake.updates = [
        {"update_id": 1, "business_connection": connection()},
        message(2, "Please send the draft tomorrow"),
    ]
    await service.poll_once(integration["id"], timeout=0)
    return client, sessions, fake, integration["id"]


async def create_action(sessions, integration_id, *, expires_at=None):
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        source = (await db.execute(select(TelegramBusinessMessage).where(
            TelegramBusinessMessage.integration_id == integration_id,
        ))).scalar_one()
        conversation = AIConversation(owner_id=item.owner_id, title="Task suggestion")
        db.add(conversation)
        await db.flush()
        run = AIRun(owner_id=item.owner_id, conversation_id=conversation.id, provider="test", model="test",
            status="completed", tool_scope_json={
                "feature": "telegram_task_suggestion", "integration_id": integration_id,
                "source_id": source.id,
            })
        db.add(run)
        await db.flush()
        action = AIAction(owner_id=item.owner_id, conversation_id=conversation.id, run_id=run.id,
            tool="create_task", arguments_json={"title": "Send draft", "description": "", "project_id": None,
                "due_at": None, "due_timezone": None}, title="Create task", summary="", items_json=[],
            source_kind="telegram_task_suggestion", source_id=source.id, expires_at=expires_at)
        db.add(action)
        await db.commit()
        return action.id


def callback(update_id, action_id, *, sender=OWNER, chat_id=OWNER, chat_type="private", bot_id=1,
             data_action="a", bot_sender=True):
    return {"update_id": update_id, "callback_query": {
        "id": f"query-{update_id}", "from": {"id": sender, "is_bot": False},
        "message": {"message_id": 500, "chat": {"id": chat_id, "type": chat_type},
                    "from": {"id": bot_id, "is_bot": bot_sender}},
        "data": f"ats:{data_action}:{action_id}",
    }}


async def test_owner_can_enable_one_known_chat_and_status_has_attempts_not_pending_list(setup):
    _, sessions, fake, integration_id = await bound(setup)
    fake.updates = [{"update_id": 3, "message": {
        "text": "/task_suggestions on 222", "from": {"id": OWNER, "is_bot": False},
        "chat": {"id": OWNER, "type": "private"},
    }}]
    assert await service.poll_once(integration_id, timeout=0) == 1
    assert "включ" in fake.sent[-1][1].casefold()
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        assert item.task_suggestions_chat_id == 222
        enabled_at = item.task_suggestions_enabled_at
        assert enabled_at is not None
        assert item.version > 1
    first_enabled_at = enabled_at
    fake.updates = [{"update_id": 4, "message": {
        "text": "/task_suggestions", "from": {"id": OWNER, "is_bot": False},
        "chat": {"id": OWNER, "type": "private"},
    }}]
    await service.poll_once(integration_id, timeout=0)
    assert "222" in fake.sent[-1][1]
    assert "20" in fake.sent[-1][1]
    assert "pending" not in fake.sent[-1][1].casefold()
    fake.updates = [{"update_id": 5, "message": {
        "text": "/task_suggestions on 222", "from": {"id": OWNER, "is_bot": False},
        "chat": {"id": OWNER, "type": "private"},
    }}]
    await service.poll_once(integration_id, timeout=0)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        assert item.task_suggestions_enabled_at == first_enabled_at


async def test_enable_rejects_unknown_chat_without_changing_configuration(setup):
    _, sessions, fake, integration_id = await bound(setup)
    fake.updates = [{"update_id": 3, "message": {
        "text": "/task_suggestions on 999", "from": {"id": OWNER, "is_bot": False},
        "chat": {"id": OWNER, "type": "private"},
    }}]
    await service.poll_once(integration_id, timeout=0)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        assert item.task_suggestions_chat_id is None and item.task_suggestions_enabled_at is None
    assert "не найден" in fake.sent[-1][1].casefold()


async def test_approve_callback_through_poll_commits_task_before_answer_and_removes_buttons(setup, monkeypatch):
    client, sessions, fake, integration_id = await bound(setup)
    action_id = await create_action(sessions, integration_id, expires_at=now() + timedelta(hours=1))
    fake.updates = [callback(3, action_id)]
    effects = []

    async def answer(self, query_id, text=None):
        effects.append(("answer", query_id, text, len((await client.get("/api/v1/tasks")).json())))
        return True

    async def remove(self, chat_id, message_id, reply_markup=None):
        effects.append(("remove", chat_id, message_id, reply_markup))
        return {"message_id": message_id}

    monkeypatch.setattr(fake, "answer_callback_query", answer, raising=False)
    monkeypatch.setattr(fake, "edit_message_reply_markup", remove, raising=False)
    assert await service.poll_once(integration_id, timeout=0) == 1
    tasks = (await client.get("/api/v1/tasks")).json()
    assert len(tasks) == 1 and tasks[0]["title"] == "Send draft"
    assert effects[0][0] == "answer" and effects[0][3] == 1
    assert effects[1] == ("remove", OWNER, 500, {"inline_keyboard": []})
    async with sessions() as db:
        action = await db.get(AIAction, action_id)
        assert action.status == "approved" and action.result_json["kind"] == "task"


@pytest.mark.parametrize("patch", [
    {"sender": 999}, {"chat_id": 999}, {"chat_type": "group"}, {"bot_id": 999},
    {"bot_sender": False},
])
async def test_forged_callback_identity_does_not_create_task_or_answer(setup, monkeypatch, patch):
    client, sessions, fake, integration_id = await bound(setup)
    action_id = await create_action(sessions, integration_id, expires_at=now() + timedelta(hours=1))
    fake.updates = [callback(3, action_id, **patch)]
    answers = []
    async def answer(self, query_id, text=None):
        answers.append((query_id, text))
        return True
    monkeypatch.setattr(fake, "answer_callback_query", answer, raising=False)
    await service.poll_once(integration_id, timeout=0)
    assert (await client.get("/api/v1/tasks")).json() == []
    assert not answers
    async with sessions() as db:
        assert (await db.get(AIAction, action_id)).status == "pending"


async def test_expired_callback_expires_without_running_tool(setup, monkeypatch):
    client, sessions, fake, integration_id = await bound(setup)
    action_id = await create_action(sessions, integration_id, expires_at=now() - timedelta(seconds=1))
    fake.updates = [callback(3, action_id)]
    answers = []
    async def answer(self, query_id, text=None):
        answers.append((query_id, text))
        return True
    async def remove(self, chat_id, message_id, reply_markup=None):
        return {"message_id": message_id}
    monkeypatch.setattr(fake, "answer_callback_query", answer, raising=False)
    monkeypatch.setattr(fake, "edit_message_reply_markup", remove, raising=False)
    await service.poll_once(integration_id, timeout=0)
    assert (await client.get("/api/v1/tasks")).json() == []
    assert "ист" in answers[0][1].casefold()
    async with sessions() as db:
        action = await db.get(AIAction, action_id)
        assert action.status == "failed"
        assert action.result_json["error"]["code"] == "ACTION_EXPIRED"
