import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import pytest
from app.ai import api as ai_api
from app.core import db
from app.core.db import Base
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/connected.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        owner = await client.post("/api/v1/auth/bootstrap", json={"email": "owner@test.example", "password": "connected-test-password"})
        client.headers["Authorization"] = f"Bearer {owner.json()['access_token']}"
        yield client
    await engine.dispose()


@pytest.mark.asyncio
async def test_provider_key_probe_and_persistent_conversation(client, monkeypatch):
    provider = (await client.post("/api/v1/ai/providers", json={"kind": "openrouter", "model_policy": {"default_model": "test-model"}})).json()
    provider_id = provider["id"]
    assert (await client.post(f"/api/v1/ai/providers/{provider_id}/probe")).json()["code"] == "SECRET_REQUIRED"
    await client.put(f"/api/v1/ai/providers/{provider_id}/secret", json={"api_key": "private-test-provider-key"})
    listing = await client.get("/api/v1/ai/providers")
    assert listing.json()[0]["has_secret"] is True
    assert "private-test-provider-key" not in listing.text

    @asynccontextmanager
    async def probe_client(**kwargs):
        class Probe:
            async def get(self, url, *, headers):
                assert url == "https://openrouter.ai/api/v1/key"
                assert headers["Authorization"] == "Bearer private-test-provider-key"
                class Response:
                    status_code = 200
                return Response()
        yield Probe()

    monkeypatch.setattr(ai_api.httpx, "AsyncClient", probe_client)
    assert (await client.post(f"/api/v1/ai/providers/{provider_id}/probe")).json() == {"connected": True, "code": "CONNECTED"}
    observed = []

    class Transport:
        def __init__(self, **kwargs):
            pass

        async def stream(self, url, *, headers, json):
            observed.append(json["messages"])
            yield {"choices": [{"delta": {"content": "Hello from provider"}}]}

    monkeypatch.setattr(ai_api, "HttpxTransport", Transport)
    conversation = (await client.post("/api/v1/ai/conversations", json={"title": "Persistent chat"})).json()
    for index, prompt in enumerate(["Hello", "What did I say?"]):
        run = (await client.post("/api/v1/ai/runs", json={"conversation_id": conversation["id"], "message": prompt, "idempotency_key": f"turn-{index}", "routing": {"provider_id": provider_id}})).json()
        events = await client.get(f"/api/v1/ai/runs/{run['id']}/events")
        assert "ai.run.completed" in events.text
        assert "Hello from provider" in events.text
        await client.get(f"/api/v1/ai/runs/{run['id']}/events")  # Replay must not repeat provider execution.
    assert len(observed) == 2
    assert [message["role"] for message in observed[1]] == ["user", "assistant", "user"]
    messages = (await client.get(f"/api/v1/ai/conversations/{conversation['id']}/messages")).json()
    assert [item["role"] for item in messages] == ["user", "assistant", "user", "assistant"]
    assert (await client.get("/api/v1/ai/conversations")).json()[0]["id"] == conversation["id"]
    await client.patch(f"/api/v1/ai/providers/{provider_id}", json={"enabled": False})
    rejected = await client.post("/api/v1/ai/runs", json={"conversation_id": conversation["id"], "message": "disabled", "idempotency_key": "disabled", "routing": {"provider_id": provider_id}})
    assert rejected.status_code == 404
    await client.delete(f"/api/v1/ai/providers/{provider_id}/secret")
    assert (await client.get("/api/v1/ai/providers")).json()[0]["has_secret"] is False


@pytest.mark.asyncio
async def test_eml_import_deduplication_draft_conflict_and_scope(client):
    raw = b'From: Person <person@example.test>\r\nTo: owner@example.test\r\nSubject: A meeting\r\nDate: Thu, 29 Oct 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMeet tomorrow. <script>never execute</script>'
    imported = await client.post("/api/v1/mail/import/eml", files={"file": ("message.eml", raw, "message/rfc822")})
    assert imported.status_code == 200
    item = imported.json()
    assert "Meet tomorrow" in item["body"]
    repeated = await client.post("/api/v1/mail/import/eml", files={"file": ("message.eml", raw, "message/rfc822")})
    assert repeated.json()["id"] == item["id"]
    assert len((await client.get("/api/v1/mail/messages")).json()) == 1
    draft = (await client.post("/api/v1/mail/drafts", json={"subject": "Reply", "content": "First version", "recipients": ["person@example.test"]})).json()
    path = f"/api/v1/mail/drafts/{draft['id']}"
    saved = await client.patch(path, json={"version": draft["version"], "subject": "Reply", "content": "Second version"})
    assert saved.status_code == 200
    assert (await client.patch(path, json={"version": draft["version"], "content": "Stale"})).status_code == 409
    assert (await client.delete(path, params={"version": draft["version"]})).status_code == 409
    assert (await client.delete(path, params={"version": saved.json()["version"]})).status_code == 200
    assert (await client.get("/api/v1/mail/drafts")).json() == []
    assert (await client.post("/api/v1/mail/import/eml", files={"file": ("invalid.eml", b"invalid")})).status_code == 422
    assert (await client.post("/api/v1/mail/import/eml", files={"file": ("large.eml", b"x" * (2 * 1024 * 1024 + 1))})).status_code == 413
    client.headers.pop("Authorization")
    assert (await client.get("/api/v1/mail/messages")).status_code == 401
    assert (await client.post("/api/v1/ai/providers/missing/probe")).status_code == 401


