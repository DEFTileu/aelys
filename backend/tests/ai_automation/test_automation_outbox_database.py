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
