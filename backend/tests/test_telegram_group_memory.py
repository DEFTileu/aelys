from types import SimpleNamespace

from app.ai import api as ai_api
from app.ai.models import ProviderKind, Usage
from app.integrations import telegram_service as service
from sqlalchemy import select, text
from test_telegram_business import OWNER
from test_telegram_personal import bound
from test_telegram_personal_dialogue import Service, provider

pytest_plugins = ("test_telegram_business",)


def group(update_id, body, *, room=-100123, sender=OWNER, edit=False, reply=None, topic=None):
    message = {
        "chat": {"id": room, "type": "supergroup"},
        "message_id": update_id, "from": {"id": sender, "first_name": "Участник", "is_bot": False},
        "text": body, "date": 1795622400,
    }
    if reply:
        message["reply_to_message"] = {"from": {"id": reply, "is_bot": True}, "message_id": 500}
    if topic:
        message.update(is_topic_message=True, message_thread_id=topic)
    return {"update_id": update_id, "edited_message" if edit else "message": message}


async def test_group_uses_only_enabled_room_and_topic_history_to_answer_any_member(setup, monkeypatch):
    from app.integrations.telegram_group import group_iteration
    from app.integrations.telegram_models import TelegramGroupMessage

    client, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    async def send(self, chat_id, content, **kwargs):
        self.sent.append((chat_id, content, kwargs))
        return {"message_id": 500 + len(self.sent)}

    monkeypatch.setattr(fake, "send_message", send)
    model = Service()
    model.requests = []
    monkeypatch.setattr(ai_api, "_service", lambda *args, **kwargs: model)
    fake.updates = [
        group(10, "До подключения"),
        group(11, "/aelys_enable@aelys_test_bot", room=-100456, sender=888),
        group(12, "Не подключено", room=-100456),
        group(13, "/aelys_enable@aelys_test_bot"),
        group(14, "Договорились встретиться вечером", sender=888, topic=10),
        group(15, "Детали другой темы", sender=888, topic=11),
        group(16, "@aelys_test_bot О чём договорились?", sender=777, topic=10),
    ]
    await service.poll_once(integration_id, timeout=0)
    await group_iteration(integration_id)
    await group_iteration(integration_id)

    assert len(model.requests) == 1
    messages, request = model.requests[0]
    assert "Договорились встретиться вечером" in "\n".join(m.content for m in messages if m.untrusted)
    assert "Детали другой темы" not in str(messages) and "Не подключено" not in str(messages)
    assert {tool["name"] for tool in request["tools"]} == {"get_weather", "get_exchange_rate", "read_group_history"}
    assert fake.sent[-1] == (-100123, "Ответ", {"reply_to_message_id": 16, "message_thread_id": 10, "entities": []})
    assert (await client.get("/api/v1/ai/conversations")).json() == []
    async with sessions() as db:
        texts = set((await db.scalars(select(TelegramGroupMessage.body))).all())
        assert {"Договорились встретиться вечером", "Детали другой темы", "Ответ"} <= texts
        assert "До подключения" not in texts and "Не подключено" not in texts
        encrypted = await db.scalar(text("SELECT body FROM telegram_group_messages WHERE message_id = 14"))
        assert encrypted and "Договорились" not in encrypted


async def test_group_disable_erases_archive_and_blocks_later_messages(setup):
    from app.integrations.telegram_group import group_iteration
    from app.integrations.telegram_models import TelegramGroup, TelegramGroupMessage

    _, sessions, fake, integration_id = await bound(setup)
    fake.updates = [
        group(10, "/aelys_enable@aelys_test_bot"),
        group(11, "Сообщение группы"),
        group(12, "/aelys_disable@aelys_test_bot"),
        group(13, "После отключения"),
    ]
    await service.poll_once(integration_id, timeout=0)
    await group_iteration(integration_id)
    async with sessions() as db:
        assert (await db.scalars(select(TelegramGroup))).all() == []
        assert (await db.scalars(select(TelegramGroupMessage))).all() == []


async def test_group_reply_can_find_an_edited_message_outside_recent_context(setup, monkeypatch):
    from app.integrations.telegram_group import group_iteration

    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)

    class Model(Service):
        async def complete(self, _run_id, _request, messages, **kwargs):
            self.requests.append(messages)
            if len(self.requests) == 1:
                assert "Уточнённый адрес" not in str(messages)
                reply = SimpleNamespace(text="", tool_calls=({
                    "id": "read-history", "name": "read_group_history", "input": {"query": "Уточнённый адрес"},
                },))
            else:
                assert "Площадь Республики" in messages[-1].content and messages[-1].untrusted
                assert "Старая площадь" not in messages[-1].content
                reply = SimpleNamespace(text="Площадь Республики.", tool_calls=())
            return SimpleNamespace(provider=ProviderKind.CLAUDE, model="test", response=reply,
                                   usage=SimpleNamespace(usage=Usage(5, 2), estimated_cost=0))

    model = Model()
    model.requests = []
    monkeypatch.setattr(ai_api, "_service", lambda *args, **kwargs: model)
    original = group(11, "Старая площадь", sender=888)
    edit = group(11, "Уточнённый адрес: Площадь Республики", sender=888, edit=True)
    edit["update_id"] = 35
    fake.updates = [
        group(10, "/aelys_enable@aelys_test_bot"), original,
        *(group(index, "Обычное сообщение", sender=888) for index in range(12, 35)),
        edit, group(36, "Где встречаемся?", sender=777, reply=1),
    ]
    await service.poll_once(integration_id, timeout=0)
    for _ in range(3):
        await group_iteration(integration_id)
    assert len(model.requests) == 2
    assert fake.sent[-1] == (
        -100123, "Площадь Республики.", {"reply_to_message_id": 36, "message_thread_id": None, "entities": []},
    )