@pytest.mark.asyncio
async def test_calendar_round_trip_preserves_instant_and_rejects_stale_edits(client):
    body = {"title": "Local morning", "starts_at": "2026-10-29T09:00:00+05:00", "ends_at": "2026-10-29T10:00:00+05:00", "timezone": "Asia/Almaty", "rrule": "FREQ=WEEKLY;COUNT=4"}
    event = (await client.post("/api/v1/calendar/events", json=body)).json()
    assert event["starts_at"] == "2026-10-29T04:00:00Z"
    loaded = (await client.get("/api/v1/calendar/events")).json()[0]
    assert loaded["starts_at"] == event["starts_at"]
    assert loaded["rrule"] == body["rrule"]
    reminder = await client.post(f"/api/v1/calendar/events/{event['id']}/reminders", json={"event_id": event["id"], "notify_at": "2026-10-29T08:30:00+05:00", "channel": "in_app", "idempotency_key": "calendar-reminder-1"})
    assert reminder.status_code == 200
    assert (await client.get(f"/api/v1/calendar/events/{event['id']}/reminders")).json()[0]["reminder_status"] == "pending"
    path = f"/api/v1/calendar/events/{event['id']}"
    saved = await client.patch(path, json={**body, "title": "Updated morning", "version": loaded["version"]})
    assert saved.status_code == 200
    assert (await client.patch(path, json={**body, "version": loaded["version"]})).status_code == 409
    assert (await client.delete(path, params={"version": loaded["version"]})).status_code == 409
    assert (await client.delete(path, params={"version": saved.json()["version"]})).status_code == 200
    assert (await client.get("/api/v1/calendar/events")).json() == []


@pytest.mark.asyncio
async def test_focus_session_round_trip_persists_elapsed_time(client):
    started = "2026-10-29T09:00:00Z"
    body = {"started_at": started, "mode": "pomodoro"}
    session = (await client.post("/api/v1/focus/sessions", json=body, headers={"Idempotency-Key": "focus-start-1"})).json()
    assert session["status"] == "active"
    assert session["started_at"].endswith("Z")
    listed = (await client.get("/api/v1/focus/sessions")).json()
    assert listed[0]["elapsed_seconds"] >= 0
    assert (await client.post("/api/v1/focus/sessions", json=body, headers={"Idempotency-Key": "focus-start-1"})).json()["id"] == session["id"]
    assert (await client.post("/api/v1/focus/sessions", json=body)).status_code == 409
    assert (await client.post(f"/api/v1/focus/sessions/{session['id']}/stop", params={"version": session["version"] + 1})).status_code == 409
    stopped = (await client.post(f"/api/v1/focus/sessions/{session['id']}/stop")).json()
    assert stopped["status"] == "completed"
    assert stopped["elapsed_seconds"] >= 0
    again = (await client.post(f"/api/v1/focus/sessions/{session['id']}/stop")).json()
    assert again["elapsed_seconds"] == stopped["elapsed_seconds"] and again["ended_at"] == stopped["ended_at"]


@pytest.mark.asyncio
async def test_calendar_projects_weekly_rrule_across_dst(client):
    body = {"title": "Weekly New York", "starts_at": "2026-10-26T09:00:00-04:00", "ends_at": "2026-10-26T10:00:00-04:00", "timezone": "America/New_York", "rrule": "FREQ=WEEKLY;COUNT=3"}
    event = await client.post("/api/v1/calendar/events", json=body)
    assert event.status_code == 200, event.text
    response = await client.get("/api/v1/calendar/occurrences", params={"starts_at": "2026-10-26T00:00:00Z", "ends_at": "2026-11-16T00:00:00Z"})
    assert response.status_code == 200, response.text
    rows = response.json()
    assert [row["starts_at"] for row in rows] == ["2026-10-26T13:00:00Z", "2026-11-02T14:00:00Z", "2026-11-09T14:00:00Z"]
    assert len({row["occurrence_id"] for row in rows}) == 3
    assert {row["id"] for row in rows} == {event.json()["id"]}
    assert all(row["series_starts_at"] == "2026-10-26T13:00:00Z" for row in rows)
    for invalid in ["FREQ=SECONDLY", "FREQ=WEEKLY;INTERVAL=0", "FREQ=DAILY;COUNT=2;UNTIL=20261130T000000Z", "garbage"]:
        assert (await client.post("/api/v1/calendar/events", json={**body, "rrule": invalid})).status_code == 422
    assert (await client.post("/api/v1/calendar/events", json={**body, "timezone": "Unknown/Invalid"})).status_code == 422


