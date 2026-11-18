"""Exercise the mounted Mini App routes against encrypted, persisted fixtures."""
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode
from uuid import uuid4

import pytest
from app.ai.crypto import encrypt_secret
from app.ai.memory_models import OwnerMemoryFact
from app.core import db
from app.core.models import AIConversation, AIMessage, AIRun, AIRunEvent, User
from app.integrations.telegram_models import TelegramIntegration, TelegramPersonalJob
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

API = "/api/v1/telegram/answer-trace"
PAGE = "/telegram/answer-trace"
TOKEN = "12345:synthetic-fixture-token"
OTHER_TOKEN = "12346:synthetic-fixture-token"
OWNER = 100001
AT = datetime(2026, 1, 1, tzinfo=UTC)
PRIVATE = "must-never-appear-in-answer-trace"


def signed(*, token=TOKEN, user_id=OWNER, age=0, **overrides):
    fields = {
        "query_id": "sample=&+query",
        "user": json.dumps({"id": user_id, "first_name": "Тест + пример"}, ensure_ascii=False),
        "auth_date": str(int(time.time()) - age),
        **overrides,
    }
    message = "\n".join(f"{key}={value}" for key, value in sorted(fields.items()))
    secret = hmac.digest(b"WebAppData", token.encode(), "sha256")
    return urlencode({"hash": hmac.digest(secret, message.encode(), "sha256").hex(), **fields})


def headers(data=None):
    return {"Authorization": "tma " + (data if data is not None else signed())}


def event(run, sequence, kind, payload):
    return AIRunEvent(
        run_id=run.id, sequence=sequence, event_id=f"{run.id}:{sequence}", event_type=kind, payload=payload,
    )


async def owner(session, telegram_id=OWNER, token=TOKEN):
    user = User()
    session.add(user)
    await session.flush()
    integration = TelegramIntegration(
        owner_id=user.id, bot_id=12345, bot_username="sample_bot", bot_name="Sample Bot",
        owner_telegram_id=telegram_id, encrypted_token=encrypt_secret(token), business_capable=True,
        instructions=PRIVATE,
    )
    session.add(integration)
    await session.flush()
    return integration


async def new_run(session, integration, *, personal=True, status="completed", update_id=1):
    conversation = AIConversation(owner_id=integration.owner_id, title="Telegram assistant")
    session.add(conversation)
    await session.flush()
    prompt = AIMessage(conversation_id=conversation.id, role="user", content=PRIVATE)
    session.add(prompt)
    await session.flush()
    run = AIRun(
        owner_id=integration.owner_id, conversation_id=conversation.id, prompt_message_id=prompt.id,
        provider="claude", model="auto", status=status, started_at=AT,
        completed_at=AT + timedelta(milliseconds=8123),
    )
    session.add(run)
    await session.flush()
    if personal:
        session.add(TelegramPersonalJob(
            owner_id=integration.owner_id, integration_id=integration.id, telegram_update_id=update_id,
            run_id=run.id, conversation_id=conversation.id, state="done" if status == "completed" else "running",
            text=PRIVATE,
        ))
    return run


@pytest.fixture
async def trace_db(tmp_path, monkeypatch):
    monkeypatch.setattr(time, "time", lambda: AT.timestamp())
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/answer-trace.db")
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", sessions)
    async with sessions.begin() as session:
        integration = await owner(session)
        run = await new_run(session, integration)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client, sessions, run, integration
    await engine.dispose()


