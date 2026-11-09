from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
import sqlalchemy as sa
from app.ai.crypto import encrypt_secret
from app.core.models import (
    AIProvider,
    AIProviderSecret,
    AIRun,
    AuthSession,
    EnglishLesson,
    EnglishProfile,
    EnglishWord,
    User,
)
from app.core.security import create_token
from app.english import ai as english_ai
from app.english import api as english_api
from app.english import lessons, plan
from app.english import speech as english_speech
from app.integrations import telegram_transcription
from sqlalchemy import select
from test_clean_migrations import run_alembic
from test_english import TODAY, YESTERDAY, correction, iso, owner_id, seed, word

pytest_plugins = ("test_english",)  # the `client` fixture

API = "/api/v1/english"
SCRIPT = [
    ("A", "I think the new library downtown is a wonderful place for students to study quietly every afternoon after school ends and before they go home."),
    ("B", "Yes, and the quiet room on the second floor has plenty of desks, so you never have to wait long to find a seat when the final exam is close."),
    ("A", "Do you also use the online courses they offer? I started one last month and I am learning a lot about economics and history from home."),
    ("B", "Not yet, but I would like to try. My teacher said that the courses help you practise listening, and that is exactly what I need to improve this year."),
    ("A", "Then let us sign up together tomorrow morning, because the registration closes on Friday and the places usually disappear very quickly."),
]
ANSWERS = ["quiet room", "final exam", "online courses", "registration", "economics"]


def gaps(answers=ANSWERS):
    return [{"before": f"Gap {i} before", "after": "after", "answer": a} for i, a in enumerate(answers)]


FARM = ["orchard", "barn", "tractor", "meadow", "fence", "silo", "plough", "hedge", "ditch"]
made = []  # lessons built in this test; reset by the ai fixture


def lesson_reply(vocab=None, **over):
    if vocab is None:  # a different lesson needs different (letters-only) lemmas, the first one uses the farm list
        n = len(made)
        made.append(n)
        vocab = FARM if n == 0 else [f"w{''.join(chr(97 + int(d)) for d in str(n))}{chr(97 + i)}" for i in range(9)]
    reply = {
        "vocab": [word(w) | {"example": f"The {w} is here."} for w in vocab],
        "listening": {"title": "Library talk", "live_hint_ru": "Слушай числа", "script": [{"speaker": s, "text": t} for s, t in SCRIPT], "questions": gaps(),
                      "connected_speech": [{"phrase": "going to", "sounds_like": "gonna", "note_ru": "слитно"}] * 3},
        "speaking": {"part2": {"topic": "A place you study", "bullets": ["where", "when", "who", "why"]}, "part3": ["Q1?", "Q2?", "Q3?"], "phrases": ["Well,", "As far as I know,", "What I mean is", "On the other hand,", "To be honest,"]},
        "writing": {"prompt": "Some people think students should wear uniforms. Discuss both views and give your opinion."},
    }
    return reply | over


@pytest.fixture
def ai(monkeypatch):
    calls, replies = [], []
    made.clear()

    async def fake(db, owner_id, system, user_text, max_tokens):
        calls.append((system, user_text))
        return replies.pop(0)

    monkeypatch.setattr(lessons, "complete_json", fake)
    monkeypatch.setattr(english_api, "complete_json", fake)
    monkeypatch.setattr(lessons, "TASK2_WEEKDAYS", ())  # journal days unless a test says otherwise
    return calls, replies


async def make_lesson(api, replies, day=TODAY, **over):
    replies.append(lesson_reply(**over))
    response = await api.post(f"{API}/lessons/today", json={"day": iso(day)})
    assert response.status_code == 200, response.text
    return response.json()


def right(lesson, n_wrong=0):
    return {str(i + 1): (a if i >= n_wrong else "wrong") for i, a in enumerate(ANSWERS)}


async def other_owner(api, sessions):
    async with sessions() as session:
        other = User(email="other@test.example")
        session.add(other)
        await session.flush()
        auth = AuthSession(owner_id=other.id, refresh_token_hash="other-session", expires_at=datetime.now(UTC) + timedelta(hours=1))
        session.add(auth)
        await session.flush()
        token = create_token(other.id, "access", 3600, session_id=auth.id)
        await session.commit()
    api.headers["Authorization"] = f"Bearer {token}"


@pytest.mark.asyncio
async def test_course_defaults(client):
    api, _ = client
    body = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert body["profile"] == {"goal": "ielts_academic", "target_band": "6.5", "level": "b1b2", "weak_skills": ["speaking", "listening"], "minutes_per_day": 120, "exam_date": None, "course_started_on": None}
    assert (body["week"], body["lesson_no"], body["days_to_exam"], body["hours_done"], body["hours_target"], body["mock_due"]) == (1, 1, None, 0.0, 150, False)
    assert [(p["week"], p["status"]) for p in body["plan"]] == [(1, "now")] + [(i, "next") for i in range(2, 11)]
    assert body["plan"][1] == {"week": 2, "theme": "Education & learning", "grammar": "Артикли", "status": "next"}
    assert body["skills"] == [{"skill": s, "band": None, "trend": None} for s in ("listening", "reading", "writing", "speaking")]
    assert body["adaptations"] == [] and body["week_stats"] == {"speaking_rounds": 0, "new_words": 0, "listening_pct": None, "streak": 0}
    assert body["today"]["id"] is None and [b["key"] for b in body["today"]["blocks"]] == ["warmup", "vocab", "listening", "speaking", "writing"]
    assert sum(b["minutes"] for b in body["today"]["blocks"]) == 120 and not any(b["done"] for b in body["today"]["blocks"])
    assert (await api.get(f"{API}/course", params={"day": iso(TODAY + timedelta(days=3))})).json()["detail"]["code"] == "INVALID_DAY"


