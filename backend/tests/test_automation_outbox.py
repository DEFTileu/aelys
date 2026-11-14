from __future__ import annotations

import pytest
from app.automation import hooks
from app.core.models import AutomationOutbox, User
from sqlalchemy import func, select
from test_automation_api import _owner

pytest_plugins = ("test_automation_api",)


@pytest.mark.asyncio
async def test_committed_event_recovered_after_lost_wakeup(automation_client, monkeypatch):
    client, factory = automation_client
    headers = await _owner(client)
    from sqlalchemy import event
    from sqlalchemy.orm import Session
    event.remove(Session, "after_commit", hooks._schedule)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        hooks.enqueue(db, owner, "task.created", "event-1", {})
        await db.commit()
    event.listen(Session, "after_commit", hooks._schedule)
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 1
    called = []
    async def dispatch(db, owner_id, kind, event_id, payload, **kwargs):
        called.append(event_id)
    monkeypatch.setattr("app.automation.api.dispatch_event", dispatch)
    await hooks.deliver_pending()
    assert called == ["event-1"]
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0
    assert headers


@pytest.mark.asyncio
async def test_rollback_removes_outbox_event(automation_client):
    client, factory = automation_client
    await _owner(client)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        hooks.enqueue(db, owner, "task.created", "event-rollback", {})
        await db.rollback()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0


@pytest.mark.asyncio
async def test_outbox_continues_after_a_durable_rule_failure(automation_client):
    from app.automation.api import dispatch_event
    from app.core.models import AutomationExecution, AutomationRule, Notification

    client, factory = automation_client
    headers = await _owner(client)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        for number, policy in enumerate(("safe", "operator-supplied", "safe")):
            db.add(AutomationRule(id=f"rule-{number}", owner_id=owner, name="test", enabled=True,
                                  trigger_kind="task.created", conditions_json={},
                                  actions_json=[{"kind": "create_notification", "args": {"title": str(number)}}],
                                  policy_ref=policy, rate_limit_json={}))
        await db.commit()
    async with factory() as db:
        await dispatch_event(db, owner, "task.created", "event-three", {}, outbox=True)
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(Notification)) == 2
        statuses = (await db.scalars(select(AutomationExecution.run_status).order_by(AutomationExecution.rule_id))).all()
        assert statuses == ["completed", "failed", "completed"]
    assert headers


@pytest.mark.asyncio
async def test_failed_delivery_retries_with_backoff_and_stops_after_24_hours(automation_client, monkeypatch, caplog):
    from datetime import timedelta

    from app.core.models import now
    from sqlalchemy import update

    client, factory = automation_client
    await _owner(client)
    current = now()
    monkeypatch.setattr(hooks, "now", lambda: current)
    attempts = []

    async def broken(*args, **kwargs):
        attempts.append(1)
        raise RuntimeError("private payload")

    monkeypatch.setattr("app.automation.api.dispatch_event", broken)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        db.add(AutomationOutbox(owner_id=owner, kind="task.created", event_id="retry", payload={}, created_at=current, available_at=current, attempts=0))
        await db.commit()
    for seconds, expected in [(0, 30), (30, 120), (150, 600), (750, 3600)]:
        monkeypatch.setattr(hooks, "now", lambda seconds=seconds: current + timedelta(seconds=seconds))
        await hooks.deliver_pending()
        async with factory() as db:
            row = await db.scalar(select(AutomationOutbox))
            assert row.attempts == len(attempts)
            assert row.available_at.replace(tzinfo=None) == (current + timedelta(seconds=seconds + expected)).replace(tzinfo=None)
    monkeypatch.setattr(hooks, "now", lambda: current + timedelta(hours=24))
    async with factory() as db:
        await db.execute(update(AutomationOutbox).values(available_at=current))
        await db.commit()
    await hooks.deliver_pending()
    assert len(attempts) == 4
    assert "expired" in caplog.text and "private payload" not in caplog.text
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 1


