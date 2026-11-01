"""Foreground in-app reminders remain separate from Telegram delivery."""
from datetime import timedelta

from app.core.models import Notification, Task, TaskReminder, User, now
from app.domains.reminders import deliver_due_reminders
from sqlalchemy import select

pytest_plugins = ('test_telegram_business',)


async def test_task_in_app_delivery_does_not_consume_telegram_or_completed(setup):
    _, sessions, _ = setup
    async with sessions() as session:
        owner = (await session.execute(select(User.id))).scalar_one()
        session.add_all([Task(id='active', owner_id=owner, title='Local reminder'),
                         Task(id='done', owner_id=owner, title='Done', status='done')])
        for key, task_id, channel in [('local', 'active', 'in_app'), ('remote', 'active', 'telegram'), ('finished', 'done', 'in_app')]:
            session.add(TaskReminder(id=key, owner_id=owner, task_id=task_id, channel=channel,
                notify_at=now()-timedelta(minutes=1), idempotency_key=key))
        await session.commit()
        assert await deliver_due_reminders(session, owner) == 1
        assert await deliver_due_reminders(session, owner) == 0
        assert (await session.get(TaskReminder, 'remote')).reminder_status == 'pending'
        assert (await session.get(TaskReminder, 'finished')).reminder_status == 'cancelled'
        notices = list((await session.execute(select(Notification))).scalars())
        assert len(notices) == 1 and notices[0].kind == 'task.reminder'