@pytest.mark.asyncio
async def test_calendar_atomic_schedule_delivery_and_cancel(client):
    current = datetime.now(UTC)
    body = {"title": "Upcoming", "starts_at": (current + timedelta(hours=1)).isoformat(), "ends_at": (current + timedelta(hours=2)).isoformat(), "reminder_at": (current - timedelta(minutes=1)).isoformat()}
    response = await client.post("/api/v1/calendar/events", json=body, headers={"Idempotency-Key": "scheduled-event-1"})
    assert response.status_code == 200, response.text
    event = response.json()
    repeated = await client.post("/api/v1/calendar/events", json=body, headers={"Idempotency-Key": "scheduled-event-1"})
    assert repeated.json()["id"] == event["id"]
    reminders_path = f"/api/v1/calendar/events/{event['id']}/reminders"
    assert len((await client.get(reminders_path)).json()) == 1

    assert (await client.post("/api/v1/calendar/reminders/dispatch")).json() == {"delivered": 1}
    assert (await client.post("/api/v1/calendar/reminders/dispatch")).json() == {"delivered": 0}
    notices = (await client.get("/api/v1/notifications")).json()
    assert len(notices) == 1 and notices[0]["title"] == "Upcoming"
    assert (await client.get(reminders_path)).json()[0]["reminder_status"] == "delivered"
    reminder = (await client.post(reminders_path, json={"event_id": event["id"], "notify_at": (current + timedelta(minutes=5)).isoformat(), "idempotency_key": "cancel-me"})).json()
    assert (await client.delete(f"{reminders_path}/{reminder['id']}", params={"version": reminder["version"] + 1})).status_code == 409
    assert (await client.delete(f"{reminders_path}/{reminder['id']}", params={"version": reminder["version"]})).status_code == 200
    assert len((await client.get(reminders_path)).json()) == 1


@pytest.mark.asyncio
async def test_finance_exact_money_posting_signs_currencies_and_retry(client):
    usd = (await client.post("/api/v1/finance/accounts", json={"name": "USD", "currency": "USD"})).json()
    kzt = (await client.post("/api/v1/finance/accounts", json={"name": "KZT", "currency": "KZT"})).json()
    base = {"account_id": usd["id"], "currency": "USD", "type": "income", "amount": "9999999999999999.9999", "occurred_at": "2026-10-29T09:00:00Z", "idempotency_key": "exact-money-1"}
    posted = await client.post("/api/v1/finance/transactions", json=base)
    assert posted.status_code == 200, posted.text
    assert posted.json()["amount"] == "9999999999999999.9999"
    assert (await client.post("/api/v1/finance/transactions", json=base)).json()["id"] == posted.json()["id"]
    assert (await client.post("/api/v1/finance/transactions", json={**base, "amount": "10"})).status_code == 409
    for value in [1.25, "NaN", "Infinity", "0", "0.12345"]:
        invalid = await client.post("/api/v1/finance/transactions", json={**base, "amount": value, "idempotency_key": "invalid"})
        assert invalid.status_code == 422, invalid.text
    expense = (await client.post("/api/v1/finance/transactions", json={**base, "amount": "0.1001", "type": "expense", "idempotency_key": "expense-1"})).json()
    assert expense["amount"] == "-0.1001"
    await client.post("/api/v1/finance/transactions", json={**base, "account_id": kzt["id"], "currency": "KZT", "amount": "10.02", "idempotency_key": "kzt-income"})
    summary = (await client.get("/api/v1/finance/summary")).json()
    assert summary["total"] is None
    assert summary["count"] == 3
    currencies = {row["currency"]: row for row in summary["currencies"]}
    assert currencies["USD"]["balance"] == "9999999999999999.8998"
    assert currencies["KZT"]["balance"] == "10.02"
    values = (await client.get("/api/v1/finance/transactions")).json()
    assert all(isinstance(row["amount"], str) for row in values)
    budget_body = {"currency": "KZT", "period_start": "2026-10-01T00:00:00Z", "period_end": "2026-11-01T00:00:00Z", "limit_amount": "9999999999999999.9999"}
    budget = await client.post("/api/v1/finance/budgets", json=budget_body, headers={"Idempotency-Key": "exact-budget"})
    assert budget.json()["limit_amount"] == "9999999999999999.9999"
    assert (await client.post("/api/v1/finance/budgets", json=budget_body, headers={"Idempotency-Key": "exact-budget"})).json()["id"] == budget.json()["id"]


