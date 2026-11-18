"""Persisted history filtering shared by ordinary context and reverse pages."""
from datetime import UTC, datetime, timedelta

import pytest
from app.ai import chat_support
from app.ai.memory_models import OwnerMemoryFact
from app.core.db import Base
from app.core.models import AIConversation, AIMessage, AIRun, AIRunEvent, User
from sqlalchemy import and_, event, or_, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

AT = datetime(2026, 1, 1, tzinfo=UTC)


@pytest.fixture
async def history_db(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/history.db")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        db.add_all([User(id="owner"), User(id="other")])
        await db.flush()
        db.add_all([
            AIConversation(id="chat", owner_id="owner"),
            AIConversation(id="second", owner_id="owner"),
            AIConversation(id="foreign", owner_id="other"),
        ])
        await db.flush()
        yield db
    await engine.dispose()


def message(db, number, *, role="user", conversation="chat", refs=None, at=None):
    row = AIMessage(id=f"m{number:04}", conversation_id=conversation, role=role,
                    content=f"message {number}", source_refs_json=refs or [],
                    created_at=at if at is not None else AT + timedelta(seconds=number))
    db.add(row)
    return row


def run(db, prompt, status, *, owner="owner", conversation=None):
    db.add(AIRun(owner_id=owner, conversation_id=conversation or prompt.conversation_id,
                 prompt_message_id=prompt.id, provider="claude", model="test", status=status))


def fact(db, name, *, owner="owner", version=1, deleted=False, expired=False):
    row = OwnerMemoryFact(id=name, owner_id=owner, text="Synthetic memory", kind="fact", source="app",
                          normalized_hash=name, version=version,
                          deleted_at=AT if deleted else None, expires_at=AT if expired else None)
    db.add(row)
    return {"kind": "owner_memory_fact", "id": name, "version": 1}


async def filtered(db, entries, **kwargs):
    helper = getattr(chat_support, "filter_history_messages", None)
    assert callable(helper), "the shared async history filter is not implemented"
    return await helper(db, "owner", entries, **kwargs)


@pytest.mark.parametrize("statuses,keep", [
    ([], True), (["completed"], True), (["running"], False), (["queued"], False),
    (["failed"], False), (["cancelled"], False), (["failed", "completed"], True),
])
async def test_prior_prompt_requires_any_completed_run(history_db, statuses, keep):
    db = history_db
    prompt = message(db, 1)
    await db.flush()
    for status in statuses:
        run(db, prompt, status)
    await db.flush()
    result = await filtered(db, [prompt])
    assert [row.id for row in result] == (["m0001"] if keep else [])


async def test_only_exact_owned_current_user_bypasses_both_filters(history_db):
    db = history_db
    missing = [{"kind": "owner_memory_fact", "id": "missing", "version": 1}]
    prior = message(db, 1, refs=missing)
    current = message(db, 2, refs=missing)
    answer = message(db, 3, role="assistant", refs=missing)
    foreign = message(db, 4, conversation="foreign", refs=missing)
    await db.flush()
    run(db, prior, "running")
    run(db, current, "running")
    await db.flush()
    assert [row.id for row in await filtered(db, [foreign, answer, current, prior], current_id=current.id)] == ["m0002"]
    assert await filtered(db, [answer], current_id=answer.id) == []
    assert await filtered(db, [foreign], current_id=foreign.id) == []


@pytest.mark.parametrize("state", ["changed", "deleted", "expired", "missing", "foreign", "bad-version", "bad-id"])
async def test_invalid_memory_answer_removes_its_question(history_db, state):
    db = history_db
    ref = fact(db, "fact", version=2 if state == "changed" else 1,
               deleted=state == "deleted", expired=state == "expired", owner="other" if state == "foreign" else "owner")
    if state == "missing":
        ref["id"] = "absent"
    elif state == "bad-version":
        ref["version"] = True
    elif state == "bad-id":
        ref["id"] = None
    question = message(db, 1)
    answer = message(db, 2, role="assistant", refs=[ref])
    current = message(db, 3)
    await db.flush()
    run(db, question, "completed")
    await db.flush()
    assert [row.id for row in await filtered(db, [current, answer, question])] == ["m0003"]


async def test_active_memory_and_input_order_are_preserved(history_db):
    db = history_db
    ref = fact(db, "fact")
    question = message(db, 1)
    answer = message(db, 2, role="assistant", refs=[ref, {"untrusted": True}])
    second = message(db, 3, conversation="second")
    await db.flush()
    entries = [second, answer, question]
    assert await filtered(db, entries) == entries
    assert entries == [second, answer, question]


@pytest.mark.parametrize("boundary", ["cursor", "period", "limit"])
async def test_stale_answer_outside_selection_cannot_resurrect_question(history_db, boundary):
    db = history_db
    question = message(db, 1)
    answer = message(db, 2, role="assistant", refs=[fact(db, "fact", deleted=True)])
    later = message(db, 3)
    await db.flush()
    query = select(AIMessage).where(AIMessage.conversation_id == "chat")
    if boundary == "cursor":
        query = query.where(or_(AIMessage.created_at < answer.created_at,
                                and_(AIMessage.created_at == answer.created_at, AIMessage.id < answer.id)))
    elif boundary == "period":
        query = query.where(AIMessage.created_at <= question.created_at)
    else:
        query = query.where(AIMessage.id != later.id).order_by(AIMessage.created_at, AIMessage.id).limit(1)
    page = list((await db.scalars(query)).all())
    assert [row.id for row in page] == ["m0001"]
    assert await filtered(db, page) == []


async def test_same_timestamp_pairing_uses_id_and_nearest_persisted_question(history_db):
    db = history_db
    old = message(db, 1, at=AT)
    question = message(db, 2, at=AT)
    answer = message(db, 3, at=AT, role="assistant", refs=[fact(db, "fact", deleted=True)])
    later = message(db, 4, at=AT)
    await db.flush()
    assert [row.id for row in await filtered(db, [later, answer, question, old])] == ["m0004", "m0001"]
    assert [row.id for row in await filtered(db, [answer, old])] == ["m0001"]
    assert await filtered(db, [question]) == []


async def test_pairing_and_run_status_are_scoped_to_owner_and_conversation(history_db):
    db = history_db
    question = message(db, 1)
    second = message(db, 2, conversation="second")
    foreign = message(db, 3, conversation="foreign")
    stale = message(db, 4, role="assistant", refs=[fact(db, "fact", deleted=True)])
    foreign_answer = message(db, 5, conversation="foreign", role="assistant", refs=[{"kind": "owner_memory_fact", "id": "missing", "version": 1}])
    await db.flush()
    run(db, second, "failed", conversation="chat")
    run(db, second, "failed", owner="other")
    await db.flush()
    assert [row.id for row in await filtered(db, [foreign_answer, stale, foreign, second, question])] == ["m0002"]


async def test_large_history_batches_memory_without_per_message_queries(history_db):
    db = history_db
    entries = []
    for i in range(205):
        entries.append(message(db, 2 * i + 1))
        entries.append(message(db, 2 * i + 2, role="assistant", refs=[fact(db, f"fact-{i:03}")]))
    await db.flush()
    queries = []

    def record_query(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            queries.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", record_query)
    try:
        result = await filtered(db, list(reversed(entries)))
    finally:
        event.remove(engine, "before_cursor_execute", record_query)
    assert [row.id for row in result] == [f"m{i:04}" for i in range(410, 0, -1)]
    assert len(queries) <= 7


async def test_conversation_history_keeps_limit_current_and_metadata(history_db):
    db = history_db
    ref = fact(db, "fact")
    message(db, 1)
    answer = message(db, 2, role="assistant", refs=[ref, {"untrusted": True}])
    current = message(db, 3)
    message(db, 4)
    await db.flush()
    run(db, current, "running")
    await db.flush()
    for limit in (20, 100):
        history = await chat_support.conversation_history(db, "owner", "chat", current, limit=limit)
        assert [row.content for row in history] == ["message 1", "message 2", "message 3"]
        assert history[1].untrusted is True
        assert history[1].memory_refs == (("fact", 1),)
    limited = await chat_support.conversation_history(db, "owner", "chat", current, limit=2)
    assert [row.content for row in limited] == [answer.content, current.content]


@pytest.mark.parametrize("channel,tools,present", [
    ("telegram", True, True), ("telegram", False, False),
    ("app", True, False), ("app", False, False),
    ("voice", True, False), ("voice", False, False),
])
def test_history_instruction_is_only_in_telegram_prompt_with_tools(channel, tools, present):
    prompt = chat_support.system_prompt("UTC", channel=channel, tools=tools)
    instruction = "Read chat history only when the current question depends on earlier conversation."
    assert (instruction in prompt) is present


@pytest.mark.parametrize("same_time", [False, True])
async def test_exact_reply_link_preserves_interleaved_web_question(history_db, same_time):
    db = history_db
    telegram = message(db, 1, at=AT if same_time else None)
    web = message(db, 2, at=AT if same_time else None)
    answer = message(db, 3, role="assistant", at=AT if same_time else None,
                     refs=[fact(db, "deleted", deleted=True)])
    await db.flush()
    linked = AIRun(owner_id="owner", conversation_id="chat", prompt_message_id=telegram.id,
                   provider="claude", model="test", status="completed")
    db.add(linked)
    await db.flush()
    db.add(AIRunEvent(run_id=linked.id, sequence=1, event_id=f"{linked.id}:1",
                      event_type="ai.run.completed", payload={"reply_message_id": answer.id}))
    await db.flush()
    assert [row.id for row in await filtered(db, [answer, web, telegram])] == ["m0002"]
    assert await filtered(db, [telegram]) == []
    assert [row.id for row in await filtered(db, [web])] == ["m0002"]


async def test_alternating_long_history_has_bounded_database_work(history_db):
    db = history_db
    entries = [message(db, i + 1, role="user" if i % 2 == 0 else "assistant") for i in range(3000)]
    await db.flush()
    connection = await db.connection()
    raw = await connection.get_raw_connection()
    instructions = 0

    def count_work():
        nonlocal instructions
        instructions += 1000
        # Deterministic SQLite VM budget, not a wall-time assertion.
        return int(instructions > 2_000_000)

    await raw.driver_connection.set_progress_handler(count_work, 1000)
    try:
        result = await filtered(db, list(reversed(entries[-20:])))
    finally:
        await raw.driver_connection.set_progress_handler(None, 0)
    assert [row.id for row in result] == [f"m{i:04}" for i in range(3000, 2980, -1)]
    assert instructions <= 2_000_000


@pytest.mark.parametrize("invalid_link", ["owner", "run-conversation", "prompt-conversation", "event-type", "payload"])
async def test_invalid_exact_links_cannot_override_legacy_pairing(history_db, invalid_link):
    db = history_db
    earlier = message(db, 1)
    question = message(db, 2)
    other_question = message(db, 3, conversation="second")
    answer = message(db, 4, role="assistant", refs=[fact(db, "deleted", deleted=True)])
    await db.flush()
    linked = AIRun(owner_id="other" if invalid_link == "owner" else "owner",
                   conversation_id="second" if invalid_link == "run-conversation" else "chat",
                   prompt_message_id=other_question.id if invalid_link == "prompt-conversation" else earlier.id,
                   provider="claude", model="test", status="completed")
    db.add(linked)
    await db.flush()
    db.add(AIRunEvent(run_id=linked.id, sequence=1, event_id=f"{linked.id}:1",
                      event_type="ai.run.started" if invalid_link == "event-type" else "ai.run.completed",
                      payload={"reply_message_id": [] if invalid_link == "payload" else answer.id}))
    await db.flush()
    assert [row.id for row in await filtered(db, [answer, question, earlier])] == ["m0001"]
    assert [row.id for row in await filtered(db, [earlier])] == ["m0001"]
    assert await filtered(db, [question]) == []