async def test_projects_steps_sources_and_final_history_count(trace_db):
    client, sessions, run, _ = trace_db
    source = {"url": "https://example.org/news", "title": "Example article"}
    second_source = {"url": "https://example.com/more", "title": "More"}
    async with sessions.begin() as session:
        session.add_all([
            event(run, 1, "ai.run.started", {"model": "actual-model", "history_message_count": 4, "prompt": PRIVATE}),
            event(run, 2, "ai.text.delta", {"reasoning": PRIVATE, "text": PRIVATE}),
            event(run, 3, "ai.tool.requested", {"tool": "web_search", "call_id": "a", "query": "weather", "label": PRIVATE}),
            event(run, 4, "ai.tool.approved", {"tool": "web_search", "call_id": "a"}),
            event(run, 5, "ai.tool.result", {
                "tool": "web_search", "call_id": "a", "result": {"status": "ok", "output": PRIVATE, "sources": [{**source, "secret": PRIVATE}]},
            }),
            event(run, 6, "ai.tool.requested", {"tool": "web_search", "call_id": "b", "query": "forecast"}),
            event(run, 7, "ai.tool.result", {
                "tool": "web_search", "call_id": "b", "result": {"status": "ok", "sources": [{**source, "title": "Duplicate"}, second_source]},
            }),
            event(run, 8, "ai.tool.requested", {"tool": "read_note", "call_id": "c", "query": PRIVATE}),
            event(run, 9, "ai.tool.result", {
                "tool": "read_note", "call_id": "c", "result": {"error": PRIVATE}, "sources": [second_source],
            }),
            event(run, 10, "ai.run.completed", {"history_message_count": 0}),
        ])
    response = await client.get(f"{API}/{run.id}", headers=headers())
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-frame-options"] == "DENY"
    payload = response.json()
    assert set(payload) == {"run_id", "duration_ms", "model", "steps", "sources", "history_message_count", "memory_facts"}
    assert payload["run_id"] == run.id
    assert payload["duration_ms"] == 8123
    assert payload["model"] == "actual-model"
    assert payload["history_message_count"] == 0
    assert payload["memory_facts"] == []
    assert payload["sources"] == [source, second_source]
    first, second, third = payload["steps"]
    assert set(first) == {"id", "kind", "label", "query", "status", "sources"}
    assert len({first["id"], second["id"], third["id"]}) == 3
    assert (first["kind"], first["query"], first["status"], first["sources"]) == ("web_search", "weather", "completed", [source])
    assert (second["status"], second["sources"]) == ("completed", [{**source, "title": "Duplicate"}, second_source])
    assert (third["kind"], third["query"], third["status"], third["sources"]) == ("read_note", None, "failed", [])
    assert PRIVATE not in response.text
    assert TOKEN not in response.text


@pytest.mark.parametrize(
    "case",
    ["missing", "bearer", "forged", "expired", "future", "other-user", "bad-id", "malformed",
     "duplicate-field", "duplicate-user-key", "duplicate-header", "wrong-token", "query-only"],
)
async def test_invalid_init_data_returns_generic_non_cacheable_401(trace_db, case):
    client, _, run, _ = trace_db
    data = signed()
    request_headers = {
        "missing": {},
        "bearer": {"Authorization": f"Bearer {PRIVATE}"},
        "forged": headers(data.replace("query_id=", "tampered=")),
        "expired": headers(signed(age=3601)),
        "future": headers(signed(age=-1)),
        "other-user": headers(signed(user_id=OWNER + 1)),
        "bad-id": headers(signed(user_id=True)),
        "malformed": headers(data + f"&bad=%FF{PRIVATE}"),
        "duplicate-field": headers(data + "&auth_date=0"),
        "duplicate-user-key": headers(signed(user='{"id":100002,"id":100001}')),
        "duplicate-header": [("Authorization", headers()["Authorization"]), ("Authorization", f"tma {PRIVATE}")],
        "wrong-token": headers(signed(token=OTHER_TOKEN)),
        "query-only": {},
    }[case]
    body = None
    for run_id in (run.id, str(uuid4()), "invalid-run-id"):
        response = await client.get(
            f"{API}/{run_id}", headers=request_headers, params={"initData": data} if case == "query-only" else None,
        )
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["detail"]["code"] == "UNAUTHORIZED"
        assert PRIVATE not in response.text and data not in response.text
        if body is not None:
            assert response.json() == body
        body = response.json()