@pytest.mark.asyncio
async def test_recurring_reminders_deliver_each_occurrence_once(client):
    first = datetime.now(UTC) - timedelta(days=2, hours=1)
    event = (await client.post("/api/v1/calendar/events", json={"title": "Daily reminder", "starts_at": first.isoformat(), "ends_at": (first + timedelta(minutes=30)).isoformat(), "reminder_at": (first - timedelta(minutes=10)).isoformat(), "rrule": "FREQ=DAILY;COUNT=3"})).json()
    for _ in range(3):
        assert (await client.post("/api/v1/calendar/reminders/dispatch")).json() == {"delivered": 1}
    assert (await client.post("/api/v1/calendar/reminders/dispatch")).json() == {"delivered": 0}
    notices = (await client.get("/api/v1/notifications")).json()
    assert len(notices) == 3
    assert len({item["data_json"]["occurrence_at"] for item in notices}) == 3
    reminders = (await client.get(f"/api/v1/calendar/events/{event['id']}/reminders")).json()
    assert reminders[0]["reminder_status"] == "delivered"


@pytest.mark.asyncio
async def test_reminder_delivery_rolls_back_when_policy_denies(client, monkeypatch):
    from app.ai.errors import PolicyDenied
    from app.ai.policy import ServerPolicyEngine

    now = datetime.now(UTC)
    event = (await client.post("/api/v1/calendar/events", json={"title": "Policy test", "starts_at": (now + timedelta(hours=1)).isoformat(), "ends_at": (now + timedelta(hours=2)).isoformat(), "reminder_at": (now - timedelta(minutes=1)).isoformat()})).json()

    def deny(*args):
        raise PolicyDenied("Test denial")

    monkeypatch.setattr(ServerPolicyEngine, "authorize", deny)
    assert (await client.post("/api/v1/calendar/reminders/dispatch")).status_code == 403
    assert (await client.get("/api/v1/notifications")).json() == []
    assert (await client.get(f"/api/v1/calendar/events/{event['id']}/reminders")).json()[0]["reminder_status"] == "pending"


@pytest.mark.asyncio
async def test_home_task_updates_reject_stale_versions(client):
    task = (await client.post("/api/v1/tasks", json={"title": "Versioned task"})).json()
    body = {**task, "status": "completed"}
    assert (await client.patch(f"/api/v1/tasks/{task['id']}", json=body)).status_code == 200
    assert (await client.patch(f"/api/v1/tasks/{task['id']}", json={**body, "status": "todo"})).status_code == 409
    assert (await client.get(f"/api/v1/tasks/{task['id']}")).json()["status"] == "completed"


@pytest.mark.asyncio
async def test_concurrent_focus_starts_allow_only_one_active_owner_session(client):
    body = {"started_at": datetime.now(UTC).isoformat(), "mode": "stopwatch"}
    results = await asyncio.gather(*[
        client.post("/api/v1/focus/sessions", json=body, headers={"Idempotency-Key": f"concurrent-{index}"})
        for index in range(2)
    ])
    assert sorted(response.status_code for response in results) == [200, 409]
    assert len((await client.get("/api/v1/focus/sessions")).json()) == 1


@pytest.mark.asyncio
async def test_focus_preserves_task_and_project_links(client):
    project = (await client.post("/api/v1/projects", json={"name": "Focus project"})).json()
    task = (await client.post("/api/v1/tasks", json={"title": "Focus task", "project_id": project["id"]})).json()
    body = {"started_at": datetime.now(UTC).isoformat(), "task_id": task["id"], "project_id": project["id"], "mode": "stopwatch"}
    created = await client.post("/api/v1/focus/sessions", json=body)
    assert created.status_code == 200, created.text
    loaded = (await client.get("/api/v1/focus/sessions")).json()[0]
    assert loaded["task_id"] == task["id"] and loaded["project_id"] == project["id"]
    stopped = (await client.post(f"/api/v1/focus/sessions/{loaded['id']}/stop", params={"version": loaded["version"]})).json()
    assert stopped["version"] == loaded["version"] + 1
