"""Evening report reminder: one in-app notification per local day, only if no report was written yet; mirrored to the owner's Telegram bot when connected."""
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.ai.crypto import decrypt_secret
from app.core import db as database
from app.core.models import EnglishProfile, EnglishReport, Notification
from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)
TELEGRAM_TEXT = "Aelys English: пора написать вечерний отчёт на английском и запланировать завтра."

WINDOW = timedelta(hours=3)  # shortcut: a window running past local midnight is cut at midnight, widen if reminders after 21:00 are needed


async def english_reminders_once(at: datetime | None = None) -> int:
    """Claim the local day with a conditional UPDATE before inserting, so concurrent workers cannot double-send."""
    instant = (at or datetime.now(UTC)).astimezone(UTC)
    sent, notified = 0, []
    async with database.SessionLocal() as db:
        profiles = (await db.execute(select(EnglishProfile.id, EnglishProfile.owner_id, EnglishProfile.reminder_time, EnglishProfile.timezone, EnglishProfile.last_reminded_on).where(EnglishProfile.reminder_enabled.is_(True), EnglishProfile.deleted_at.is_(None)))).all()
        for profile_id, owner_id, reminder_time, timezone, last in profiles:
            try:
                tz = ZoneInfo(timezone)
            except (LookupError, ValueError, OSError):
                continue
            local = instant.astimezone(tz)
            day, start = local.date(), datetime.combine(local.date(), time.fromisoformat(reminder_time), tz)
            if not start <= local < start + WINDOW or last == day:
                continue
            if (await db.execute(select(EnglishReport.id).where(EnglishReport.owner_id == owner_id, EnglishReport.day == day, EnglishReport.deleted_at.is_(None)))).first():
                continue
            claim = update(EnglishProfile).where(EnglishProfile.id == profile_id, EnglishProfile.reminder_enabled.is_(True), or_(EnglishProfile.last_reminded_on.is_(None), EnglishProfile.last_reminded_on < day)).values(last_reminded_on=day, version=EnglishProfile.version + 1)
            if int(getattr(await db.execute(claim), "rowcount", 0) or 0) != 1:
                await db.rollback()
                continue
            db.add(Notification(owner_id=owner_id, kind="english.reminder", title="Отчёт дня", body="Напиши вечерний отчёт на английском и запланируй завтра", dedup_key=f"english-reminder:{owner_id}:{day}", data_json={"route": "/english"}))
            try:
                await db.commit()
                sent += 1
                notified.append(owner_id)
            except IntegrityError:  # already notified for this day: keep the claim so we stop retrying every minute
                await db.rollback()
                await db.execute(claim)
                await db.commit()
        for owner_id in notified:  # the in-app notification is already durable; Telegram is best-effort and never retried
            await send_telegram(db, owner_id, instant)
    return sent


async def send_telegram(db: AsyncSession, owner_id: str, instant: datetime) -> None:
    from app.integrations import telegram_service as service
    from app.integrations.telegram_models import TelegramIntegration
    from app.integrations.telegram_reminders import _authorize, quiet_delivery_at

    item = (await db.execute(select(TelegramIntegration).where(TelegramIntegration.owner_id == owner_id, TelegramIntegration.enabled.is_(True), TelegramIntegration.deleted_at.is_(None)))).scalars().first()
    if not item or not item.encrypted_token or not item.owner_telegram_id:
        return
    try:
        if quiet_delivery_at(item, instant) > instant:  # owner's quiet hours: the in-app notification is enough
            return
        _authorize(item, "telegram.notify_owner", external=True)
        async with service.TelegramClient(decrypt_secret(item.encrypted_token)) as client:
            await client.send_message(item.owner_telegram_id, TELEGRAM_TEXT)
    except Exception:  # noqa: BLE001 - never log tokens or content; the bell already has it
        logger.info("English Telegram reminder unavailable")


async def reminder_loop() -> None:
    """Runs next to the connector loop; a failed tick (e.g. migrations still running) is retried on the next one."""
    while True:
        try:
            await english_reminders_once()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - never stop the loop
            await asyncio.sleep(0)
        await asyncio.sleep(60)
