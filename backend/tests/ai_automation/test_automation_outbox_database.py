"""Database contracts for durable automation delivery."""

from uuid import uuid4

import pytest
from app.core.models import AutomationExecution
from sqlalchemy import text


@pytest.mark.asyncio
async def test_execution_accepts_real_task_created_event_id(ai_test_engine):
    assert AutomationExecution.__tablename__ == "automation_executions"
    event_id = f"task.created:{uuid4()}"
    async with ai_test_engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO automation_executions "
                "(id, owner_id, rule_id, event_id, run_status, attempt, started_at) "
                "VALUES (:id, :owner, :rule, :event, 'completed', 1, CURRENT_TIMESTAMP)"
            ),
            {"id": str(uuid4()), "owner": str(uuid4()), "rule": str(uuid4()), "event": event_id},
        )
        assert await connection.scalar(
            text("SELECT event_id FROM automation_executions WHERE event_id = :event"),
            {"event": event_id},
        ) == event_id


@pytest.mark.asyncio
async def test_postgres_overlapping_attempts_when_first_crashes(ai_test_engine, monkeypatch):
    import asyncio
    from datetime import timedelta

    from app.automation import api, hooks
    from app.core import db as database
    from app.core.models import (
        AutomationOutbox,
        AutomationRule,
        Notification,
        User,
        now,
    )
    from sqlalchemy import func, select, update
    from sqlalchemy.ext.asyncio import async_sessionmaker

    if ai_test_engine.dialect.name != "postgresql":
        pytest.skip("PostgreSQL concurrency contract")
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", factory)
    owner = str(uuid4())
    row_id = str(uuid4())
    async with factory() as session:
        session.add(User(id=owner))
        await session.flush()
        for i in range(2):
            session.add(AutomationRule(id=f"rule-{i}", owner_id=owner, name="test", enabled=True,
                trigger_kind="task.created", conditions_json={},
                actions_json=[{"kind": "create_notification", "args": {"title": f"rule {i}"}}],
                policy_ref="safe", rate_limit_json={}))
        session.add(AutomationOutbox(id=row_id, owner_id=owner, kind="task.created",
            event_id=f"task.created:{uuid4()}", payload={}, created_at=now(), available_at=now(), attempts=0))
        await session.commit()

    a_holds_rule = asyncio.Event()
    b_claiming = asyncio.Event()
    release_a = asyncio.Event()
    authorize = api._authorize_action
    claim = api._claim_execution

    async def gated_authorize(**kwargs):
        if asyncio.current_task().get_name() == "attempt-A":
            a_holds_rule.set()
            await release_a.wait()
            raise asyncio.CancelledError()
        return await authorize(**kwargs)

    async def observed_claim(*args, **kwargs):
        if asyncio.current_task().get_name() == "attempt-B":
            b_claiming.set()
        return await claim(*args, **kwargs)

    monkeypatch.setattr(api, "_authorize_action", gated_authorize)
    monkeypatch.setattr(api, "_claim_execution", observed_claim)
    first = asyncio.create_task(hooks.deliver_pending(), name="attempt-A")
    await asyncio.wait_for(a_holds_rule.wait(), 5)
    async with factory() as session:
        await session.execute(update(AutomationOutbox).where(AutomationOutbox.id == row_id)
                              .values(available_at=now() - timedelta(seconds=1)))
        await session.commit()
    second = asyncio.create_task(hooks.deliver_pending(), name="attempt-B")
    await asyncio.wait_for(b_claiming.wait(), 5)
    release_a.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    await asyncio.wait_for(second, 5)
    async with factory() as session:
        assert await session.scalar(select(func.count()).select_from(AutomationOutbox)) == 0
        assert await session.scalar(select(func.count()).select_from(Notification)) == 2
        statuses = (await session.scalars(select(AutomationExecution.run_status)
                         .order_by(AutomationExecution.rule_id))).all()
        assert statuses == ["completed", "completed"]


