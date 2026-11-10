from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from app.core import db
from app.core.db import Base
from app.core.models import AuthSession, EnglishReport, EnglishWord, Notification, User
from app.core.security import create_token
from app.english import ai as english_ai
from app.english import api as english_api
from app.english.reminders import english_reminders_once
from app.main import app
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

TODAY = datetime.now(UTC).date()
YESTERDAY = TODAY - timedelta(days=1)


@pytest.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/english.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", sessions)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post("/api/v1/auth/bootstrap", json={"email": "owner@test.example", "password": "english-test-password"})
        assert response.status_code == 200, response.text
        client.headers["Authorization"] = f"Bearer {response.json()['access_token']}"
        yield client, sessions
    await engine.dispose()


def word(lemma, **extra):
    return {"lemma": lemma, "part_of_speech": "noun", "ipa": "/x/", "definition_en": f"meaning of {lemma}", "translation_ru": f"перевод {lemma}", "example": f"A {lemma}.", "collocations": [f"big {lemma}"], "false_friend_ru": "", **extra}


def correction(level="B2", **extra):
    return {"corrected_text": "I went home.", "cefr_estimate": {"level": level, "rationale": "ok"}, "target_words": [{"word": "harvest", "used_correctly": True, "note": ""}],
            "errors": [{"original": "I goed", "correction": "I went", "type": "tense", "explanation_ru": "Неправильный глагол", "severity": "major"}], "strengths": ["clear"], "summary_ru": "Хорошо", **extra}


@pytest.fixture
def fake_ai(monkeypatch):
    calls = []
    replies = []

    async def fake(db, owner_id, system, user_text, max_tokens):
        calls.append((system, user_text))
        return replies.pop(0)

    monkeypatch.setattr(english_api, "complete_json", fake)
    return calls, replies


def iso(day): return day.isoformat()


async def seed(sessions, owner_id, lemma, **fields):
    async with sessions() as session:
        item = EnglishWord(owner_id=owner_id, lemma=lemma, definition_en="d", translation_ru="т", **fields)
        session.add(item)
        await session.commit()
        return item.id


async def owner_id(sessions):
    async with sessions() as session:
        return (await session.execute(User.__table__.select())).first().id


@pytest.mark.asyncio
async def test_generate_is_idempotent_and_drops_duplicates(client, fake_ai):
    api, sessions = client
    calls, replies = fake_ai
    await seed(sessions, await owner_id(sessions), "harvest", box=1, due_on=TODAY, introduced_on=YESTERDAY)
    replies.append({"words": [word("Harvest"), word("  Orchard ", collocations=["big orchard"]), word("orchard"), word("barn")]})
    response = await api.post("/api/v1/english/today/words", json={"day": iso(TODAY), "count": 5})
    assert response.status_code == 200, response.text
    body = response.json()
    assert [w["lemma"] for w in body["new_words"]] == ["orchard", "barn"]
    assert body["new_words"][0]["box"] == 1 and body["new_words"][0]["due_on"] == iso(TODAY + timedelta(days=1))
    assert body["new_words"][0]["collocations"] == ["big orchard"]
    assert body["stats"] == {"total": 3, "mastered": 0, "streak": 0}
    assert "harvest" in calls[0][0]  # existing lemma sent as an exclusion
    again = await api.post("/api/v1/english/today/words", json={"day": iso(TODAY), "count": 5})
    assert again.status_code == 200 and again.json() == body
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_generate_respects_count(client, fake_ai):
    api, _ = client
    fake_ai[1].append({"words": [word(w) for w in ("a", "b", "c", "d", "e", "f")]})
    response = await api.post("/api/v1/english/today/words", json={"day": iso(TODAY), "count": 5})
    assert [w["lemma"] for w in response.json()["new_words"]] == ["a", "b", "c", "d", "e"]
    assert (await api.post("/api/v1/english/today/words", json={"day": iso(TODAY), "count": 7})).status_code == 422