@pytest.mark.asyncio
async def test_three_rules_with_failure_deliver_and_delete_event(automation_client):
    from app.core.models import AutomationExecution, AutomationRule, Notification

    client, factory = automation_client
    await _owner(client)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        for number, policy in enumerate(("safe", "operator-supplied", "safe")):
            db.add(AutomationRule(id=f"deliver-{number}", owner_id=owner, name="test", enabled=True,
                trigger_kind="task.created", conditions_json={},
                actions_json=[{"kind": "create_notification", "args": {"title": str(number)}}],
                policy_ref=policy, rate_limit_json={}))
        db.add(AutomationOutbox(owner_id=owner, kind="task.created", event_id="event-three", payload={}))
        await db.commit()
    await hooks.deliver_pending()
    await hooks.deliver_pending()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0
        assert await db.scalar(select(func.count()).select_from(Notification)) == 2
        statuses = (await db.scalars(select(AutomationExecution.run_status).order_by(AutomationExecution.rule_id))).all()
        assert statuses == ["completed", "failed", "completed"]


@pytest.mark.asyncio
async def test_nested_rollback_preserves_outer_event(automation_client):
    from sqlalchemy import event
    from sqlalchemy.orm import Session

    client, factory = automation_client
    await _owner(client)
    event.remove(Session, "after_commit", hooks._schedule)
    try:
        async with factory() as db:
            owner = await db.scalar(select(User.id))
            hooks.enqueue(db, owner, "task.created", "outer", {})
            try:
                async with db.begin_nested():
                    hooks.enqueue(db, owner, "task.created", "inner", {})
                    await db.flush()
                    raise ValueError("rollback savepoint")
            except ValueError:
                pass
            await db.commit()
    finally:
        event.listen(Session, "after_commit", hooks._schedule)
    async with factory() as db:
        assert (await db.scalars(select(AutomationOutbox.event_id))).all() == ["outer"]


@pytest.mark.asyncio
async def test_duplicate_enqueue_after_flush_is_idempotent(automation_client):
    from sqlalchemy import event
    from sqlalchemy.orm import Session

    client, factory = automation_client
    await _owner(client)
    event.remove(Session, "after_commit", hooks._schedule)
    try:
        async with factory() as db:
            owner = await db.scalar(select(User.id))
            hooks.enqueue(db, owner, "task.created", "same", {})
            await db.flush()
            hooks.enqueue(db, owner, "task.created", "same", {})
            await db.commit()
    finally:
        event.listen(Session, "after_commit", hooks._schedule)
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 1


@pytest.mark.asyncio
async def test_duplicate_outbox_delivery_does_not_repeat_rules(automation_client):
    from app.core.models import AutomationRule, Notification

    client, factory = automation_client
    await _owner(client)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        db.add(AutomationRule(id="duplicate-rule", owner_id=owner, name="test", enabled=True,
            trigger_kind="task.created", conditions_json={},
            actions_json=[{"kind": "create_notification", "args": {"title": "once"}}],
            policy_ref="safe", rate_limit_json={}))
        await db.commit()
    for _ in range(2):
        async with factory() as db:
            db.add(AutomationOutbox(owner_id=owner, kind="task.created", event_id="same-event", payload={}))
            await db.commit()
        await hooks.deliver_pending()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(Notification)) == 1
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0