async def test_accepts_expiry_boundary_and_returns_null_for_legacy_history(trace_db):
    client, _, run, _ = trace_db
    response = await client.get(f"{API}/{run.id}", headers=headers(signed(age=3600)))
    assert response.status_code == 200, response.text
    assert response.json()["history_message_count"] is None


async def test_only_authenticated_integration_completed_personal_jobs_are_visible(trace_db):
    client, sessions, run, integration = trace_db
    async with sessions.begin() as session:
        other = await owner(session, OWNER + 1, OTHER_TOKEN)
        foreign, web, business, running = (
            await new_run(session, other),
            await new_run(session, integration, personal=False),
            await new_run(session, integration, personal=False),
            await new_run(session, integration, status="running", update_id=2),
        )
        business.tool_scope_json = {"channel": "telegram_business"}
        session.add(event(business, 1, "ai.run.completed", {"text": PRIVATE}))
    missing = await client.get(f"{API}/{uuid4()}", headers=headers())
    assert missing.status_code == 404
    assert missing.headers["cache-control"] == "no-store"
    for run_id in (foreign.id, web.id, business.id, running.id, "invalid-run-id"):
        response = await client.get(f"{API}/{run_id}", headers=headers())
        assert response.status_code == 404
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == missing.json()
    async with sessions.begin() as session:
        row = await session.get(TelegramIntegration, integration.id)
        row.enabled = False
    response = await client.get(f"{API}/{run.id}", headers=headers())
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"


async def test_returns_only_active_exact_memory_refs_and_rechecks_edits(trace_db):
    client, sessions, run, integration = trace_db
    async with sessions.begin() as session:
        outsider = await owner(session, OWNER + 1, OTHER_TOKEN)
        definitions = {
            "current": {}, "edited": {"version": 2}, "forgotten": {"deleted_at": AT},
            "expired": {"expires_at": AT}, "unreferenced": {}, "another-user": {"owner_id": outsider.owner_id},
        }
        facts = {}
        for name, overrides in definitions.items():
            values = {"owner_id": integration.owner_id, "text": name, "kind": "fact", "source": "api",
                      "normalized_hash": name, **overrides}
            facts[name] = OwnerMemoryFact(**values)
            session.add(facts[name])
        await session.flush()
        refs = [
            {"kind": "owner_memory_fact", "id": fact.id, "version": 1, "text": PRIVATE}
            for name, fact in facts.items() if name != "unreferenced"
        ]
        reply = AIMessage(conversation_id=run.conversation_id, role="assistant", content=PRIVATE, source_refs_json=refs)
        session.add(reply)
        session.add(AIMessage(
            conversation_id=run.conversation_id, role="assistant", content=PRIVATE,
            source_refs_json=[{"kind": "owner_memory_fact", "id": facts["unreferenced"].id, "version": 1}],
        ))
        await session.flush()
        session.add(event(run, 1, "ai.run.completed", {"reply_message_id": reply.id, "reasoning": PRIVATE}))
    response = await client.get(f"{API}/{run.id}", headers=headers())
    assert response.status_code == 200, response.text
    assert response.json()["memory_facts"] == [{"id": facts["current"].id, "text": "current", "version": 1}]
    assert PRIVATE not in response.text
    async with sessions.begin() as session:
        row = await session.get(OwnerMemoryFact, facts["current"].id)
        row.version += 1
        row.text = "new version"
    response = await client.get(f"{API}/{run.id}", headers=headers())
    assert response.json()["memory_facts"] == []