@pytest.mark.asyncio
async def test_review_leitner_transitions(client):
    api, sessions = client
    word_id = await seed(sessions, await owner_id(sessions), "harvest", box=1, due_on=TODAY, introduced_on=YESTERDAY)
    path = f"/api/v1/english/words/{word_id}/review"
    for box, days in ((2, 3), (3, 7), (4, 14), (5, 30), (6, 60), (6, 60)):
        response = await api.post(path, json={"day": iso(TODAY), "correct": True})
        assert response.status_code == 200, response.text
        assert (response.json()["box"], response.json()["due_on"]) == (box, iso(TODAY + timedelta(days=days)))
    wrong = (await api.post(path, json={"day": iso(TODAY), "correct": False})).json()
    assert (wrong["box"], wrong["lapses"], wrong["due_on"]) == (1, 1, iso(TODAY + timedelta(days=1)))


@pytest.mark.asyncio
async def test_today_selects_due_words_and_streak(client, fake_ai):
    api, sessions = client
    owner = await owner_id(sessions)
    await seed(sessions, owner, "late", box=2, due_on=TODAY - timedelta(days=2), introduced_on=TODAY - timedelta(days=5))
    await seed(sessions, owner, "now", box=2, due_on=TODAY, introduced_on=YESTERDAY)
    await seed(sessions, owner, "future", box=2, due_on=TODAY + timedelta(days=1), introduced_on=YESTERDAY)
    await seed(sessions, owner, "fresh", box=1, due_on=TODAY, introduced_on=TODAY)  # introduced today: new, not due
    await seed(sessions, owner, "master", box=6, due_on=TODAY + timedelta(days=60), introduced_on=YESTERDAY)
    body = (await api.get("/api/v1/english/today", params={"day": iso(TODAY)})).json()
    assert [w["lemma"] for w in body["due_words"]] == ["late", "now"]
    assert [w["lemma"] for w in body["new_words"]] == ["fresh"]
    assert body["report"] is None and body["stats"] == {"total": 5, "mastered": 1, "streak": 0}
    for day in (YESTERDAY, TODAY):
        fake_ai[1].append(correction())
        assert (await api.post("/api/v1/english/reports", json={"day": iso(day), "text": "x" * 30})).status_code == 200
    body = (await api.get("/api/v1/english/today", params={"day": iso(TODAY)})).json()
    assert body["stats"]["streak"] == 2 and body["report"]["cefr"] == "B2"


@pytest.mark.asyncio
async def test_report_submit_replaces_same_day_and_lists(client, fake_ai):
    api, sessions = client
    calls, replies = fake_ai
    await seed(sessions, await owner_id(sessions), "harvest", box=1, due_on=TODAY + timedelta(days=1), introduced_on=TODAY)
    replies.extend([correction("B1"), correction("C1")])
    first = await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "  I goed to the harvest today.  "})
    assert first.status_code == 200, first.text
    assert first.json()["text"] == "I goed to the harvest today." and first.json()["result"]["errors"][0]["type"] == "tense"
    assert "harvest" in calls[0][0] and calls[0][1] == "I goed to the harvest today."
    second = await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "A second, better attempt today."})
    assert second.json()["id"] == first.json()["id"] and second.json()["cefr"] == "C1"
    listing = (await api.get("/api/v1/english/reports")).json()
    assert [r["text"] for r in listing] == ["A second, better attempt today."]
    assert (await api.get("/api/v1/english/reports", params={"limit": 0})).status_code == 422
    assert (await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "short"})).status_code == 422


@pytest.mark.asyncio
async def test_other_owner_gets_404_and_empty_data(client):
    api, sessions = client
    word_id = await seed(sessions, await owner_id(sessions), "harvest", box=1, due_on=TODAY, introduced_on=YESTERDAY)
    async with sessions() as session:
        other = User(email="other@test.example")
        session.add(other)
        await session.flush()
        auth_session = AuthSession(owner_id=other.id, refresh_token_hash="other-session", expires_at=datetime.now(UTC) + timedelta(hours=1))
        session.add(auth_session)
        await session.flush()
        token = create_token(other.id, "access", 3600, session_id=auth_session.id)
        await session.commit()
    api.headers["Authorization"] = f"Bearer {token}"
    response = await api.post(f"/api/v1/english/words/{word_id}/review", json={"day": iso(TODAY), "correct": True})
    assert response.status_code == 404 and response.json()["detail"]["code"] == "NOT_FOUND"
    body = (await api.get("/api/v1/english/today", params={"day": iso(TODAY)})).json()
    assert body["due_words"] == [] and body["stats"]["total"] == 0


