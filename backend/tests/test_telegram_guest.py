"""End-to-end and unit coverage for Telegram Guest Mode and its Answer Trace."""
from __future__ import annotations

import json
import logging
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from app.ai import api as ai_api
from app.ai.memory import forget, remember
from app.ai.models import ProviderKind, Usage
from app.core.models import AIConversation, AIRun, Notification, Task, now
from app.integrations import telegram_guest as guest
from app.integrations import telegram_service as service
from app.integrations.telegram_answer_format import TRACE_LABEL, single_answer_message
from app.integrations.telegram_models import TelegramGuestJob, TelegramIntegration
from app.integrations.telegram_transport import TelegramClient
from sqlalchemy import select
from test_telegram_answer_trace import headers, signed
from test_telegram_business import OWNER, TOKEN
from test_telegram_personal import bound
from test_telegram_personal_dialogue import Service, provider

pytest_plugins = ("test_telegram_business",)


def guest_update(
    update_id: int,
    text: str,
    *,
    query_id: str | None = None,
    user_id: int = OWNER,
    username: str = "owner_user",
    is_bot: bool = False,
    chat_id: int = -100999888,
    chat_type: str = "supergroup",
    message_id: int = 10,
    extra: dict | None = None,
) -> dict:
    message: dict = {
        "message_id": message_id,
        "guest_query_id": query_id if query_id is not None else f"gq-{update_id}",
        "from": {"id": user_id, "is_bot": is_bot, "username": username, "first_name": "Owner"},
        "guest_bot_caller_user": {"id": user_id, "is_bot": is_bot, "username": username},
        "guest_bot_caller_chat": {"id": chat_id, "type": chat_type, "title": "Shared chat"},
        "chat": {"id": chat_id, "type": chat_type, "title": "Shared chat"},
        "date": int(now().timestamp()),
        "text": text,
    }
    if extra:
        message.update(extra)
    return {"update_id": update_id, "guest_message": message}


def _completion(response, *, model: str = "claude-test"):
    return SimpleNamespace(
        provider=ProviderKind.CLAUDE,
        model=model,
        response=response,
        usage=SimpleNamespace(usage=Usage(10, 5), estimated_cost=Decimal("0.01")),
    )


def entity_text(text: str, entity: dict) -> str:
    start = 2 * entity["offset"]
    end = start + 2 * entity["length"]
    return text.encode("utf-16-le")[start:end].decode("utf-16-le")


async def _finish_guest(integration_id: str) -> None:
    await guest.guest_iteration(integration_id)
    await guest.wait_for_guest_turns()


@pytest.mark.parametrize(
    ("text", "expected_unlocked", "expected_prompt"),
    [
        ("@aelys_ibot создай задачу купить молоко aelys", True, "создай задачу купить молоко"),
        ("@aelys_ibot какие у меня задачи на завтра AELYS   ", True, "какие у меня задачи на завтра"),
        ("@aelys_ibot   проверь заметки AeLyS\n  ", True, "проверь заметки"),
        ("создай задачу купить молоко aelys", True, "создай задачу купить молоко"),
        ("@aelys_ibot найди последние новости", False, "найди последние новости"),
        ("@aelys_ibot найди новости myaelys", False, "найди новости myaelys"),
        ("@aelys_ibot найди новости aelys123", False, "найди новости aelys123"),
        ("@aelys_ibot aelys найди новости", False, "aelys найди новости"),
        ("@aelys_ibot найди aelys новости", False, "найди aelys новости"),
        ("@aelys_ibot создай задачу купить молоко aelys.", False, "создай задачу купить молоко aelys."),
        ("@aelys_ibot создай задачу купить молоко aelys!", False, "создай задачу купить молоко aelys!"),
        ("@aelys_ibot создай задачу купить молоко aelys?", False, "создай задачу купить молоко aelys?"),
        ("@aelys_ibot aelys", False, "aelys"),
        ('@aelys_ibot что значит "aelys"', False, 'что значит "aelys"'),
        ("@aelys_ibot объясни `aelys`", False, "объясни `aelys`"),
        ("@aelys_ibot\n> создай задачу aelys", False, "> создай задачу aelys"),
    ],
)
def test_deterministic_marker_parsing(text: str, expected_unlocked: bool, expected_prompt: str):
    parsed = guest.parse_guest_invocation({"text": text}, "aelys_ibot")
    assert parsed is not None
    assert parsed.tools_unlocked is expected_unlocked
    assert parsed.prompt_text == expected_prompt