@pytest.mark.asyncio
async def test_unrecorded_failure_is_retried_then_removed(automation_client, monkeypatch):
    from datetime import timedelta

    from app.core.models import now

    client, factory = automation_client
    await _owner(client)
    current = now()
    monkeypatch.setattr(hooks, "now", lambda: current)
    calls = 0

    async def transient(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("temporary")

    monkeypatch.setattr("app.automation.api.dispatch_event", transient)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        db.add(AutomationOutbox(owner_id=owner, kind="task.created", event_id="transient", payload={}, created_at=current, available_at=current, attempts=0))
        await db.commit()
    await hooks.deliver_pending()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 1
    monkeypatch.setattr(hooks, "now", lambda: current + timedelta(seconds=30))
    await hooks.deliver_pending()
    async with factory() as db:
        assert calls == 2
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0


@pytest.mark.asyncio
async def test_bad_rule_before_action_claim_records_failure_and_continues(automation_client):
    from app.core.models import AutomationExecution, AutomationRule, Notification

    client, factory = automation_client
    await _owner(client)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        for i in range(3):
            actions = [{"kind": "invalid-action", "args": {}}] if i == 1 else [{"kind": "create_notification", "args": {"title": str(i)}}]
            db.add(AutomationRule(id=f"bad-{i}", owner_id=owner, name="test", enabled=True,
                trigger_kind="task.created", conditions_json={}, actions_json=actions, policy_ref="safe", rate_limit_json={}))
        db.add(AutomationOutbox(owner_id=owner, kind="task.created", event_id="bad-actions", payload={}))
        await db.commit()
    await hooks.deliver_pending()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0
        assert await db.scalar(select(func.count()).select_from(Notification)) == 2
        assert (await db.scalars(select(AutomationExecution.run_status).order_by(AutomationExecution.rule_id))).all() == ["completed", "failed", "completed"]


@pytest.mark.asyncio
async def test_commit_failure_leaves_event_for_retry(automation_client, monkeypatch):
    from datetime import timedelta

    from app.core.models import AutomationExecution, AutomationRule, Notification, now
    from sqlalchemy.ext.asyncio import AsyncSession

    client, factory = automation_client
    await _owner(client)
    current = now()
    monkeypatch.setattr(hooks, "now", lambda: current)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        db.add(AutomationRule(id="commit-rule", owner_id=owner, name="test", enabled=True,
            trigger_kind="task.created", conditions_json={},
            actions_json=[{"kind": "create_notification", "args": {"title": "once"}}],
            policy_ref="safe", rate_limit_json={}))
        db.add(AutomationOutbox(owner_id=owner, kind="task.created", event_id="commit-error", payload={}, created_at=current, available_at=current, attempts=0))
        await db.commit()
    original = AsyncSession.commit
    failed = False

    async def fail_commit(db):
        nonlocal failed
        if not failed and any(isinstance(item, AutomationExecution) for item in db.sync_session.identity_map.values()):
            failed = True
            raise RuntimeError("ambiguous commit")
        await original(db)

    monkeypatch.setattr(AsyncSession, "commit", fail_commit)
    await hooks.deliver_pending()
    async with factory() as db:
        assert failed
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 1
        assert await db.scalar(select(func.count()).select_from(AutomationExecution)) == 0
        assert await db.scalar(select(func.count()).select_from(Notification)) == 0
    monkeypatch.setattr(hooks, "now", lambda: current + timedelta(seconds=30))
    await hooks.deliver_pending()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 0
        assert await db.scalar(select(func.count()).select_from(Notification)) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("decision", ["duplicate", "rate_limited"])
async def test_commit_error_after_nonaction_claim_propagates(automation_client, monkeypatch, decision):
    from app.automation.api import dispatch_event
    from app.core.models import AutomationExecution, AutomationRule

    client, factory = automation_client
    await _owner(client)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        db.add(AutomationRule(id="claim-test", owner_id=owner, name="test", enabled=True,
            trigger_kind="task.created", conditions_json={}, actions_json=[{"kind": "create_notification", "args": {"title": "test"}}],
            policy_ref="safe", rate_limit_json={"max_executions": 1, "window_seconds": 3600}))
        db.add(AutomationExecution(owner_id=owner, rule_id="claim-test", event_id="same" if decision == "duplicate" else "prior", run_status="completed"))
        await db.commit()
    async with factory() as db:
        async def broken_commit():
            raise RuntimeError("commit unavailable")
        monkeypatch.setattr(db, "commit", broken_commit)
        with pytest.raises(RuntimeError, match="commit unavailable"):
            await dispatch_event(db, owner, "task.created", "same" if decision == "duplicate" else "new", {}, outbox=True)


@pytest.mark.asyncio
async def test_database_error_during_rule_is_retryable(automation_client, monkeypatch):
    from app.automation import api
    from app.core.models import AutomationExecution, AutomationRule
    from sqlalchemy.exc import OperationalError

    client, factory = automation_client
    await _owner(client)
    async with factory() as db:
        owner = await db.scalar(select(User.id))
        db.add(AutomationRule(id="db-error-rule", owner_id=owner, name="test", enabled=True,
            trigger_kind="task.created", conditions_json={}, actions_json=[{"kind": "create_notification", "args": {"title": "test"}}],
            policy_ref="safe", rate_limit_json={}))
        db.add(AutomationOutbox(owner_id=owner, kind="task.created", event_id="db-error", payload={}))
        await db.commit()

    async def fail_scope(*args, **kwargs):
        raise OperationalError("select", {}, Exception("temporary"))
    monkeypatch.setattr(api, "_require_action_scope", fail_scope)
    await hooks.deliver_pending()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(AutomationOutbox)) == 1
        assert await db.scalar(select(func.count()).select_from(AutomationExecution)) == 0