@pytest.mark.asyncio
async def test_invalid_day_rejected(client, fake_ai):
    api, sessions = client
    far = iso(TODAY + timedelta(days=2))
    word_id = await seed(sessions, await owner_id(sessions), "harvest", box=1, due_on=TODAY, introduced_on=YESTERDAY)
    for response in (
        await api.get("/api/v1/english/today", params={"day": far}),
        await api.post("/api/v1/english/today/words", json={"day": far, "count": 5}),
        await api.post(f"/api/v1/english/words/{word_id}/review", json={"day": far, "correct": True}),
        await api.post("/api/v1/english/reports", json={"day": far, "text": "x" * 30}),
    ):
        assert response.status_code == 422 and response.json()["detail"]["code"] == "INVALID_DAY"
    assert not fake_ai[0]


@pytest.mark.asyncio
async def test_ai_unavailable_without_provider(client):
    api, _ = client
    for response in (
        await api.post("/api/v1/english/today/words", json={"day": iso(TODAY), "count": 5}),
        await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "x" * 30}),
    ):
        assert response.status_code == 503 and response.json()["detail"]["code"] == "AI_UNAVAILABLE"


@pytest.mark.asyncio
async def test_bad_ai_output_is_502(client, fake_ai):
    api, _ = client
    fake_ai[1].extend([{"words": []}, {"corrected_text": "x"}])
    for response in (
        await api.post("/api/v1/english/today/words", json={"day": iso(TODAY), "count": 5}),
        await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "x" * 30}),
    ):
        assert response.status_code == 502 and response.json()["detail"]["code"] == "AI_BAD_OUTPUT"


def test_parse_json_handles_fences_and_bad_output():
    assert english_ai.parse_json('```json\n{"words": [1]}\n```') == {"words": [1]}
    assert english_ai.parse_json('Sure! {"a": {"b": 1}} Hope it helps') == {"a": {"b": 1}}
    for bad in ("no json here", "{not json}", "} {"):
        with pytest.raises(HTTPException) as error:
            english_ai.parse_json(bad)
        assert error.value.status_code == 502 and error.value.detail["code"] == "AI_BAD_OUTPUT"


@pytest.mark.asyncio
async def test_report_returns_tomorrow_tasks_and_topics(client, fake_ai):
    api, _ = client
    fake_ai[1].append(correction(tomorrow_tasks=[{"title": "x" * 300, "time": "09:30"}, {"title": "Gym", "time": None}] + [{"title": f"t{i}"} for i in range(12)], topics=["Work", " gym ", "work", "a", "b", "c", "d"]))
    body = (await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "x" * 30})).json()
    tasks = body["result"]["tomorrow_tasks"]
    assert len(tasks) == 10 and tasks[0] == {"title": "x" * 200, "time": "09:30"} and tasks[1] == {"title": "Gym", "time": None} and tasks[2]["time"] is None
    assert body["result"]["topics"] == ["work", "gym", "a", "b", "c"]
    fake_ai[1].append(correction(tomorrow_tasks=[{"title": "late", "time": "25:99"}]))
    assert (await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "x" * 30})).json()["detail"]["code"] == "AI_BAD_OUTPUT"


@pytest.mark.asyncio
async def test_old_report_rows_without_new_fields_still_validate(client):
    api, sessions = client
    legacy = {k: v for k, v in correction().items()}
    async with sessions() as session:
        session.add(EnglishReport(owner_id=await owner_id(sessions), day=TODAY, text="old report text", result_json=legacy, cefr="B2"))
        await session.commit()
    result = (await api.get("/api/v1/english/today", params={"day": iso(TODAY)})).json()["report"]["result"]
    assert result["tomorrow_tasks"] == [] and result["topics"] == []