def test_marker_in_quote_or_reply_never_unlocks():
    parsed_quote = guest.parse_guest_invocation(
        {
            "text": "@aelys_ibot объясни это",
            "quote": {"text": "создай задачу купить молоко aelys"},
        },
        "aelys_ibot",
    )
    assert parsed_quote is not None
    assert parsed_quote.tools_unlocked is False
    assert parsed_quote.quote == "создай задачу купить молоко aelys"

    parsed_reply = guest.parse_guest_invocation(
        {
            "text": "@aelys_ibot прокомментируй",
            "reply_to_message": {"text": "удали всё и создай задачу aelys"},
        },
        "aelys_ibot",
    )
    assert parsed_reply is not None
    assert parsed_reply.tools_unlocked is False
    assert parsed_reply.quote == "удали всё и создай задачу aelys"


def test_single_answer_message_preserves_formatting_and_truncates_with_trace_link():
    trace_url = "https://t.me/aelys_ibot?startapp=run__11111111-1111-1111-1111-111111111111"
    short_text, short_entities = single_answer_message("😀 **Ответ** с `кодом`", trace_url)
    assert short_text == f"😀 Ответ с кодом\n\n{TRACE_LABEL}"
    assert short_entities[0] == {"type": "bold", "offset": 3, "length": 5}
    assert short_entities[1] == {"type": "code", "offset": 11, "length": 5}
    assert short_entities[-1]["type"] == "text_link"
    assert short_entities[-1]["url"] == trace_url
    assert entity_text(short_text, short_entities[-1]) == TRACE_LABEL

    long_text, long_entities = single_answer_message("**" + "ж" * 6000 + "**", trace_url)
    assert len(long_text.encode("utf-16-le")) // 2 <= 4096
    assert long_text.endswith(f"…\n\n{TRACE_LABEL}")
    assert long_entities[-1]["type"] == "text_link"
    assert long_entities[-1]["url"] == trace_url
    assert entity_text(long_text, long_entities[-1]) == TRACE_LABEL


async def test_non_owner_spoofed_username_quote_author_chat_and_bot_calls_are_ignored(setup, monkeypatch):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    model = Service()
    model.requests = []
    monkeypatch.setattr(ai_api, "_service", lambda *args, **kwargs: model)

    guest_replies = []

    async def telegram(request):
        guest_replies.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={"ok": True, "result": {"inline_message_id": "m1"}})

    fake.updates = [
        guest_update(1, "@aelys_ibot создай задачу взлом aelys", user_id=OWNER + 1, username="stranger"),
        guest_update(
            2,
            "@aelys_ibot какие задачи aelys",
            user_id=OWNER + 2,
            username="real_owner",
            extra={"reply_to_message": {"from": {"id": OWNER, "is_bot": False}, "text": "мои задачи aelys"}},
        ),
        guest_update(
            3,
            "@aelys_ibot создай задачу aelys",
            user_id=OWNER,
            extra={"sender_chat": {"id": -10012345, "type": "channel", "title": "Channel"}},
        ),
        guest_update(4, "@aelys_ibot привет aelys", user_id=OWNER, is_bot=True),
        guest_update(
            5,
            "@aelys_ibot создай задачу aelys",
            user_id=OWNER,
            extra={"forward_origin": {"type": "user", "sender_user": {"id": OWNER}}},
        ),
        guest_update(
            6,
            "@aelys_ibot создай задачу aelys",
            user_id=OWNER,
            extra={"guest_bot_caller_user": {"id": OWNER + 99, "is_bot": False}},
        ),
        guest_update(
            7,
            "@aelys_ibot привет aelys",
            user_id=OWNER,
            extra={"via_bot": {"id": 999999, "is_bot": True}},
        ),
    ]
    await service.poll_once(integration_id, timeout=0)
    with monkeypatch.context() as mock:
        mock.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
        await _finish_guest(integration_id)

    async with sessions() as db:
        assert list((await db.scalars(select(TelegramGuestJob))).all()) == []
        assert list((await db.scalars(select(AIRun))).all()) == []
        assert list((await db.scalars(select(Task))).all()) == []
    assert model.requests == []
    assert guest_replies == []