async def test_bounds_fields_and_ignores_malformed_and_unknown_events(trace_db):
    client, sessions, run, _ = trace_db
    sources = [
        None, {"url": "javascript:alert(1)", "title": PRIVATE},
        {"url": f"https://user:password@example.org/{PRIVATE}", "title": PRIVATE},
        {"url": "https://example.org/" + "x" * 2048, "title": PRIVATE},
        *({"url": f"https://example.org/{index}", "title": "T" * 500} for index in range(11)),
    ]
    async with sessions.begin() as session:
        session.add_all([
            event(run, 1, "ai.run.started", {"model": [], "history_message_count": True}),
            event(run, 2, "ai.tool.requested", [PRIVATE]),
            event(run, 3, "ai.tool.requested", {"tool": [PRIVATE], "call_id": "invalid-tool"}),
            event(run, 4, "ai.tool.requested", {"tool": PRIVATE, "call_id": "unknown-tool"}),
            event(run, 5, "ai.tool.requested", {"tool": "web_search", "call_id": "search", "query": "Q" * 3000}),
            event(run, 6, "ai.tool.result", {
                "tool": "read_note", "call_id": "search", "result": {"error": PRIVATE}, "sources": [PRIVATE],
            }),
            event(run, 7, "ai.tool.result", {
                "tool": "web_search", "call_id": "search", "result": {"status": "ok", "sources": sources},
            }),
            *(event(run, 8 + i, "ai.tool.requested", {"tool": "list_tasks", "call_id": str(i)}) for i in range(105)),
        ])
    response = await client.get(f"{API}/{run.id}", headers=headers())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["history_message_count"] is None
    assert body["model"] == "auto"
    assert len(body["steps"]) == 100
    assert body["steps"][0]["query"] == "Q" * 2000
    assert len(body["steps"][0]["sources"]) == len(body["sources"]) == 10
    assert body["sources"][0] == {"url": "https://example.org/0", "title": "T" * 300}
    assert PRIVATE not in response.text


async def test_static_routes_have_scoped_telegram_web_framing(trace_db, monkeypatch, tmp_path):
    client, _, _, _ = trace_db
    files = {
        PAGE: ("index.html", "text/html", "<!doctype html><title>Trace</title>"),
        f"{PAGE}/app.js": ("app.js", "javascript", "console.log('trace');"),
        f"{PAGE}/style.css": ("style.css", "text/css", "body { margin: 0; }"),
    }
    for name, _, content in files.values():
        (tmp_path / name).write_text(content, encoding="utf-8")
    monkeypatch.setattr("app.integrations.telegram_answer_trace.STATIC_DIR", tmp_path)
    for path, (_, media_type, content) in files.items():
        response = await client.get(path)
        assert response.status_code == 200
        assert media_type in response.headers["content-type"]
        assert response.text == content
        assert "x-frame-options" not in response.headers
        assert "frame-ancestors https://web.telegram.org" in response.headers["content-security-policy"]
    (tmp_path / "private.txt").write_text(PRIVATE, encoding="utf-8")
    for path, status in ((f"{PAGE}/private.txt", 404), ("/healthz", 200)):
        response = await client.get(path)
        assert response.status_code == status
        assert response.headers["x-frame-options"] == "DENY"
        assert "frame-ancestors https://web.telegram.org" not in response.headers.get("content-security-policy", "")


def test_openapi_has_answer_trace_response_model():
    paths = app.openapi()["paths"]
    operation = paths.get(f"{API}/{{run_id}}", {}).get("get")
    assert operation is not None
    schema = operation["responses"]["200"]["content"]["application/json"]["schema"]
    assert schema["$ref"].endswith("/AnswerTraceOut")
    assert not any(path.startswith(PAGE) for path in paths)


async def test_trace_server_error_is_generic_and_non_cacheable(trace_db, monkeypatch):
    client, _, run, _ = trace_db

    async def failed_db():
        raise RuntimeError(PRIVATE)
        yield

    monkeypatch.setitem(app.dependency_overrides, db.get_db, failed_db)
    response = await client.get(f"{API}/{run.id}", headers=headers())
    assert response.status_code == 500
    assert response.headers["cache-control"] == "no-store"
    assert PRIVATE not in response.text
    assert response.json()["detail"]["code"] == "INTERNAL_ERROR"
