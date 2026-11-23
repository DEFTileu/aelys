"""The Telegram Bot API payload and delivery semantics for status emoji."""

import json

import httpx
import pytest
from app.core.models import AIConversation, AIRun
from app.integrations import telegram_service as service
from app.integrations.telegram_models import TelegramIntegration
from app.integrations.telegram_transport import TelegramClient
from app.integrations.telegram_turn_progress import TurnProgress
from test_telegram_personal import bound

pytest_plugins = ("test_telegram_business",)

THINKING = {"type": "custom_emoji", "offset": 0, "length": 2, "custom_emoji_id": "5188364800450670260"}
SEARCH = {"type": "custom_emoji", "offset": 0, "length": 2, "custom_emoji_id": "5199622193201333717"}


def message_content(payload):
    if "result" in payload:
        return payload["result"]["input_message_content"]
    return payload


def assert_status(payload, prefix, emoji):
    content = message_content(payload)
    text = content.get("text", content.get("message_text"))
    assert text.startswith(prefix)
    assert text.endswith("\n\nКак я ответил")
    trace = content["entities"][-1]
    assert trace["type"] == "text_link"
    assert trace["url"].startswith("https://t.me/aelys_test_bot?startapp=run__")
    assert trace["offset"] == len(text.removesuffix("Как я ответил").encode("utf-16-le")) // 2
    assert content["entities"] == ([emoji, trace] if emoji else [trace])


@pytest.fixture
async def turn(setup, monkeypatch):
    _, sessions, _, integration_id = await bound(setup)
    async with sessions() as db:
        item = await db.get(TelegramIntegration, integration_id)
        conversation = AIConversation(owner_id=item.owner_id)
        db.add(conversation)
        await db.flush()
        run = AIRun(owner_id=item.owner_id, conversation_id=conversation.id,
                    provider="claude", model="test", status="running")
        db.add(run)
        await db.commit()

        async def start(is_guest, *outcomes):
            calls = []
            responses = iter(outcomes)

            async def telegram(request):
                method = request.url.path.rsplit("/", 1)[-1]
                calls.append((method, json.loads(request.content)))
                outcome = next(responses, 200)
                if outcome == "timeout":
                    raise httpx.ReadTimeout("unknown outcome")
                if outcome == "network":
                    raise httpx.ReadError("unknown outcome")
                if outcome != 200:
                    return httpx.Response(outcome, json={"ok": False, "error_code": outcome})
                if method == "answerGuestQuery":
                    result = {"inline_message_id": "inline-target"}
                elif is_guest:
                    result = True
                else:
                    result = {"message_id": 123}
                return httpx.Response(200, json={"ok": True, "result": result})

            monkeypatch.setattr(service, "TelegramClient",
                                lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
            progress = TurnProgress(guest=is_guest)
            await progress.start(db, item, run, guest_query_id="guest-query" if is_guest else None)
            return progress, calls

        yield start


@pytest.mark.parametrize("is_guest", [False, True])
async def test_status_emoji_sent_on_start_and_search(turn, is_guest):
    progress, calls = await turn(is_guest)
    await progress.search("трактор *синий*", known_secrets=())
    assert await progress.finish("🤔 Ответ")
    assert [method for method, _ in calls] == [
        "answerGuestQuery" if is_guest else "sendMessage", "editMessageText", "editMessageText",
    ]
    assert_status(calls[0][1], "🤔 Готовлю ответ…", THINKING)
    assert_status(calls[1][1], "🔍 Поиск в вебе: трактор *синий*", SEARCH)
    assert "entities" not in calls[2][1]
    assert calls[2][1]["reply_markup"] == {"inline_keyboard": []}


@pytest.mark.parametrize("is_guest", [False, True])
@pytest.mark.parametrize("initial", [False, True])
async def test_400_strips_only_custom_emoji_and_disables_it_for_the_turn(turn, is_guest, initial):
    progress, calls = await turn(is_guest, *([400, 200] if initial else [200, 400, 200]))
    await progress.search("первый", known_secrets=())
    await progress.search("второй", known_secrets=())
    rejection = 0 if initial else 1
    assert len(calls) == 4
    method, first = calls[rejection]
    retry_method, retry = calls[rejection + 1]
    assert method == retry_method
    prefix = "🤔 Готовлю ответ…" if initial else "🔍 Поиск в вебе: первый"
    assert_status(first, prefix, THINKING if initial else SEARCH)
    assert_status(retry, prefix, None)
    message_content(first)["entities"].pop(0)
    assert first == retry
    assert_status(calls[-1][1], "🔍 Поиск в вебе: второй", None)


@pytest.mark.parametrize("is_guest", [False, True])
@pytest.mark.parametrize("outcomes", [("timeout",), ("network",), (500,), (400, 400), (400, "timeout")])
async def test_initial_progress_attempts_are_bounded(turn, is_guest, outcomes):
    progress, calls = await turn(is_guest, *outcomes)
    assert [method for method, _ in calls] == [
        "answerGuestQuery" if is_guest else "sendMessage",
    ] * len(outcomes)
    assert progress.message is None
    assert progress.delivery_status == ("failed" if outcomes[-1] == 400 else "unknown")
    if outcomes[0] == 400:
        assert_status(calls[1][1], "🤔 Готовлю ответ…", None)
