"""Telegram progress, message-authorized cancellation and delivery lifecycle."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from app.ai import api as ai_api
from app.core.models import AIMessage, AIRun, Task
from app.integrations import telegram_guest as guest
from app.integrations import telegram_personal_dialogue as personal
from app.integrations import telegram_service as service
from app.integrations.telegram_models import (
    TelegramGuestJob,
    TelegramIntegration,
    TelegramPersonalJob,
)
from app.integrations.telegram_transport import TelegramClient
from sqlalchemy import select
from test_telegram_business import OWNER, TOKEN
from test_telegram_guest import _completion, guest_update
from test_telegram_personal_dialogue import Service, bound, ordinary, provider

pytest_plugins = ('test_telegram_business', 'test_domain_sync_postgres')


@pytest.mark.parametrize("is_guest", [False, True])
@pytest.mark.parametrize("stop", [False, True])
async def test_turn_edits_one_status_and_only_bound_owner_can_stop(setup, monkeypatch, is_guest, stop):
    from app.integrations.telegram_turn_progress import handle_turn_callback

    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    started = asyncio.Event()
    release = asyncio.Event()
    placeholder_open = asyncio.Event()
    release_placeholder = asyncio.Event()
    calls = []

    class Model(Service):
        async def complete(self, *args, **kwargs):
            started.set()
            await release.wait()
            if stop:
                return _completion(SimpleNamespace(text="", tool_calls=(
                    {"id": "write", "name": "create_task", "input": {"title": "after stop"}},
                )))
            return _completion(SimpleNamespace(text="Готовый ответ", tool_calls=()))

    async def telegram(request):
        method = request.url.path.rsplit("/", 1)[-1]
        calls.append((method, json.loads(request.content)))
        if method in {"answerGuestQuery", "sendMessage"}:
            placeholder_open.set()
            await release_placeholder.wait()
        response = {"inline_message_id": "our-inline"} if method == "answerGuestQuery" else (
            True if method == "answerCallbackQuery" or (is_guest and method == "editMessageText")
            else {"message_id": 123}
        )
        return httpx.Response(200, json={"ok": True, "result": response})

    monkeypatch.setattr(ai_api, "_service", lambda *a, **kw: Model())
    fake.updates = [
        guest_update(900, "@aelys_test_bot создай задачу aelys") if is_guest else ordinary(900, "Привет"),
    ]
    await service.poll_once(integration_id, timeout=0)
    monkeypatch.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
    start = guest.guest_iteration if is_guest else personal.personal_iteration
    finish = guest.wait_for_guest_turns if is_guest else personal.wait_for_personal_turns
    shutdown = guest.stop_guest_turns if is_guest else personal.stop_personal_turns
    await start(integration_id)
    try:
        await asyncio.wait_for(placeholder_open.wait(), 3)
        initial_method, initial = calls[0]
        assert initial_method == ("answerGuestQuery" if is_guest else "sendMessage")
        status = initial["result"]["input_message_content"] if is_guest else initial
        assert status["message_text" if is_guest else "text"].endswith("Как я ответил")
        assert status["entities"][-1]["url"].startswith("https://t.me/aelys_test_bot?startapp=run__")
        markup = (initial["result"] if is_guest else initial)["reply_markup"]
        [button] = markup["inline_keyboard"][0]
        assert button["text"] == "Остановить"
        target = {"inline_message_id": "our-inline"} if is_guest else {
            "message": {"message_id": 123, "chat": {"id": OWNER, "type": "private"},
                        "from": {"id": 1, "is_bot": True}},
        }
        callback = {"id": "cb", "from": {"id": OWNER, "is_bot": False},
                    "data": button["callback_data"], **target}

        async def handle(raw):
            async with sessions() as db, service.TelegramClient(TOKEN) as telegram_client:
                item = await db.get(TelegramIntegration, integration_id)
                return await handle_turn_callback(db, item, raw, telegram_client)

        assert await handle(callback)  # Telegram displays the button before the binding commit.
        assert calls[-1][1]["text"] == "Кнопка ещё готовится. Нажми ещё раз."
        release_placeholder.set()
        await asyncio.wait_for(started.wait(), 3)
        assert not await handle({**callback, "data": "other:operation"})
        assert await handle({**callback, "from": {"id": OWNER + 1, "is_bot": False}})
        wrong_target = {"inline_message_id": "other-inline"} if is_guest else {
            "message": {**target["message"], "message_id": 124},
        }
        assert await handle({**callback, **wrong_target})
        async with sessions() as db:
            assert (await db.scalars(select(AIRun))).one().status == "running"

        if stop:
            assert await handle(callback)
        else:
            release.set()
        await asyncio.wait_for(finish(), 3)
        assert await handle(callback)  # A stale button cannot change terminal state.
    finally:
        release_placeholder.set()
        release.set()
        await shutdown()

    edits = [payload for method, payload in calls if method == "editMessageText"]
    [terminal] = edits
    assert terminal["reply_markup"] == {"inline_keyboard": []}
    assert terminal["text"].startswith("Остановлено" if stop else "Готовый ответ")
    if stop:
        assert "Как я ответил" not in terminal["text"] and "entities" not in terminal
    assert sum(method == initial_method for method, _ in calls) == 1
    async with sessions() as db:
        run = (await db.scalars(select(AIRun))).one()
        job = (await db.scalars(select(TelegramGuestJob if is_guest else TelegramPersonalJob))).one()
        assert run.status == ("cancelled" if stop else "completed")
        assert job.state == ("failed" if stop else "done")
        assert not list(await db.scalars(select(Task)))
        assert bool(list(await db.scalars(select(AIMessage).where(AIMessage.role == "assistant")))) is not stop
        if is_guest:
            assert job.guest_query_id is None and job.delivery_status == "sent"


async def test_postgres_stop_serializes_tool_commit_and_guards_next_write(postgres_domain_sessions):
    from app.ai.crypto import encrypt_secret
    from app.ai.errors import RunCancelled
    from app.core.models import AIConversation
    from app.domains import capture
    from app.integrations.telegram_turn_progress import (
        TurnProgress,
        guard_running,
        handle_turn_callback,
    )
    from sqlalchemy import text

    sessions = postgres_domain_sessions
    async with sessions() as db:
        integration = TelegramIntegration(
            owner_id="owner", bot_id=1, bot_username="aelys_test_bot", bot_name="Aelys", business_capable=True,
            encrypted_token=encrypt_secret(TOKEN), owner_telegram_id=OWNER,
        )
        conversation = AIConversation(owner_id="owner")
        db.add_all([integration, conversation])
        await db.flush()
        run = AIRun(owner_id="owner", conversation_id=conversation.id, provider="claude",
                    model="test", status="running")
        db.add(run)
        await db.commit()
        ids = integration.id, run.id

    async def telegram(request):
        return httpx.Response(200, json={"ok": True, "result": True})

    async def stop():
        async with sessions() as db, TelegramClient(TOKEN, httpx.MockTransport(telegram)) as client:
            item = await db.get(TelegramIntegration, ids[0])
            return await handle_turn_callback(db, item, callback, client)

    callback = {
        "id": "stop-pg", "from": {"id": OWNER, "is_bot": False},
        "data": f"turn:stop:{ids[1]}", "inline_message_id": "pg-inline",
    }
    async with sessions() as worker:
        from app.integrations.telegram_turn_progress import _message_hash

        run = await worker.get(AIRun, ids[1])
        run.tool_scope_json = {"telegram_progress": {
            "integration_id": ids[0], "guest": True, "owner_chat": OWNER, "bot_id": 1,
            "message_hash": _message_hash("pg-inline"),
        }}
        assert TurnProgress.restore_guest(integration, run) is None
        await worker.commit()
        await guard_running(worker, ids[1], "owner")
        await capture.create_task(worker, "owner", title="already executing")
        stopping = asyncio.create_task(stop())
        try:
            async with sessions() as observer:
                for _ in range(200):
                    if await observer.scalar(text(
                        "SELECT count(*) FROM pg_locks WHERE NOT granted "
                        "AND locktype IN ('transactionid', 'tuple')"
                    )):
                        break
                    await asyncio.sleep(0.01)
                else:
                    pytest.fail("Stop never contended on the running tool transaction")
                assert not stopping.done()
                assert not list(await observer.scalars(select(Task)))
            await worker.commit()
            assert await asyncio.wait_for(stopping, 3)
            with pytest.raises(RunCancelled):
                await guard_running(worker, ids[1], "owner")
            await worker.rollback()
        finally:
            if not stopping.done():
                stopping.cancel()
                await asyncio.gather(stopping, return_exceptions=True)
    async with sessions() as db:
        assert [task.title for task in await db.scalars(select(Task))] == ["already executing"]
        assert (await db.get(AIRun, ids[1])).status == "cancelled"


async def test_guest_recovery_edits_original_message_without_resending(setup, monkeypatch):
    from app.core.models import Notification

    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    started = asyncio.Event()
    requests = []

    class Model(Service):
        async def complete(self, *args, **kwargs):
            started.set()
            await asyncio.Future()

    async def telegram(request):
        method = request.url.path.rsplit("/", 1)[-1]
        requests.append((method, json.loads(request.content)))
        result = {"inline_message_id": "durable-inline"} if method == "answerGuestQuery" else True
        return httpx.Response(200, json={"ok": True, "result": result})

    monkeypatch.setattr(ai_api, "_service", lambda *a, **kw: Model())
    fake.updates = [guest_update(901, "Ответь", query_id="recover-guest")]
    await service.poll_once(integration_id, timeout=0)
    monkeypatch.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
    await guest.guest_iteration(integration_id)
    try:
        await asyncio.wait_for(started.wait(), 3)
        async with sessions() as db:
            job = (await db.scalars(select(TelegramGuestJob))).one()
            assert job.guest_query_id is None and job.delivery_status == "sending"
            run = await db.get(AIRun, job.run_id)
            assert "durable-inline" not in json.dumps(run.tool_scope_json)
    finally:
        await guest.stop_guest_turns()

    await guest.fail_interrupted_guest_jobs()
    await guest.fail_interrupted_guest_jobs()
    assert [method for method, _ in requests] == ["answerGuestQuery", "editMessageText"]
    assert requests[-1][1]["inline_message_id"] == "durable-inline"
    assert requests[-1][1]["text"].startswith("Запрос прерван")
    assert requests[-1][1]["reply_markup"] == {"inline_keyboard": []}
    async with sessions() as db:
        job = (await db.scalars(select(TelegramGuestJob))).one()
        assert (job.state, job.error_code, job.guest_query_id) == ("failed", "AI_INTERRUPTED", None)
        assert (await db.get(AIRun, job.run_id)).status == "failed"
        assert len(list(await db.scalars(select(Notification)))) == 1


@pytest.mark.parametrize("is_guest", [False, True])
async def test_final_edit_timeout_does_not_send_a_second_answer(setup, monkeypatch, is_guest):
    from app.core.models import Notification

    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    model = Service()
    model.requests = []
    model.response = SimpleNamespace(text="Ответ", tool_calls=())
    requests = []

    async def telegram(request):
        method = request.url.path.rsplit("/", 1)[-1]
        requests.append(method)
        if method == "editMessageText":
            raise httpx.ReadTimeout("remote outcome unknown")
        result = {"inline_message_id": "inline"} if is_guest else {"message_id": 123}
        return httpx.Response(200, json={"ok": True, "result": result})

    monkeypatch.setattr(ai_api, "_service", lambda *a, **kw: model)
    fake.updates = [guest_update(902, "Ответь") if is_guest else ordinary(902, "Ответь")]
    await service.poll_once(integration_id, timeout=0)
    monkeypatch.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
    if is_guest:
        await guest.guest_iteration(integration_id)
        await guest.wait_for_guest_turns()
    else:
        await personal.personal_iteration(integration_id)
        await personal.wait_for_personal_turns()
    assert requests == ["answerGuestQuery" if is_guest else "sendMessage", "editMessageText", "editMessageText"]
    async with sessions() as db:
        assert (await db.scalars(select(AIRun))).one().status == "completed"
        assert len(list(await db.scalars(select(Notification)))) == 1
        if is_guest:
            assert (await db.scalars(select(TelegramGuestJob))).one().delivery_status == "unknown"


async def test_ambiguous_personal_placeholder_does_not_send_a_second_message(setup, monkeypatch):
    from app.core.models import Notification

    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    model = Service()
    model.requests = []
    model.response = SimpleNamespace(text="Ответ", tool_calls=())
    requests = []

    async def telegram(request):
        requests.append(request.url.path.rsplit("/", 1)[-1])
        raise httpx.ReadTimeout("placeholder outcome unknown")

    monkeypatch.setattr(ai_api, "_service", lambda *a, **kw: model)
    fake.updates = [ordinary(903, "Ответь")]
    await service.poll_once(integration_id, timeout=0)
    monkeypatch.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
    await personal.personal_iteration(integration_id)
    await personal.wait_for_personal_turns()
    assert requests == ["sendMessage"]
    async with sessions() as db:
        assert (await db.scalars(select(AIRun))).one().status == "completed"
        assert (await db.scalars(select(Notification))).one().kind == "telegram.personal.delivery"