def errors(*types):
    return [{"original": "a", "correction": "b", "type": t, "explanation_ru": "x", "severity": "minor"} for t in types]


async def seed_reports(sessions, *results):
    """One stored report per past day; the last result is yesterday's."""
    owner = await owner_id(sessions)
    async with sessions() as session:
        for offset, result in zip(range(len(results), 0, -1), results, strict=True):
            session.add(EnglishReport(owner_id=owner, day=TODAY - timedelta(days=offset), text="old report text", result_json=result, cefr="B1"))
        await session.commit()


@pytest.mark.asyncio
async def test_reports_feed_prompts(client, fake_ai):
    api, sessions = client
    calls, replies = fake_ai
    await seed_reports(sessions, correction(topics=["work"], errors=errors("article", "article", "tense")), correction(topics=["gym", "work"], errors=errors("article", "tense", "other")), correction(errors=errors("article", "article")))
    replies.extend([{"words": [word("a")]}, correction()])
    await api.post("/api/v1/english/today/words", json={"day": iso(TODAY), "count": 5})
    system, user = calls[0]
    assert "Recent topics of the learner's life: gym, work." in user and "Frequent mistake types: article x5, tense x2." in user
    assert "article x5" not in system  # context goes to the untrusted user message
    await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "x" * 30})
    assert "Recurring mistake types from previous reports: article x5, tense x2. If the learner repeats one, say so in summary_ru." in calls[1][0]
    assert "article x5" not in calls[1][1]


@pytest.mark.asyncio
async def test_prompts_have_no_context_without_history(client, fake_ai):
    api, _ = client
    calls, replies = fake_ai
    replies.extend([{"words": [word("a")]}, correction()])
    await api.post("/api/v1/english/today/words", json={"day": iso(TODAY), "count": 5})
    await api.post("/api/v1/english/reports", json={"day": iso(TODAY), "text": "x" * 30})
    assert calls[0][1] == "Generate today's words." and "Recurring" not in calls[1][0]


@pytest.mark.asyncio
async def test_settings_defaults_roundtrip_and_validation(client):
    api, _ = client
    assert (await api.get("/api/v1/english/settings")).json() == {"reminder_enabled": False, "reminder_time": "21:00", "timezone": "UTC"}
    body = {"reminder_enabled": True, "reminder_time": "20:15", "timezone": "Asia/Almaty"}
    assert (await api.put("/api/v1/english/settings", json=body)).json() == body
    assert (await api.put("/api/v1/english/settings", json={**body, "reminder_time": "21:30"})).json()["reminder_time"] == "21:30"
    assert (await api.get("/api/v1/english/settings")).json()["reminder_time"] == "21:30"
    for bad in ({"reminder_time": "24:00"}, {"reminder_time": "9:00"}, {"extra": 1}):
        assert (await api.put("/api/v1/english/settings", json={**body, **bad})).status_code == 422
    for zone in ("Mars/Olympus", "../etc/passwd", "America"):
        response = await api.put("/api/v1/english/settings", json={**body, "timezone": zone})
        assert response.status_code == 422 and response.json()["detail"]["code"] == "INVALID_TIMEZONE"


def at(hour, minute, zone, day=date(2030, 1, 15)):
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=ZoneInfo(zone))


async def reminders(sessions):
    async with sessions() as session:
        return list((await session.execute(select(Notification).where(Notification.kind == "english.reminder"))).scalars())


@pytest.mark.asyncio
async def test_reminder_window_once_and_timezone(client):
    api, sessions = client
    await api.put("/api/v1/english/settings", json={"reminder_enabled": True, "reminder_time": "21:00", "timezone": "Asia/Almaty"})
    assert await english_reminders_once(at(20, 59, "Asia/Almaty")) == 0  # before the time
    assert await english_reminders_once(at(21, 0, "UTC")) == 0  # 21:00 UTC is 02:00 next day in Almaty: outside the window
    assert await english_reminders_once(at(0, 0, "Asia/Almaty", date(2030, 1, 16))) == 0  # window is not carried past midnight
    assert await english_reminders_once(at(21, 5, "Asia/Almaty")) == 1
    assert await english_reminders_once(at(21, 6, "Asia/Almaty")) == 0  # not twice
    [note] = await reminders(sessions)
    assert (note.title, note.data_json, note.dedup_key.endswith(":2030-01-15")) == ("Отчёт дня", {"route": "/english"}, True)
    assert await english_reminders_once(at(21, 5, "Asia/Almaty", date(2030, 1, 16))) == 1  # next day fires again
    assert len(await reminders(sessions)) == 2