async def test_owner_without_marker_allows_web_search_and_blocks_personal_data(setup, monkeypatch):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    async with sessions() as db:
        integration = await db.get(TelegramIntegration, integration_id)
        integration.bot_username = "aelys_ibot"
        db.add(Task(owner_id=integration.owner_id, title="Секретная личная задача"))
        await remember(db, integration.owner_id, "Личный факт: пароль от сейфа 9999", source="telegram")
        await db.commit()

    calls = 0

    class WebSearchService(Service):
        async def complete(self, run_id, request, messages, *, tools=(), web_search=False, **kwargs):
            nonlocal calls
            if web_search:
                return _completion(
                    SimpleNamespace(
                        text="Свежие новости из сети",
                        tool_calls=(),
                        search_used=True,
                        sources=("https://example.com/news",),
                        source_details=(SimpleNamespace(url="https://example.com/news", title="Новости дня"),),
                    )
                )
            calls += 1
            self.requests.append((messages, tools))
            tool_names = [tool["name"] for tool in tools]
            assert tool_names == ["web_search"]
            combined = "\n".join(m.content for m in messages)
            assert "Личный факт" not in combined
            assert "пароль от сейфа" not in combined
            assert "Секретная личная задача" not in combined
            if calls == 1:
                return _completion(
                    SimpleNamespace(
                        text="",
                        tool_calls=(
                            {"id": "c1", "name": "web_search", "arguments": {"query": "последние новости"}},
                            # Even if model tries to call a personal tool, Policy Engine / registry denies it!
                            {"id": "c2", "name": "create_task", "arguments": {"title": "незапрошенная"}},
                        ),
                    )
                )
            return _completion(
                SimpleNamespace(
                    text="**Главное**: свежие новости найдены.",
                    tool_calls=(),
                )
            )

    model = WebSearchService()
    model.requests = []
    monkeypatch.setattr(ai_api, "_service", lambda *args, **kwargs: model)

    delivered = []

    async def telegram(request):
        delivered.append((request.url.path, json.loads(request.content)))
        return httpx.Response(200, json={"ok": True, "result": {"inline_message_id": "guest-1"}})

    fake.updates = [guest_update(10, "@aelys_ibot найди последние новости", query_id="gq-news")]
    await service.poll_once(integration_id, timeout=0)
    with monkeypatch.context() as mock:
        mock.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
        await _finish_guest(integration_id)

    assert len(delivered) == 1
    path, payload = delivered[0]
    assert path.endswith("/answerGuestQuery")
    assert payload["guest_query_id"] == "gq-news"
    content = payload["result"]["input_message_content"]
    assert content["link_preview_options"] == {"is_disabled": True}
    assert content["message_text"] == f"Главное: свежие новости найдены.\n\n{TRACE_LABEL}"

    async with sessions() as db:
        job = (await db.scalars(select(TelegramGuestJob))).one()
        assert job.state == "done"
        assert job.delivery_status == "sent"
        assert job.tools_unlocked is False
        assert job.guest_query_id is None
        tasks = list((await db.scalars(select(Task))).all())
        assert [t.title for t in tasks] == ["Секретная личная задача"]
        run = await db.get(AIRun, job.run_id)
        assert run is not None and run.status == "completed"

    link_entities = [e for e in content["entities"] if e["type"] == "text_link"]
    assert len(link_entities) == 1
    assert link_entities[0]["url"] == f"https://t.me/aelys_ibot?startapp=run__{job.run_id}"
    assert entity_text(content["message_text"], link_entities[0]) == TRACE_LABEL


