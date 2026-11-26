import asyncio

from app.ai.actions import approve_action
from app.core.models import MailMessage, SyncChange, Task, User, now
from app.domains.mail_task_suggestions import suggest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker


async def test_concurrent_suggestions_and_approvals(ai_test_engine):
    sessions = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    async with sessions() as db:
        owner = User()
        db.add(owner)
        await db.flush()
        message = MailMessage(
            owner_id=owner.id,
            received_at=now(),
            sender="sender@example.test",
            subject="Request",
            body="Please review the report",
        )
        db.add(message)
        await db.commit()

    async def propose():
        async with sessions() as db:
            action = await suggest(db, owner.id, message.id)
            assert action is not None
            return action.id

    async def approve(action_id):
        async with sessions() as db:
            action = await approve_action(db, owner.id, action_id)
            return action.result_json["id"]

    actions = await asyncio.gather(*(propose() for _ in range(4)))
    assert len(set(actions)) == 1
    tasks = await asyncio.gather(*(approve(action_id) for action_id in actions))
    assert len(set(tasks)) == 1
    async with sessions() as db:
        assert (await db.scalars(select(Task.id))).one() == tasks[0]
        assert (await db.scalars(select(SyncChange.resource_kind))).one() == "task"