@pytest.mark.asyncio
async def test_postgres_created_rule_not_lost_on_overlap(ai_test_engine, monkeypatch):
    import asyncio
    from datetime import timedelta

    from app.automation import api, hooks
    from app.core import db as database
    from app.core.models import (
        AutomationOutbox,
        AutomationRule,
        Notification,
        User,
        now,
    )
    from sqlalchemy import func, select, update
    from sqlalchemy.ext.asyncio import async_sessionmaker

    if ai_test_engine.dialect.name != "postgresql":
        pytest.skip("PostgreSQL concurrency contract")
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", factory)
    owner, event_row_id = str(uuid4()), str(uuid4())

    def rule(rule_id):
        return AutomationRule(id=rule_id, owner_id=owner, name="test", enabled=True, created_at=now() - timedelta(minutes=1),
            trigger_kind="task.created", conditions_json={},
            actions_json=[{"kind": "create_notification", "args": {"title": rule_id}}],
            policy_ref="safe", rate_limit_json={})

    async with factory() as session:
        session.add(User(id=owner))
        await session.flush()
        session.add(rule("rule-1"))
        session.add(AutomationOutbox(id=event_row_id, owner_id=owner, kind="task.created",
            event_id=f"task.created:{uuid4()}", payload={}, created_at=now(), available_at=now(), attempts=0))
        await session.commit()

    a_locked, b_started, a_finished, release_a = (asyncio.Event() for _ in range(4))
    authorize, claim = api._authorize_action, api._claim_execution

    async def gated_authorize(**kwargs):
        if asyncio.current_task().get_name() == "attempt-A":
            a_locked.set()
            await release_a.wait()
        return await authorize(**kwargs)

    async def gated_claim(*args, **kwargs):
        if asyncio.current_task().get_name() == "attempt-B":
            if kwargs["rule_id"] == "rule-1":
                b_started.set()
            if kwargs["rule_id"] == "rule-2":
                await a_finished.wait()
                raise asyncio.CancelledError()
        return await claim(*args, **kwargs)

    async def run_a():
        try:
            await hooks.deliver_pending()
        finally:
            a_finished.set()

    monkeypatch.setattr(api, "_authorize_action", gated_authorize)
    monkeypatch.setattr(api, "_claim_execution", gated_claim)
    first = asyncio.create_task(run_a(), name="attempt-A")
    await asyncio.wait_for(a_locked.wait(), 5)
    async with factory() as session:
        late = rule("rule-2")
        late.created_at = now() + timedelta(seconds=1)
        session.add(late)
        await session.execute(update(AutomationOutbox).where(AutomationOutbox.id == event_row_id)
                              .values(available_at=now() - timedelta(seconds=1)))
        await session.commit()
    second = asyncio.create_task(hooks.deliver_pending(), name="attempt-B")
    await asyncio.wait_for(b_started.wait(), 5)
    release_a.set()
    await asyncio.wait_for(first, 5)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(second, 5)
    async with factory() as session:
        delivered = await session.scalar(select(func.count()).select_from(Notification))
        remains = await session.scalar(select(func.count()).select_from(AutomationOutbox))
        assert delivered == 1 and remains == 1