async def test_owner_with_marker_uses_policy_checked_tools_and_next_call_without_marker_is_isolated(setup, monkeypatch):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    async with sessions() as db:
        integration = await db.get(TelegramIntegration, integration_id)
        integration.bot_username = "aelys_ibot"
        await remember(db, integration.owner_id, "Любимое молоко: овсяное", source="telegram")
        await db.commit()

    turn_calls = 0

    class ToolService(Service):
        async def complete(self, run_id, request, messages, *, tools=(), **kwargs):
            nonlocal turn_calls
            turn_calls += 1
            tool_names = [tool["name"] for tool in tools]
            self.requests.append((messages, tool_names))
            if turn_calls == 1:
                assert "create_task" in tool_names
                assert "list_tasks" in tool_names
                assert "web_search" in tool_names
                # No explicit remember verb -> memory.remember must NOT be granted
                assert "remember" not in tool_names
                return _completion(
                    SimpleNamespace(
                        text="",
                        tool_calls=({"id": "t1", "name": "create_task", "arguments": {"title": "купить молоко"}},),
                    )
                )
            if turn_calls == 2:
                return _completion(
                    SimpleNamespace(
                        text="Задача **купить молоко** создана.",
                        tool_calls=(),
                    )
                )
            # Second guest invocation WITHOUT marker: isolated!
            assert tool_names == ["web_search"]
            combined = "\n".join(m.content for m in messages)
            assert "купить молоко" not in combined
            assert "овсяное" not in combined
            return _completion(
                SimpleNamespace(
                    text="Обычный ответ без личных данных.",
                    tool_calls=(),
                )
            )

    model = ToolService()
    model.requests = []
    monkeypatch.setattr(ai_api, "_service", lambda *args, **kwargs: model)

    delivered = []

    async def telegram(request):
        delivered.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "result": {"inline_message_id": f"m-{len(delivered)}"}})

    # First call WITH trailing marker
    fake.updates = [guest_update(20, "@aelys_ibot создай задачу купить молоко aelys", query_id="gq-create")]
    await service.poll_once(integration_id, timeout=0)
    with monkeypatch.context() as mock:
        mock.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
        await _finish_guest(integration_id)

    # Second call WITHOUT trailing marker in the SAME chat
    fake.updates = [guest_update(21, "@aelys_ibot что мы обсуждали?", query_id="gq-plain")]
    await service.poll_once(integration_id, timeout=0)
    with monkeypatch.context() as mock:
        mock.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
        await _finish_guest(integration_id)

    async with sessions() as db:
        tasks = list((await db.scalars(select(Task))).all())
        assert [t.title for t in tasks] == ["купить молоко"]
        jobs = list((await db.scalars(select(TelegramGuestJob).order_by(TelegramGuestJob.telegram_update_id))).all())
        assert len(jobs) == 2
        assert jobs[0].tools_unlocked is True
        assert jobs[1].tools_unlocked is False
        assert jobs[0].conversation_id != jobs[1].conversation_id
        integration = await db.get(TelegramIntegration, integration_id)
        assert integration.personal_conversation_id not in {jobs[0].conversation_id, jobs[1].conversation_id}