@pytest.mark.asyncio
async def test_reminder_respects_disabled_late_and_existing_report(client):
    api, sessions = client
    body = {"reminder_enabled": False, "reminder_time": "21:00", "timezone": "Europe/Moscow"}
    await api.put("/api/v1/english/settings", json=body)
    assert await english_reminders_once(at(21, 30, "Europe/Moscow")) == 0  # disabled
    await api.put("/api/v1/english/settings", json={**body, "reminder_enabled": True})
    assert await english_reminders_once(at(0, 5, "Europe/Moscow", date(2030, 1, 16))) == 0  # window over
    async with sessions() as session:
        session.add(EnglishReport(owner_id=await owner_id(sessions), day=date(2030, 1, 15), text="done already", result_json=correction(), cefr="B1"))
        await session.commit()
    assert await english_reminders_once(at(21, 30, "UTC")) == 0  # 00:30 Moscow next day: no report for 01-16 but outside window
    assert await english_reminders_once(at(21, 30, "Europe/Moscow")) == 0  # today's report exists
    assert await reminders(sessions) == []
    assert await english_reminders_once(at(21, 30, "Europe/Moscow", date(2030, 1, 16))) == 1  # no report that day


@pytest.mark.asyncio
async def test_reminder_duplicate_dedup_key_is_skipped_and_claimed(client):
    api, sessions = client
    owner = await owner_id(sessions)
    await api.put("/api/v1/english/settings", json={"reminder_enabled": True, "reminder_time": "21:00", "timezone": "UTC"})
    async with sessions() as session:
        session.add(Notification(owner_id=owner, kind="english.reminder", title="t", dedup_key=f"english-reminder:{owner}:2030-01-15"))
        await session.commit()
    assert await english_reminders_once(at(21, 5, "UTC")) == 0
    assert len(await reminders(sessions)) == 1
    assert await english_reminders_once(at(21, 6, "UTC")) == 0  # day stays claimed


@pytest.mark.asyncio
async def test_reminder_is_mirrored_to_owner_telegram_once_and_not_in_quiet_hours(client, monkeypatch):
    from app.ai.crypto import encrypt_secret
    from app.integrations import telegram_service
    from app.integrations.telegram_models import TelegramIntegration

    api, sessions = client
    sent = []

    class Transport:
        def __init__(self, token): self.token = token
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return None
        async def send_message(self, chat_id, text): sent.append((self.token, chat_id, text))

    monkeypatch.setattr(telegram_service, "TelegramClient", Transport)
    async with sessions() as session:
        session.add(TelegramIntegration(id="tg", owner_id=await owner_id(sessions), bot_id=1, bot_username="bot", bot_name="Bot", business_capable=True, encrypted_token=encrypt_secret("bot-token-secret"), owner_telegram_id=111, timezone="Asia/Almaty", quiet_start="21:30", quiet_end="08:00"))
        await session.commit()
    await api.put("/api/v1/english/settings", json={"reminder_enabled": True, "reminder_time": "21:00", "timezone": "Asia/Almaty"})
    assert await english_reminders_once(at(21, 5, "Asia/Almaty")) == 1
    assert await english_reminders_once(at(21, 6, "Asia/Almaty")) == 0
    assert len(sent) == 1 and sent[0][:2] == ("bot-token-secret", 111) and "отчёт" in sent[0][2]
    assert await english_reminders_once(at(21, 45, "Asia/Almaty", date(2030, 1, 16))) == 1  # quiet hours: bell only
    assert len(sent) == 1
