"""Owner-scoped foreground delivery of explicitly scheduled in-app reminders."""
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.core.models import CalendarEvent, CalendarReminder, Notification
from app.domains.recurrence import next_occurrence, utc
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class ReminderNotification:
    name: str = "calendar_reminder_notification"
    required_scope: str = "notifications.write"
    external_effect: bool = False


async def deliver_due_reminders(db: AsyncSession, owner_id: str) -> int:
    current = datetime.now(UTC)
    pairs = (await db.execute(select(CalendarReminder, CalendarEvent).join(CalendarEvent, CalendarReminder.event_id == CalendarEvent.id).where(
        CalendarReminder.owner_id == owner_id, CalendarEvent.owner_id == owner_id,
        CalendarReminder.deleted_at.is_(None), CalendarReminder.reminder_status == "pending",
        CalendarReminder.notify_at <= current,
    ).order_by(CalendarReminder.notify_at).limit(200))).all()
    delivered = 0
    for reminder, event in pairs:
        occurrence = utc(reminder.occurrence_at or event.starts_at)
        offset = reminder.offset_seconds if reminder.offset_seconds is not None else int((utc(event.starts_at)-utc(reminder.notify_at)).total_seconds())
        upcoming = None if event.deleted_at else next_occurrence(event.starts_at, event.timezone, event.rrule, occurrence)
        values = {"reminder_status": "cancelled" if event.deleted_at else "pending" if upcoming else "delivered", "version": reminder.version + 1, "offset_seconds": offset, "occurrence_at": upcoming or occurrence}
        if upcoming:
            values["notify_at"] = upcoming - timedelta(seconds=offset)
        result = await db.execute(update(CalendarReminder).where(
            CalendarReminder.id == reminder.id, CalendarReminder.version == reminder.version,
            CalendarReminder.reminder_status == "pending",
        ).values(**values))
        if int(getattr(result, "rowcount", 0) or 0) != 1 or event.deleted_at:
            continue
        # The grant comes only from the persisted owner-created schedule. Content
        # cannot widen its notification-only scope or cause external effects.
        ServerPolicyEngine().authorize(ReminderNotification(), ToolCall(name="calendar_reminder_notification", arguments={}), PermissionContext(
            actor="calendar_reminder", scopes=frozenset({"notifications.write"}), policy_id=f"reminder:{reminder.id}",
        ))
        db.add(Notification(owner_id=owner_id, kind="calendar.reminder", title=event.title,
                            body="Scheduled calendar reminder", dedup_key=f"calendar-reminder:{reminder.id}:{occurrence.isoformat()}",
                            data_json={"event_id": event.id, "reminder_id": reminder.id, "occurrence_at": occurrence.isoformat()}))
        delivered += 1
    await db.commit()
    return delivered