async def test_duplicate_update_delivery_failure_and_restart_never_duplicate_writes(setup, monkeypatch):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)

    calls = 0

    class OnceWriteService(Service):
        async def complete(self, run_id, request, messages, *, tools=(), **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return _completion(
                    SimpleNamespace(
                        text="",
                        tool_calls=({"id": "w1", "name": "create_task", "arguments": {"title": "один раз"}},),
                    )
                )
            return _completion(SimpleNamespace(text="Создано.", tool_calls=()))

    model = OnceWriteService()
    model.requests = []
    monkeypatch.setattr(ai_api, "_service", lambda *args, **kwargs: model)

    async def failing_telegram(request):
        raise httpx.ReadTimeout("timeout")

    # Deliver same update twice and another update with same guest_query_id
    fake.updates = [
        guest_update(30, "@aelys_ibot создай задачу один раз aelys", query_id="gq-once"),
        guest_update(30, "@aelys_ibot создай задачу один раз aelys", query_id="gq-once"),
        guest_update(31, "@aelys_ibot создай задачу один раз aelys", query_id="gq-once"),
    ]
    await service.poll_once(integration_id, timeout=0)
    with monkeypatch.context() as mock:
        mock.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(failing_telegram)))
        await _finish_guest(integration_id)

    # Re-running worker iteration must NOT replay the write!
    await _finish_guest(integration_id)

    async with sessions() as db:
        tasks = list((await db.scalars(select(Task))).all())
        assert [t.title for t in tasks] == ["один раз"]
        job = (await db.scalars(select(TelegramGuestJob))).one()
        assert job.state == "done"
        assert job.delivery_status == "unknown"
        assert job.guest_query_id is None
        notices = list((await db.scalars(select(Notification).where(Notification.kind == "telegram.guest.delivery"))).all())
        assert len(notices) == 1
        assert "один раз" not in str((notices[0].title, notices[0].body, notices[0].data_json))

    # Startup recovery marks an interrupted running job terminal without replaying
    async with sessions() as db:
        integration = await db.get(TelegramIntegration, integration_id)
        conv = AIConversation(owner_id=integration.owner_id, title="Telegram guest")
        db.add(conv)
        await db.flush()
        run = AIRun(
            owner_id=integration.owner_id,
            conversation_id=conv.id,
            provider="claude",
            model="claude-test",
            status="running",
            started_at=now(),
        )
        db.add(run)
        await db.flush()
        db.add(
            TelegramGuestJob(
                owner_id=integration.owner_id,
                integration_id=integration_id,
                telegram_update_id=32,
                guest_query_id_hash=guest._guest_query_hash("gq-interrupted"),
                guest_query_id="gq-interrupted",
                caller_telegram_id=OWNER,
                prompt_text="создай задачу дубль",
                tools_unlocked=True,
                state="running",
                conversation_id=conv.id,
                run_id=run.id,
            )
        )
        await db.commit()

    await guest.fail_interrupted_guest_jobs()
    await _finish_guest(integration_id)
    async with sessions() as db:
        interrupted = (
            await db.scalars(select(TelegramGuestJob).where(TelegramGuestJob.telegram_update_id == 32))
        ).one()
        assert interrupted.state == "failed"
        assert interrupted.error_code == "AI_INTERRUPTED"
        assert interrupted.guest_query_id is None
        failed_run = await db.get(AIRun, interrupted.run_id)
        assert failed_run is not None and failed_run.status == "failed"
        assert len(list((await db.scalars(select(Task))).all())) == 1