@pytest.mark.asyncio
async def test_postgres_enabled_existing_rule_not_lost_on_overlap(ai_test_engine, monkeypatch):
    import asyncio
    from datetime import timedelta

    from app.automation import api, hooks
    from app.core import db as database
    from app.core.models import (
        AutomationOutbox,
        AutomationRule,
        Notification,
        User,
        now,
    )
    from sqlalchemy import func, select, update
    from sqlalchemy.ext.asyncio import async_sessionmaker

    if ai_test_engine.dialect.name != "postgresql":
        pytest.skip("PostgreSQL concurrency contract")
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", factory)
    owner, event_row_id = str(uuid4()), str(uuid4())

    def rule(rule_id):
        return AutomationRule(id=rule_id, owner_id=owner, name="test", enabled=True, created_at=now() - timedelta(minutes=1),
            trigger_kind="task.created", conditions_json={},
            actions_json=[{"kind": "create_notification", "args": {"title": rule_id}}],
            policy_ref="safe", rate_limit_json={})

    async with factory() as session:
        session.add(User(id=owner))
        await session.flush()
        session.add(rule("rule-1"))
        inactive = rule("rule-2")
        inactive.enabled = False
        session.add(inactive)
        session.add(AutomationOutbox(id=event_row_id, owner_id=owner, kind="task.created",
            event_id=f"task.created:{uuid4()}", payload={}, created_at=now(), available_at=now(), attempts=0))
        await session.commit()

    a_locked, b_started, a_finished, release_a = (asyncio.Event() for _ in range(4))
    authorize, claim = api._authorize_action, api._claim_execution

    async def gated_authorize(**kwargs):
        if asyncio.current_task().get_name() == "attempt-A":
            a_locked.set()
            await release_a.wait()
        return await authorize(**kwargs)

    async def gated_claim(*args, **kwargs):
        if asyncio.current_task().get_name() == "attempt-B":
            if kwargs["rule_id"] == "rule-1":
                b_started.set()
            if kwargs["rule_id"] == "rule-2":
                await a_finished.wait()
                raise asyncio.CancelledError()
        return await claim(*args, **kwargs)

    async def run_a():
        try:
            await hooks.deliver_pending()
        finally:
            a_finished.set()

    monkeypatch.setattr(api, "_authorize_action", gated_authorize)
    monkeypatch.setattr(api, "_claim_execution", gated_claim)
    first = asyncio.create_task(run_a(), name="attempt-A")
    await asyncio.wait_for(a_locked.wait(), 5)
    async with factory() as session:
        await session.execute(update(AutomationRule).where(AutomationRule.id == "rule-2").values(enabled=True))
        await session.execute(update(AutomationOutbox).where(AutomationOutbox.id == event_row_id)
                              .values(available_at=now() - timedelta(seconds=1)))
        await session.commit()
    second = asyncio.create_task(hooks.deliver_pending(), name="attempt-B")
    await asyncio.wait_for(b_started.wait(), 5)
    release_a.set()
    await asyncio.wait_for(first, 5)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(second, 5)
    async with factory() as session:
        delivered = await session.scalar(select(func.count()).select_from(Notification))
        remains = await session.scalar(select(func.count()).select_from(AutomationOutbox))
        assert delivered == 2 or remains == 1, "event removed while new matching rule remains unprocessed"


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["created", "enabled", "conditions"])
@pytest.mark.parametrize("older_first", [True, False])
async def test_postgres_overlapping_rule_changes_fenced(ai_test_engine, monkeypatch, change, older_first):
    import asyncio
    from datetime import timedelta

    from app.automation import api, hooks
    from app.core import db as database
    from app.core.models import (
        AutomationOutbox,
        AutomationRule,
        Notification,
        User,
        now,
    )
    from sqlalchemy import func, select, update
    from sqlalchemy.ext.asyncio import async_sessionmaker

    if ai_test_engine.dialect.name != "postgresql":
        pytest.skip("PostgreSQL concurrency contract")
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", factory)
    owner, row_id = str(uuid4()), str(uuid4())

    def make_rule(key, **kw):
        return AutomationRule(id=key, owner_id=owner, name="test", enabled=kw.get("enabled", True),
            trigger_kind="task.created", conditions_json=kw.get("conditions", {}),
            actions_json=[{"kind": "create_notification", "args": {"title": key}}],
            policy_ref="safe", rate_limit_json={})

    async with factory() as db:
        db.add(User(id=owner))
        await db.flush()
        db.add(make_rule("rule-1"))
        if change == "enabled":
            db.add(make_rule("rule-2", enabled=False))
        if change == "conditions":
            db.add(make_rule("rule-2", conditions={"status": "other"}))
        db.add(AutomationOutbox(id=row_id, owner_id=owner, kind="task.created",
            event_id=f"task.created:{uuid4()}", payload={"status": "ready"},
            created_at=now(), available_at=now(), attempts=0))
        await db.commit()

    a_done, b_entered, a_release, b_release = (asyncio.Event() for _ in range(4))
    real_dispatch = api.dispatch_event

    async def gated_dispatch(*args, **kwargs):
        if asyncio.current_task().get_name() == "attempt-B":
            b_entered.set()
            await b_release.wait()
        result = await real_dispatch(*args, **kwargs)
        if asyncio.current_task().get_name() == "attempt-A":
            a_done.set()
            await a_release.wait()
        return result

    monkeypatch.setattr(api, "dispatch_event", gated_dispatch)
    first = asyncio.create_task(hooks.deliver_pending(), name="attempt-A")
    await asyncio.wait_for(a_done.wait(), 5)
    async with factory() as db:
        if change == "created":
            db.add(make_rule("rule-2"))
        elif change == "enabled":
            await db.execute(update(AutomationRule).where(AutomationRule.id == "rule-2").values(enabled=True))
        else:
            await db.execute(update(AutomationRule).where(AutomationRule.id == "rule-2").values(conditions_json={"status": "ready"}))
        await db.execute(update(AutomationOutbox).where(AutomationOutbox.id == row_id)
                         .values(available_at=now() - timedelta(seconds=1)))
        await db.commit()
    second = asyncio.create_task(hooks.deliver_pending(), name="attempt-B")
    await asyncio.wait_for(b_entered.wait(), 5)
    if older_first:
        a_release.set()
        await asyncio.wait_for(first, 5)
        async with factory() as db:
            assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 1
        b_release.set()
        await asyncio.wait_for(second, 5)
    else:
        b_release.set()
        await asyncio.wait_for(second, 5)
        a_release.set()
        await asyncio.wait_for(first, 5)
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0
        assert await db.scalar(select(func.count()).select_from(Notification)) == 2
        receipts = (await db.scalars(select(AutomationExecution).order_by(AutomationExecution.rule_id))).all()
        assert [r.run_status for r in receipts] == ["completed", "completed"]
        assert [r.attempt for r in receipts] == [1, 1]