@pytest.mark.asyncio
async def test_profile_put_validation_and_week(client):
    api, sessions = client
    good = {"goal": "ielts_general", "target_band": "7.0", "level": "b2", "weak_skills": ["writing", "writing", "reading"], "minutes_per_day": 60, "exam_date": iso(TODAY + timedelta(days=30))}
    saved = (await api.put(f"{API}/course/profile", json=good)).json()
    assert saved["weak_skills"] == ["writing", "reading"] and saved["course_started_on"] == iso(datetime.now(UTC).date())
    again = (await api.put(f"{API}/course/profile", json={**good, "minutes_per_day": 180})).json()
    assert again["minutes_per_day"] == 180 and again["course_started_on"] == saved["course_started_on"]
    for bad in ({"goal": "fun"}, {"target_band": "6.7"}, {"target_band": "10.0"}, {"target_band": "3.5"}, {"target_band": "0.0"}, {"level": "c2"}, {"minutes_per_day": 90}, {"weak_skills": ["cooking"]}, {"weak_skills": ["speaking"] * 3 + ["writing", "reading"]}, {"extra": 1}):
        assert (await api.put(f"{API}/course/profile", json={**good, **bad})).status_code == 422, bad
    assert (await api.put(f"{API}/course/profile", json={k: v for k, v in good.items() if k != "goal"})).status_code == 422
    async with sessions() as session:
        profile = (await session.execute(select(EnglishProfile))).scalar_one()
        profile.course_started_on = TODAY - timedelta(days=15)
        await session.commit()
    body = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert (body["week"], body["days_to_exam"]) == (3, 30)
    assert [p["status"] for p in body["plan"][:4]] == ["done", "done", "now", "next"]
    assert sum(b["minutes"] for b in body["today"]["blocks"]) == 180
    async with sessions() as session:  # past the end of the plan the week is capped
        (await session.execute(select(EnglishProfile))).scalar_one().course_started_on = TODAY - timedelta(days=400)
        await session.commit()
    assert (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()["week"] == 10


@pytest.mark.asyncio
async def test_lesson_generation_is_idempotent_with_vocab_and_warmup(client, ai):
    api, sessions = client
    calls, replies = ai
    owner = await owner_id(sessions)
    due = await seed(sessions, owner, "harvest", box=2, due_on=TODAY, introduced_on=YESTERDAY, example="We Harvest the crop in autumn.")
    await seed(sessions, owner, "absent", box=2, due_on=TODAY, introduced_on=YESTERDAY, example="No match in this sentence.")
    await seed(sessions, owner, "barn", box=2, due_on=TODAY, introduced_on=YESTERDAY, example="The barns are big.")  # inflected form: not a whole-word match
    lesson = await make_lesson(api, replies)
    assert len(calls) == 1 and (lesson["week"], lesson["lesson_no"], lesson["theme"], lesson["progress"]) == (1, 1, "Диагностика и базовые связки", {})
    content = lesson["content"]
    assert content["warmup"] == [{"word_id": due, "before": "We ", "answer": "Harvest", "after": " the crop in autumn.", "hint_ru": "т"}]
    assert content["grammar_focus"] == "Present tenses" and content["writing"] == {"kind": "journal", "prompt": None}
    assert [v["lemma"] for v in content["vocab"]] == ["orchard", "tractor", "meadow", "fence", "silo", "plough", "hedge", "ditch"]  # 8 words, "barn" already owned
    assert set(content["vocab"][0]) == {"word_id", "lemma", "ipa", "part_of_speech", "translation_ru", "definition_en", "example", "collocations"}
    assert content["listening"]["live"]["source"] == "BBC 6 Minute English" and content["listening"]["tts_rate"] == 1.0
    assert [q["n"] for q in content["listening"]["questions"]] == [1, 2, 3, 4, 5] and all("answer" not in q for q in content["listening"]["questions"])
    assert content["listening"]["script_visible"] is False and content["blocks"][0] == {"key": "warmup", "title": "Разминка", "minutes": 15}
    assert "Present tenses" in calls[0][0] and "exactly 8 useful topic words" in calls[0][0] and "harvest" in calls[0][0]
    again = (await api.post(f"{API}/lessons/today", json={"day": iso(TODAY)})).json()
    assert again == lesson and len(calls) == 1
    async with sessions() as session:
        words = (await session.execute(select(EnglishWord).where(EnglishWord.introduced_on == TODAY))).scalars().all()
        assert len(words) == 8 and {w.due_on for w in words} == {TODAY + timedelta(days=1)} and {w.id for w in words} == {v["word_id"] for v in content["vocab"]}
        assert (await session.execute(select(EnglishProfile))).scalar_one().course_started_on == TODAY
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert course["today"]["id"] == lesson["id"] and course["lesson_no"] == 1 and course["week_stats"]["new_words"] == 8
    assert (await api.post(f"{API}/lessons/today", json={"day": iso(TODAY + timedelta(days=2))})).json()["detail"]["code"] == "INVALID_DAY"
    replies.append(lesson_reply())
    second = (await api.post(f"{API}/lessons/today", json={"day": iso(YESTERDAY)})).json()
    assert second["lesson_no"] == 1  # lesson_no counts lessons up to that day


@pytest.mark.asyncio
async def test_vocab_count_follows_minutes_per_day(client, ai):
    api, _ = client
    await api.put(f"{API}/course/profile", json={"goal": "conversation", "target_band": "6.0", "level": "test", "weak_skills": [], "minutes_per_day": 60})
    lesson = await make_lesson(api, ai[1])
    assert len(lesson["content"]["vocab"]) == 6 and "exactly 6 useful" in ai[0][0][0]


@pytest.mark.asyncio
async def test_answers_hidden_until_listening_checked_then_graded_once(client, ai):
    api, _ = client
    lesson = await make_lesson(api, ai[1])
    path = f"{API}/lessons/{lesson['id']}"
    assert "answer" not in str((await api.get(path)).json()["content"]["listening"]["questions"])
    blocked = await api.post(f"{path}/blocks/listening/done", json={})
    assert blocked.status_code == 422 and blocked.json()["detail"]["code"] == "LISTENING_NOT_CHECKED"
    given = {"1": " Quiet  ROOM ", "2": "final exam", "3": "online course", "5": "ECONOMICS"}  # 3 is wrong (singular), 4 missing
    result = (await api.post(f"{path}/listening", json={"answers": given})).json()
    assert (result["score"], result["total"]) == (3, 5)
    assert [(r["n"], r["ok"]) for r in result["results"]] == [(1, True), (2, True), (3, False), (4, False), (5, True)]
    assert result["results"][2] == {"n": 3, "given": "online course", "answer": "online courses", "ok": False} and result["feedback_ru"]
    shown = (await api.get(path)).json()
    assert [q["answer"] for q in shown["content"]["listening"]["questions"]] == ANSWERS and shown["content"]["listening"]["script_visible"] is True
    assert shown["progress"]["listening"]["done"] is True and shown["progress"]["listening"]["pct"] == 60 and shown["progress"]["listening"]["missed"] == ["online courses", "registration"]
    assert shown["progress"]["listening"]["minutes"] == 30
    again = (await api.post(f"{path}/listening", json={"answers": right(lesson)})).json()
    assert again == result  # the first check is final
    for bad in ({"answers": {"x": "a"}}, {"answers": {"1": "a" * 81}}, {"answers": {}, "extra": 1}):
        assert (await api.post(f"{path}/listening", json=bad)).status_code == 422


@pytest.mark.asyncio
async def test_poor_listening_slows_next_lesson_and_adapts(client, ai):
    api, _ = client
    calls, replies = ai
    first = await make_lesson(api, replies, YESTERDAY)
    (await api.post(f"{API}/lessons/{first['id']}/listening", json={"answers": right(first, n_wrong=3)})).raise_for_status()  # 2 of 5 = 40%
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert course["week_stats"]["listening_pct"] == 40 and course["lesson_no"] == 2
    assert [a["skill"] for a in course["adaptations"]] == ["listening"] and course["adaptations"][0]["icon"] == "gauge"
    assert next(s for s in course["skills"] if s["skill"] == "listening")["band"] == "4.5"
    second = await make_lesson(api, replies, TODAY)
    assert second["content"]["listening"]["tts_rate"] == 0.9 and second["lesson_no"] == 2
    assert "Listening accuracy over the last lessons: 40%." in calls[1][1] and "Words missed in recent listening: " in calls[1][1]
    assert "5 items" in calls[1][0] and "3-4 items" in calls[0][0]


@pytest.mark.asyncio
async def test_blocks_done_marks_progress_and_hours(client, ai):
    api, _ = client
    lesson = await make_lesson(api, ai[1])
    path = f"{API}/lessons/{lesson['id']}/blocks"
    warm = (await api.post(f"{path}/warmup/done", json={})).json()["progress"]["warmup"]
    assert warm == {"done": True, "minutes": 15}
    vocab = (await api.post(f"{path}/vocab/done", json={"minutes": 30})).json()["progress"]["vocab"]
    assert vocab == {"done": True, "minutes": 30}
    assert (await api.post(f"{path}/vocab/done")).status_code == 200  # body is optional
    assert (await api.post(f"{path}/nope/done", json={})).status_code == 422
    assert (await api.post(f"{path}/vocab/done", json={"minutes": -1})).status_code == 422
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert course["hours_done"] == 0.8 and course["week_stats"]["streak"] == 1  # 45 min
    assert [b["done"] for b in course["today"]["blocks"]] == [True, True, False, False, False]


@pytest.mark.asyncio
async def test_sentences_check(client, ai):
    api, _ = client
    calls, replies = ai
    lesson = await make_lesson(api, replies)
    first, second = lesson["content"]["vocab"][:2]
    path = f"{API}/lessons/{lesson['id']}/sentences"
    replies.append({"items": [
        {"word_id": first["word_id"], "ok": True, "title_ru": "Верно", "detail_ru": "Естественно", "corrected": "ignored"},
        {"word_id": second["word_id"], "ok": False, "title_ru": "Ошибка", "detail_ru": "Артикль", "corrected": "The barn is red."}]})
    body = (await api.post(path, json={"items": [{"word_id": first["word_id"], "sentence": "The orchard is big."}, {"word_id": second["word_id"], "sentence": " barn red "}]})).json()
    assert body["items"] == [{"word_id": first["word_id"], "ok": True, "title_ru": "Верно", "detail_ru": "Естественно", "corrected": None},
                             {"word_id": second["word_id"], "ok": False, "title_ru": "Ошибка", "detail_ru": "Артикль", "corrected": "The barn is red."}]
    assert "barn red" in calls[1][1] and "barn red" not in calls[1][0]
    replies.append({"items": [{"word_id": first["word_id"], "ok": True, "title_ru": "t", "detail_ru": "d"}]})  # AI skipped an item
    two = {"items": [{"word_id": first["word_id"], "sentence": "The orchard is big."}, {"word_id": second["word_id"], "sentence": "A barn is red."}]}
    assert (await api.post(path, json=two)).json()["detail"]["code"] == "AI_BAD_OUTPUT"
    for bad in ({"items": []}, {"items": [{"word_id": first["word_id"], "sentence": "hi"}]}, {"items": [{"word_id": "nope", "sentence": "A valid sentence."}]},
                {"items": [{"word_id": first["word_id"], "sentence": "One sentence."}] * 2}):
        assert (await api.post(path, json=bad)).status_code == 422, bad
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_speaking_rounds_store_criteria_and_finish_after_round_two(client, ai):
    api, _ = client
    calls, replies = ai
    lesson = await make_lesson(api, replies)
    path = f"{API}/lessons/{lesson['id']}/speaking"
    reply = {"criteria": {"fluency": "5.5", "lexical": "≈6.0", "grammar": "≈5.5"}, "pauses": 5, "linkers_used": ["well", "so"],
             "corrected_html_safe": [{"type": "same", "text": "I "}, {"type": "del", "text": "goed"}, {"type": "ins", "text": "went"}],
             "tips": [{"kind": "timing", "title_ru": "Темп", "detail_ru": "Говори дольше"}, {"kind": "good", "title_ru": "Связки", "detail_ru": "Хорошо"}]}
    replies.append(reply)
    round4 = (await api.post(path, json={"round": 4, "transcript": "I goed to the library. <b>x</b>", "duration_sec": 200})).json()
    assert round4 == {"round": 4, "criteria": {"fluency": "≈5.5", "lexical": "≈6.0", "grammar": "≈5.5"}, "corrected_html_safe": reply["corrected_html_safe"], "tips": reply["tips"], "pauses": 5, "linkers_used": 2}
    assert "<b>x</b>" in calls[1][1] and "A place you study" in calls[1][0] and "not score" in calls[1][0]
    stored = (await api.get(f"{API}/lessons/{lesson['id']}")).json()["progress"]["speaking"]
    assert stored.get("done") is None and stored["rounds"]["4"] == {**round4, "duration_sec": 200}  # everything the UI needs to re-render the round
    replies.append(reply)
    round2 = (await api.post(path, json={"round": 2, "transcript": "I went to the library.", "duration_sec": 100, "pause_count": 1})).json()
    assert round2["pauses"] == 1
    progress = (await api.get(f"{API}/lessons/{lesson['id']}")).json()["progress"]["speaking"]
    assert progress["done"] is True and set(progress["rounds"]) == {"4", "2"} and progress["minutes"] == 30
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert course["week_stats"]["speaking_rounds"] == 2
    assert next(s for s in course["skills"] if s["skill"] == "speaking")["band"] == "≈5.5"  # mean of 5.5, 6.0, 5.5 over two rounds = 5.67
    assert [a["skill"] for a in course["adaptations"]] == []  # (5 + 1) / 2 = 3 pauses: below the threshold
    for bad in ({"round": 5, "transcript": "hello there", "duration_sec": 5}, {"round": 4, "transcript": "hi", "duration_sec": 5}, {"round": 4, "transcript": "hello there", "duration_sec": 0}):
        assert (await api.post(path, json=bad)).status_code == 422
    replies.append({**reply, "corrected_html_safe": []})
    assert (await api.post(path, json={"round": 3, "transcript": "hello there", "duration_sec": 50})).json()["detail"]["code"] == "AI_BAD_OUTPUT"
    replies.append({**reply, "criteria": {"fluency": "great", "lexical": "≈6.0", "grammar": "≈5.5"}})
    assert (await api.post(path, json={"round": 3, "transcript": "hello there", "duration_sec": 50})).json()["detail"]["code"] == "AI_BAD_OUTPUT"


@pytest.mark.asyncio
async def test_many_pauses_adapt_speaking_and_next_lesson(client, ai):
    api, _ = client
    calls, replies = ai
    lesson = await make_lesson(api, replies, YESTERDAY)
    replies.append({"criteria": {"fluency": "≈5.0", "lexical": "≈5.0", "grammar": "≈5.0"}, "pauses": 8, "corrected_html_safe": [{"type": "same", "text": "x"}]})
    (await api.post(f"{API}/lessons/{lesson['id']}/speaking", json={"round": 4, "transcript": "hello there", "duration_sec": 50})).raise_for_status()
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert [a["skill"] for a in course["adaptations"]] == ["speaking"] and course["adaptations"][0]["icon"] == "mic"
    await make_lesson(api, replies, TODAY, speaking={**lesson_reply()["speaking"], "phrases": [f"Phrase {i}," for i in range(8)]})
    assert "Average pauses per speaking round: 8" in calls[-1][1] and "exactly 8 useful linking phrases" in calls[-1][0]


@pytest.mark.asyncio
async def test_journal_report_is_labelled_and_marks_writing_done(client, ai):
    api, _ = client
    calls, replies = ai
    lesson = await make_lesson(api, replies)
    replies.append(correction(criteria={"task_response": "≈7.0", "coherence": "6", "lexical": "6", "grammar": "6"}))
    body = (await api.post(f"{API}/reports", json={"day": iso(TODAY), "text": "x" * 30})).json()
    assert body["result"]["kind"] == "journal" and body["result"]["criteria"] is None
    assert "IELTS" not in calls[-1][0]
    progress = (await api.get(f"{API}/lessons/{lesson['id']}")).json()["progress"]["writing"]
    assert progress == {"done": True, "minutes": 25}
    assert (await api.post(f"{API}/reports", json={"day": iso(TODAY), "text": "x" * 30, "kind": "essay"})).status_code == 422


@pytest.mark.asyncio
async def test_task2_report_has_criteria(client, ai, monkeypatch):
    api, _ = client
    calls, replies = ai
    monkeypatch.setattr(lessons, "TASK2_WEEKDAYS", tuple(range(7)))
    lesson = await make_lesson(api, replies)
    assert lesson["content"]["writing"]["kind"] == "task2" and "uniforms" in lesson["content"]["writing"]["prompt"]
    replies.append(correction(criteria={"task_response": "6", "coherence": "≈6.5", "lexical": " 5.5", "grammar": "≈5.0"}))
    body = (await api.post(f"{API}/reports", json={"day": iso(TODAY), "text": "x" * 30, "kind": "task2"})).json()
    assert body["result"]["kind"] == "task2" and body["result"]["criteria"] == {"task_response": "≈6.0", "coherence": "≈6.5", "lexical": "≈5.5", "grammar": "≈5.0"}
    assert "Task 2" in calls[-1][0] and "uniforms" in calls[-1][0] and calls[-1][1] == "x" * 30
    stored = (await api.get(f"{API}/reports")).json()[0]["result"]
    assert stored["kind"] == "task2" and stored["criteria"]["lexical"] == "≈5.5"
    assert (await api.get(f"{API}/lessons/{lesson['id']}")).json()["progress"]["writing"]["done"] is True
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert next(s for s in course["skills"] if s["skill"] == "writing")["band"] == "≈6.0"  # mean of 6.0, 6.5, 5.5, 5.0 = 5.75
    replies.append(correction())  # task2 without criteria
    assert (await api.post(f"{API}/reports", json={"day": iso(TODAY), "text": "x" * 30, "kind": "task2"})).json()["detail"]["code"] == "AI_BAD_OUTPUT"
    replies.append(correction(criteria={"task_response": "high", "coherence": "6", "lexical": "6", "grammar": "6"}))
    assert (await api.post(f"{API}/reports", json={"day": iso(TODAY), "text": "x" * 30, "kind": "task2"})).json()["detail"]["code"] == "AI_BAD_OUTPUT"
    replies.append(lesson_reply(writing={"prompt": "short"}))
    assert (await api.post(f"{API}/lessons/today", json={"day": iso(YESTERDAY)})).json()["detail"]["code"] == "AI_BAD_OUTPUT"


@pytest.mark.asyncio
async def test_bad_lesson_output_is_502_and_stores_nothing(client, ai):
    api, sessions = client
    _, replies = ai
    good = lesson_reply()
    bad_script = {**good["listening"], "script": [{"speaker": "A", "text": "Short quiet room final exam online courses registration economics here."}] * 4}
    outside = {**good["listening"], "questions": gaps(ANSWERS[:4] + ["volcano"])}
    long_answer = {**good["listening"], "questions": gaps(ANSWERS[:4] + ["the quiet room on"])}
    few = {**good["listening"], "questions": gaps(ANSWERS[:3])}
    for listening in (outside, long_answer, few, bad_script, {"title": "x"}):
        replies.append({**good, "listening": listening})
        response = await api.post(f"{API}/lessons/today", json={"day": iso(TODAY)})
        assert response.status_code == 502 and response.json()["detail"]["code"] == "AI_BAD_OUTPUT", listening
    replies.extend([{**good, "vocab": []}, {**good, "speaking": {**good["speaking"], "phrases": ["only one"]}}, {"nonsense": True}])
    for _ in range(3):
        assert (await api.post(f"{API}/lessons/today", json={"day": iso(TODAY)})).json()["detail"]["code"] == "AI_BAD_OUTPUT"
    async with sessions() as session:
        assert (await session.execute(select(sa.func.count()).select_from(EnglishLesson))).scalar_one() == 0
        assert (await session.execute(select(sa.func.count()).select_from(EnglishWord))).scalar_one() == 0
    replies.append({**good, "vocab": [word("Barn")]})  # all words are fine, none new -> still a lesson only if one is new
    assert (await api.post(f"{API}/lessons/today", json={"day": iso(TODAY)})).status_code == 200


@pytest.mark.asyncio
async def test_lesson_requires_ai_provider(client):
    api, _ = client
    assert (await api.post(f"{API}/lessons/today", json={"day": iso(TODAY)})).json()["detail"]["code"] == "AI_UNAVAILABLE"


@pytest.mark.asyncio
async def test_mocks_set_skill_bands_and_trend(client):
    api, _ = client
    assert (await api.post(f"{API}/mocks", json={"day": iso(TODAY)})).status_code == 422
    for bad in ({"listening": "6.7"}, {"listening": "9.5"}, {"listening": 6}, {"extra": "1", "reading": "6.0"}, {"reading": "6.0", "day": iso(TODAY + timedelta(days=5))}, {"reading": "6.0", "day": iso(TODAY - timedelta(days=401))}):
        assert (await api.post(f"{API}/mocks", json={"day": iso(TODAY), **bad})).status_code == 422, bad
    old = (await api.post(f"{API}/mocks", json={"day": iso(YESTERDAY - timedelta(days=7)), "listening": "5.5", "reading": "6.0", "note": " first "})).json()
    assert old["note"] == "first" and old["writing"] is None
    (await api.post(f"{API}/mocks", json={"day": iso(YESTERDAY), "listening": "6.5", "reading": "6.0", "speaking": "5.0"})).raise_for_status()
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert course["skills"] == [{"skill": "listening", "band": "6.5", "trend": "+1.0"}, {"skill": "reading", "band": "6.0", "trend": "0"}, {"skill": "writing", "band": None, "trend": None}, {"skill": "speaking", "band": "5.0", "trend": None}]
    assert [m["day"] for m in (await api.get(f"{API}/mocks")).json()] == [iso(YESTERDAY), iso(YESTERDAY - timedelta(days=7))]
    assert [(a["skill"], a["icon"]) for a in course["adaptations"]] == [("listening", "trending-up")]  # only a band at or above the 6.5 target


def test_mock_due_rule():
    sunday = date(2030, 1, 6)
    assert sunday.weekday() == 6
    first, last = date(2029, 12, 31), date(2030, 1, 6)
    assert plan.mock_due(sunday, 3, first, last, [])
    assert not plan.mock_due(sunday, 2, first, last, [])  # mocks start in week 3
    assert not plan.mock_due(sunday - timedelta(days=1), 3, first, last, [])  # only on Sunday
    assert not plan.mock_due(sunday, 3, first, last, [date(2030, 1, 3)])  # already done this week
    assert plan.mock_due(sunday, 4, last + timedelta(days=1), last + timedelta(days=7), [date(2030, 1, 3)])


def test_plan_week_math():
    start = date(2030, 1, 1)
    assert [plan.week_of(start, start + timedelta(days=d)) for d in (0, 6, 7, 13, 14, 69, 70, 500)] == [1, 1, 2, 2, 3, 10, 10, 10]
    assert plan.week_of(None, start) == 1 and plan.week_of(start, start - timedelta(days=3)) == 1
    assert len(plan.PLAN) == 10


def test_skill_bands_from_lessons_and_reports():
    def listening(pct): return {"listening": {"pct": pct}}
    expected = {95: "7.0", 80: "6.5", 75: "6.0", 60: "5.5", 50: "5.0", 49: "4.5"}
    for pct, band in expected.items():
        assert plan.skill_bands([], [listening(pct)], [])[0]["band"] == band
    rounds = {"speaking": {"rounds": {"4": {"criteria": {"fluency": "≈5.0", "lexical": "≈6.0", "grammar": "≈6.0"}, "pauses": 2}}}}
    reports = [{"criteria": {"task_response": "≈6.0", "coherence": "≈7.0", "lexical": "≈6.0", "grammar": "≈6.0"}}, {"kind": "journal"}]
    by_skill = {s["skill"]: s["band"] for s in plan.skill_bands([], [rounds], reports)}
    assert by_skill == {"listening": None, "reading": None, "writing": "≈6.5", "speaking": "≈5.5"}  # 5.67 -> 5.5, 6.25 -> 6.5
    mock = SimpleNamespace(listening="7.0", reading=None, writing=None, speaking=None)
    assert plan.skill_bands([mock], [listening(10)], [])[0] == {"skill": "listening", "band": "7.0", "trend": None}


def test_adaptation_rules():
    def result(*types): return {"errors": [{"type": t} for t in types]}
    lessons_ = [{"listening": {"pct": 60}}, {"listening": {"pct": 80}}]
    assert plan.adaptations(lessons_, [], [], "6.5") == []  # 70% is not below the line
    slow = plan.adaptations([{"listening": {"pct": 60}}, {"listening": {"pct": 70}}], [], [], "6.5")
    assert slow[0]["skill"] == "listening" and "0.9" in slow[0]["detail"] and "65%" in slow[0]["detail"]
    pausey = {"speaking": {"rounds": {"2": {"pauses": 4}, "3": {"pauses": 5}}}}
    assert plan.adaptations([pausey], [], [], "6.5")[0]["skill"] == "speaking"
    calm = {"speaking": {"rounds": {"2": {"pauses": 3}, "3": {"pauses": 4}}}}
    assert plan.adaptations([calm], [], [], "6.5") == []
    three = [result("article", "tense"), result("article"), result("article", "other")]
    [error] = plan.adaptations([], three, [], "6.5")
    assert error["title"] == "Артикли — 3 урока подряд:" and error["detail"] == "добавлено мини-упражнение в разминку."
    assert plan.adaptations([], [result("article"), result("tense"), result("article")], [], "6.5") == []  # not consecutive
    assert plan.recurring_error([result("tense")] * 5) == ("tense", 5) and plan.lessons_ru(5) == "5 уроков" and plan.lessons_ru(22) == "22 урока" and plan.lessons_ru(11) == "11 уроков"
    on_target = plan.adaptations([], [], [{"skill": "reading", "band": "7.0", "trend": None}, {"skill": "writing", "band": "6.0", "trend": None}], "6.5")
    assert [(a["skill"], a["icon"]) for a in on_target] == [("reading", "trending-up")]


@pytest.mark.asyncio
async def test_recurring_error_adds_drill_to_next_lesson(client, ai):
    api, sessions = client
    calls, replies = ai
    owner = await owner_id(sessions)
    async with sessions() as session:
        from app.core.models import EnglishReport
        for offset in (3, 2, 1):
            session.add(EnglishReport(owner_id=owner, day=TODAY - timedelta(days=offset), text="old report text", cefr="B1", result_json=correction(errors=[{"original": "a", "correction": "b", "type": "article", "explanation_ru": "x", "severity": "minor"}])))
        await session.commit()
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert course["adaptations"][0]["title"] == "Артикли — 3 урока подряд:"
    lesson = await make_lesson(api, replies, drill=gaps(["the", "a"]))
    assert lesson["content"]["drill"] == {"type": "article", "items": gaps(["the", "a"])}
    assert "Recurring mistake type in recent writing: article (3 reports in a row)." in calls[0][1] and "practising article mistakes" in calls[0][0]
    plain = await make_lesson(api, replies, YESTERDAY)
    assert plain["content"]["drill"] is None  # nothing generated, nothing shown


@pytest.mark.asyncio
async def test_lessons_are_owner_scoped(client, ai):
    api, sessions = client
    lesson = await make_lesson(api, ai[1])
    await other_owner(api, sessions)
    path = f"{API}/lessons/{lesson['id']}"
    word_id = lesson["content"]["vocab"][0]["word_id"]
    responses = [
        await api.get(path),
        await api.post(f"{path}/blocks/vocab/done", json={}),
        await api.post(f"{path}/listening", json={"answers": {"1": "a"}}),
        await api.post(f"{path}/speaking", json={"round": 4, "transcript": "hello there", "duration_sec": 5}),
        await api.post(f"{path}/sentences", json={"items": [{"word_id": word_id, "sentence": "A fine sentence."}]}),
    ]
    assert all(r.status_code == 404 and r.json()["detail"]["code"] == "NOT_FOUND" for r in responses)
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert course["today"]["id"] is None and course["hours_done"] == 0 and course["week_stats"]["new_words"] == 0 and course["lesson_no"] == 1
    assert (await api.get(f"{API}/mocks")).json() == []


# ---- transcription ----------------------------------------------------------------------------------------------------------------------------

async def add_transcriber(sessions, **policy):
    async with sessions() as session:
        owner = await owner_id(sessions)
        provider = AIProvider(owner_id=owner, kind="transcription", enabled=True, model_policy_json={"default_model": "whisper-test", **policy})
        session.add(provider)
        await session.flush()
        session.add(AIProviderSecret(owner_id=owner, provider_id=provider.id, encrypted_value=encrypt_secret("synthetic-audio-key")))
        await session.commit()


def upload(api, data=b"private speech bytes", mime="audio/webm;codecs=opus"):
    return api.post(f"{API}/speech/transcribe", files={"audio": ("evil/../name.webm", data, mime)})


@pytest.mark.asyncio
async def test_transcribe_not_configured_and_input_checks(client):
    api, _ = client
    response = await upload(api)
    assert response.status_code == 409 and response.json()["detail"]["code"] == "TRANSCRIPTION_NOT_CONFIGURED"
    assert (await upload(api, mime="audio/flac")).json()["detail"]["code"] == "AUDIO_UNSUPPORTED"
    assert (await upload(api, mime="text/plain")).status_code == 415
    assert (await upload(api, data=b"")).json()["detail"]["code"] == "AUDIO_EMPTY"
    big = await upload(api, data=b"0" * (10 * 1024 * 1024 + 1))
    assert big.status_code == 413 and big.json()["detail"]["code"] == "AUDIO_TOO_LARGE"
    assert (await api.post(f"{API}/speech/transcribe", json={})).status_code == 415
    assert (await api.post(f"{API}/speech/transcribe", files={"other": ("a.webm", b"x", "audio/webm")})).json()["detail"]["code"] == "AUDIO_EMPTY"
    raw_big = await api.post(f"{API}/speech/transcribe", content=b"0" * (10 * 1024 * 1024 + 1), headers={"content-type": "audio/webm"})
    assert raw_big.status_code == 413


@pytest.mark.asyncio
async def test_transcribe_happy_path_records_run_and_never_leaks(client, monkeypatch, caplog):
    api, sessions = client
    await add_transcriber(sessions)
    seen = []

    def handler(request):
        seen.append(request)
        assert request.headers["authorization"] == "Bearer synthetic-audio-key" and request.url.path == "/v1/audio/transcriptions"
        assert b"private speech bytes" in request.content and b'name="model"' in request.content and b"whisper-test" in request.content
        assert b"evil" not in request.content and b'filename="speech.webm"' in request.content
        return httpx.Response(200, json={"text": "  I went to the library.  ", "duration": 41.6})

    monkeypatch.setattr(telegram_transcription, "transcription_transport", lambda: httpx.MockTransport(handler))
    response = await upload(api)
    assert response.status_code == 200, response.text
    assert response.json() == {"text": "I went to the library.", "duration_sec": 42}
    assert len(seen) == 1 and "private speech bytes" not in caplog.text and "synthetic-audio-key" not in caplog.text
    async with sessions() as session:
        run = (await session.execute(select(AIRun))).scalar_one()
        assert (run.provider, run.model, run.status, str(run.idempotency_key).startswith("english-transcription:")) == ("transcription", "whisper-test", "completed", True)
        assert "private speech bytes" not in str(run.token_counts)
    monkeypatch.setattr(telegram_transcription, "transcription_transport", lambda: httpx.MockTransport(lambda r: httpx.Response(200, json={"text": "ok"})))
    assert (await upload(api, mime="audio/mp4")).json() == {"text": "ok", "duration_sec": None}
    # The web app and the native bridge send the recording as a raw audio/* body.
    raw = await api.post(f"{API}/speech/transcribe", content=b"raw speech", headers={"content-type": "audio/webm;codecs=opus"})
    assert raw.status_code == 200 and raw.json() == {"text": "ok", "duration_sec": None}


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", [httpx.Response(401, text="synthetic-audio-key"), httpx.Response(200, json={"text": ""}), httpx.Response(200, json={"bad": 1}), httpx.Response(200, json={"text": "x" * 20001}), httpx.Response(200, text="not json")])
async def test_transcribe_provider_failure_is_generic(client, monkeypatch, reply):
    api, sessions = client
    await add_transcriber(sessions)
    monkeypatch.setattr(telegram_transcription, "transcription_transport", lambda: httpx.MockTransport(lambda r: reply))
    response = await upload(api)
    assert response.status_code == 502 and response.json()["detail"] == {"code": "TRANSCRIPTION_UNAVAILABLE", "message": "Не удалось распознать запись"}
    assert "synthetic-audio-key" not in response.text
    async with sessions() as session:
        assert (await session.execute(select(AIRun.status))).scalar_one() == "failed"


@pytest.mark.asyncio
async def test_transcribe_budget_and_owner_scope(client, monkeypatch):
    api, sessions = client
    monkeypatch.setattr(telegram_transcription, "transcription_transport", lambda: httpx.MockTransport(lambda r: httpx.Response(200, json={"text": "ok"})))
    await add_transcriber(sessions, monthly_budget="0.05")  # one request is estimated at 0.10
    response = await upload(api)
    assert response.status_code == 429 and response.json()["detail"]["code"] == "BUDGET_EXCEEDED"
    async with sessions() as session:
        assert (await session.execute(select(sa.func.count()).select_from(AIRun))).scalar_one() == 0
    await other_owner(api, sessions)  # the first owner's provider is never used for someone else
    assert (await upload(api)).json()["detail"]["code"] == "TRANSCRIPTION_NOT_CONFIGURED"
    assert english_speech.MAX_BYTES == 10 * 1024 * 1024


# ---- migration --------------------------------------------------------------------------------------------------------------------------------

def test_0047_upgrades_a_0046_database_and_downgrades(tmp_path):
    filename = tmp_path / "course.db"
    url = f"sqlite+aiosqlite:///{filename}"
    run_alembic(url, "upgrade", "0046_english_daily")
    engine = sa.create_engine(f"sqlite:///{filename}")
    try:
        added = ("goal", "target_band", "level", "weak_skills", "minutes_per_day", "exam_date", "course_started_on")
        with engine.begin() as db:  # 0001 builds current metadata; strip the 0047 objects to look like a real 0046 install
            db.execute(sa.text("DROP TABLE english_lessons"))
            db.execute(sa.text("DROP TABLE english_mocks"))
            for column in added:
                db.execute(sa.text(f"ALTER TABLE english_profiles DROP COLUMN {column}"))
            db.execute(sa.text("INSERT INTO users (id, created_at, settings_json) VALUES ('owner', CURRENT_TIMESTAMP, '{}')"))
            db.execute(sa.text("INSERT INTO english_profiles (id, owner_id, version, created_at, updated_at, reminder_enabled, reminder_time, timezone) VALUES ('p', 'owner', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, '20:00', 'Asia/Almaty')"))
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
        with engine.connect() as db:
            row = db.execute(sa.text("SELECT reminder_time, goal, target_band, level, weak_skills, minutes_per_day, exam_date FROM english_profiles")).one()
            assert tuple(row)[:4] == ("20:00", "ielts_academic", "6.5", "b1b2") and "speaking" in row[4] and row[5:] == (120, None)
        inspector = sa.inspect(engine)
        assert inspector.has_table("english_lessons") and inspector.has_table("english_mocks")
        assert any(set(c["column_names"]) == {"owner_id", "day"} for c in inspector.get_unique_constraints("english_lessons"))
        run_alembic(url, "downgrade", "0046_english_daily")
        inspector = sa.inspect(engine)
        assert not inspector.has_table("english_lessons") and not {c["name"] for c in inspector.get_columns("english_profiles")} & set(added)
        run_alembic(url, "upgrade", "head")
        run_alembic(url, "check")
    finally:
        engine.dispose()


# ---- review fixes -----------------------------------------------------------------------------------------------------------------------------

SPEAKING_REPLY = {"criteria": {"fluency": "≈5.0", "lexical": "≈5.0", "grammar": "≈5.0"}, "pauses": 1, "corrected_html_safe": [{"type": "same", "text": "x" * 5000}]}  # long segments are fine


@pytest.mark.asyncio
async def test_speaking_does_not_clobber_progress_written_during_the_ai_call(client, ai, monkeypatch):
    api, _ = client
    _calls, replies = ai
    lesson = await make_lesson(api, replies)
    path = f"{API}/lessons/{lesson['id']}"

    async def slow(db, owner_id, system, user_text, max_tokens):  # the learner's listening check lands while the model is still answering
        (await api.post(f"{path}/listening", json={"answers": right(lesson)})).raise_for_status()
        return SPEAKING_REPLY

    monkeypatch.setattr(lessons, "complete_json", slow)
    (await api.post(f"{path}/speaking", json={"round": 4, "transcript": "hello there", "duration_sec": 50})).raise_for_status()
    progress = (await api.get(path)).json()["progress"]
    assert progress["listening"]["done"] is True and progress["listening"]["score"] == 5 and set(progress["speaking"]["rounds"]) == {"4"}


@pytest.mark.asyncio
async def test_report_does_not_clobber_progress_written_during_the_ai_call(client, ai, monkeypatch):
    api, _ = client
    _calls, replies = ai
    lesson = await make_lesson(api, replies)
    path = f"{API}/lessons/{lesson['id']}"

    async def slow(db, owner_id, system, user_text, max_tokens):
        (await api.post(f"{path}/listening", json={"answers": right(lesson)})).raise_for_status()
        return correction()

    monkeypatch.setattr(english_api, "complete_json", slow)
    (await api.post(f"{API}/reports", json={"day": iso(TODAY), "text": "x" * 30})).raise_for_status()
    progress = (await api.get(path)).json()["progress"]
    assert progress["listening"]["done"] is True and progress["writing"]["done"] is True


@pytest.mark.asyncio
async def test_concurrent_lesson_generation_returns_the_winner(client, ai, monkeypatch):
    api, sessions = client
    _calls, replies = ai
    winner, normal = {}, lessons.complete_json

    async def racing(db, owner_id, system, user_text, max_tokens):  # another request finishes the same day first
        monkeypatch.setattr(lessons, "complete_json", normal)
        winner.update(await make_lesson(api, replies))
        return lesson_reply(vocab=["zebra", "yak", "wolf"])

    monkeypatch.setattr(lessons, "complete_json", racing)
    response = await api.post(f"{API}/lessons/today", json={"day": iso(TODAY)})
    assert response.status_code == 200 and response.json()["id"] == winner["id"]
    async with sessions() as session:
        assert (await session.execute(select(sa.func.count()).select_from(EnglishLesson))).scalar_one() == 1
        assert not (await session.execute(select(EnglishWord).where(EnglishWord.lemma == "zebra"))).scalars().all()


@pytest.mark.asyncio
async def test_lesson_generation_accepts_null_drill_and_prompt(client, ai, monkeypatch):
    api, _ = client
    monkeypatch.setattr(lessons, "TASK2_WEEKDAYS", ())
    lesson = await make_lesson(api, ai[1], drill=None, writing={"prompt": None})
    assert lesson["content"]["drill"] is None and lesson["content"]["writing"] == {"kind": "journal", "prompt": None}


@pytest.mark.asyncio
async def test_rejected_ai_output_is_still_recorded_as_spend(client, monkeypatch):
    api, sessions = client
    async with sessions() as session:
        owner = await owner_id(sessions)
        provider = AIProvider(owner_id=owner, kind="claude", enabled=True, model_policy_json={})
        session.add(provider)
        await session.flush()
        session.add(AIProviderSecret(owner_id=owner, provider_id=provider.id, encrypted_value=encrypt_secret("synthetic-key")))
        await session.commit()
    texts = ['{"nonsense": true}', "not json at all"]

    class Service:
        async def complete(self, *args, **kwargs):
            usage = SimpleNamespace(input_tokens=10, output_tokens=20)
            return SimpleNamespace(provider="claude", model="m", usage=SimpleNamespace(usage=usage, estimated_cost=0.5), response=SimpleNamespace(text=texts.pop(0), tool_calls=[]))

    monkeypatch.setattr(english_ai.ai_api, "_service", lambda *a, **k: Service())
    for expected in (1, 2):
        response = await api.post(f"{API}/lessons/today", json={"day": iso(TODAY)})
        assert response.status_code == 502 and response.json()["detail"]["code"] == "AI_BAD_OUTPUT"
        async with sessions() as session:
            assert (await session.execute(select(sa.func.count()).select_from(AIRun))).scalar_one() == expected


@pytest.mark.asyncio
async def test_skill_on_target_is_fed_into_the_next_lesson_prompt(client, ai):
    api, _ = client
    calls, replies = ai
    (await api.post(f"{API}/mocks", json={"day": iso(YESTERDAY), "reading": "7.0", "writing": "5.0"})).raise_for_status()
    await make_lesson(api, replies)
    assert "Skills already at the target band: reading;" in calls[0][1] and "writing" not in calls[0][1]


@pytest.mark.asyncio
async def test_one_mock_per_day_merges_and_course_reads_only_recent_mocks(client, monkeypatch):
    api, _sessions = client
    first = (await api.post(f"{API}/mocks", json={"day": iso(TODAY), "listening": "5.5", "note": "morning"})).json()
    second = (await api.post(f"{API}/mocks", json={"day": iso(TODAY), "reading": "6.0"})).json()
    assert second["id"] == first["id"] and (second["listening"], second["reading"], second["note"]) == ("5.5", "6.0", "morning")
    assert len((await api.get(f"{API}/mocks")).json()) == 1
    monkeypatch.setattr(lessons, "MOCKS_SEEN", 1)
    for back in (1, 2, 3):
        (await api.post(f"{API}/mocks", json={"day": iso(TODAY - timedelta(days=back)), "writing": "6.0"})).raise_for_status()
    course = (await api.get(f"{API}/course", params={"day": iso(TODAY)})).json()
    assert next(s for s in course["skills"] if s["skill"] == "listening")["band"] == "5.5" and next(s for s in course["skills"] if s["skill"] == "writing")["band"] is None