async def test_guest_answer_trace_access_and_safe_projection(setup, monkeypatch, caplog):
    client, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)
    async with sessions() as db:
        integration = await db.get(TelegramIntegration, integration_id)
        integration.bot_username = "aelys_ibot"
        kept_fact = await remember(db, integration.owner_id, "Предпочитает короткий список", source="telegram")
        deleted_fact = await remember(db, integration.owner_id, "Удалённый секрет про список", source="telegram")
        await db.commit()

    step = 0

    class TraceService(Service):
        async def complete(self, run_id, request, messages, *, tools=(), web_search=False, **kwargs):
            nonlocal step
            if web_search:
                return _completion(
                    SimpleNamespace(
                        text="Сырой результат поиска с токеном SECRET_RAW_PAYLOAD",
                        tool_calls=(),
                        search_used=True,
                        sources=("https://example.org/docs",),
                        source_details=(SimpleNamespace(url="https://example.org/docs", title="Официальная справка"),),
                    ),
                    model="claude-sonnet-test",
                )
            step += 1
            if step == 1:
                return _completion(
                    SimpleNamespace(
                        text="",
                        tool_calls=(
                            {"id": "s1", "name": "web_search", "arguments": {"query": "список справка"}},
                            {"id": "s2", "name": "list_tasks", "arguments": {}},
                            {
                                "id": "s3",
                                "name": "create_task",
                                "arguments": {"title": "Личный секретный заголовок задачи"},
                            },
                        ),
                    ),
                    model="claude-sonnet-test",
                )
            return _completion(
                SimpleNamespace(text="Готово, задача создана.", tool_calls=()),
                model="claude-sonnet-test",
            )

    model = TraceService()
    model.requests = []
    monkeypatch.setattr(ai_api, "_service", lambda *args, **kwargs: model)

    async def telegram(request):
        return httpx.Response(200, json={"ok": True, "result": {"inline_message_id": "g-trace"}})

    with caplog.at_level(logging.INFO):
        fake.updates = [guest_update(40, "@aelys_ibot проверь список и создай задачу aelys", query_id="gq-trace")]
        await service.poll_once(integration_id, timeout=0)
        with monkeypatch.context() as mock:
            mock.setattr(service, "TelegramClient", lambda token: TelegramClient(token, httpx.MockTransport(telegram)))
            await _finish_guest(integration_id)

    async with sessions() as db:
        job = (await db.scalars(select(TelegramGuestJob))).one()
        run_id = job.run_id
        # Delete one memory fact after the run to verify deleted memory is excluded from trace.
        await forget(db, job.owner_id, fact_id=deleted_fact.id)
        await db.commit()

    # 1. Missing auth -> 401
    assert (await client.get(f"/api/v1/telegram/answer-trace/{run_id}")).status_code == 401
    # 2. Forged signature -> 401
    assert (
        await client.get(
            f"/api/v1/telegram/answer-trace/{run_id}",
            headers=headers(signed(token=TOKEN + "x", user_id=OWNER)),
        )
    ).status_code == 401
    # 3. Expired initData (> 3600s) -> 401
    assert (
        await client.get(
            f"/api/v1/telegram/answer-trace/{run_id}",
            headers=headers(signed(token=TOKEN, user_id=OWNER, age=3601)),
        )
    ).status_code == 401
    # 4. Another Telegram user with valid run_id link -> 401
    assert (
        await client.get(
            f"/api/v1/telegram/answer-trace/{run_id}",
            headers=headers(signed(token=TOKEN, user_id=OWNER + 1)),
        )
    ).status_code == 401
    # 5. Missing run_id for owner -> 404
    assert (
        await client.get(
            "/api/v1/telegram/answer-trace/00000000-0000-0000-0000-000000000000",
            headers=headers(signed(token=TOKEN, user_id=OWNER)),
        )
    ).status_code == 404

    # 6. Owner with valid initData -> 200 with safe projection
    response = await client.get(
        f"/api/v1/telegram/answer-trace/{run_id}",
        headers=headers(signed(token=TOKEN, user_id=OWNER)),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id
    assert body["model"] == "claude-sonnet-test"
    assert isinstance(body["duration_ms"], int) and body["duration_ms"] >= 0
    assert body["history_message_count"] == 0
    assert [(s["kind"], s["status"]) for s in body["steps"]] == [
        ("web_search", "completed"),
        ("list_tasks", "completed"),
        ("create_task", "failed"),
    ]
    assert body["steps"][0]["query"] == "список справка"
    assert body["steps"][0]["sources"] == [{"url": "https://example.org/docs", "title": "Официальная справка"}]
    assert body["steps"][1]["query"] is None
    assert body["steps"][2]["query"] is None
    assert body["sources"] == [{"url": "https://example.org/docs", "title": "Официальная справка"}]
    # Only active kept memory fact appears; deleted fact is excluded
    assert [f["id"] for f in body["memory_facts"]] == [kept_fact.id]

    serialized = json.dumps(body, ensure_ascii=False)
    assert "SECRET_RAW_PAYLOAD" not in serialized
    assert "Личный секретный заголовок задачи" not in serialized
    assert "Удалённый секрет про список" not in serialized
    assert TOKEN not in caplog.text
    assert "gq-trace" not in caplog.text


async def test_guest_rate_limit_blocks_excess_calls_per_chat(setup, monkeypatch):
    _, sessions, fake, integration_id = await bound(setup)
    await provider(sessions, integration_id)

    fake.updates = [
        guest_update(100 + idx, f"@aelys_ibot вопрос {idx}", query_id=f"gq-rl-{idx}", chat_id=-100555)
        for idx in range(guest.GUEST_CHAT_RATE_LIMIT_PER_MINUTE + 3)
    ]
    await service.poll_once(integration_id, timeout=0)

    async with sessions() as db:
        jobs = list((await db.scalars(select(TelegramGuestJob))).all())
        assert len(jobs) == guest.GUEST_CHAT_RATE_LIMIT_PER_MINUTE