@pytest.mark.asyncio
async def test_postgres_constraint_failure_records_failed_and_continues(ai_test_engine, monkeypatch):
    from app.automation import hooks
    from app.core import db as database
    from app.core.models import AutomationOutbox, AutomationRule, Notification, User
    from sqlalchemy import func, select
    from sqlalchemy.ext.asyncio import async_sessionmaker

    if ai_test_engine.dialect.name != "postgresql":
        pytest.skip("PostgreSQL constraint contract")
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    monkeypatch.setattr(database, "SessionLocal", factory)
    async with ai_test_engine.begin() as connection:
        await connection.execute(text("ALTER TABLE notifications ADD CONSTRAINT h5_test_title CHECK (title <> 'blocked')"))
    owner = str(uuid4())
    async with factory() as db:
        db.add(User(id=owner))
        await db.flush()
        for number, title in enumerate(("first", "blocked", "third")):
            db.add(AutomationRule(id=f"rule-{number}", owner_id=owner, name="test", enabled=True,
                trigger_kind="task.created", conditions_json={},
                actions_json=[{"kind": "create_notification", "args": {"title": title}}],
                policy_ref="safe", rate_limit_json={}))
        db.add(AutomationOutbox(owner_id=owner, kind="task.created", event_id=f"task.created:{uuid4()}", payload={}))
        await db.commit()
    await hooks.deliver_pending()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0
        assert (await db.scalars(select(Notification.title).order_by(Notification.title))).all() == ["first", "third"]
        results = (await db.execute(select(AutomationExecution.run_status, AutomationExecution.error_code)
                    .order_by(AutomationExecution.rule_id))).all()
        assert results == [("completed", None), ("failed", "ACTION_FAILED"), ("completed", None)]
