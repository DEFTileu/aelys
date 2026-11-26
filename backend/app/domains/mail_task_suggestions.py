"""Owner-invoked, local extraction from one stored message."""

from __future__ import annotations

import re
from datetime import UTC, date, datetime, time, timedelta
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.ai.api import CreateTaskToolArgs
from app.core.models import (
    AIAction,
    AIConversation,
    AIRun,
    MailAccount,
    MailMessage,
    now,
)
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

FEATURE = "mail_task_suggestion"
REQUEST = re.compile(
    r"^(?:please\s+|(?:could|can|would) you\s+(?:please\s+)?|"
    r"(?:пожалуйста[, ]+|прошу\s+)|(?:задача|task|todo)\s*:\s*|"
    r"(?=(?:подготовь(?:те)?|проверь(?:те)?|пришли(?:те)?|согласуй(?:те)?|"
    r"review|prepare|submit|schedule)\s+))(.+)",
    re.IGNORECASE,
)
DEADLINE = re.compile(
    r"\s+(?:by|до|к)\s+(\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)?)?|"
    r"tomorrow|завтра|today|сегодня)$",
    re.IGNORECASE,
)


def deadline_time(
    text: str, received_at: datetime, timezone: str | None
) -> datetime | None:
    try:
        zone = ZoneInfo(timezone) if timezone else None
        if len(text) > 10:
            stamp = datetime.fromisoformat(text)
            if stamp.tzinfo:
                return stamp.astimezone(UTC)
            local = stamp
        elif text.casefold() in {"tomorrow", "завтра", "today", "сегодня"}:
            if zone is None:
                return None
            sent = (
                received_at if received_at.tzinfo else received_at.replace(tzinfo=UTC)
            )
            day = sent.astimezone(zone).date() + timedelta(
                days=int(text.casefold() in {"tomorrow", "завтра"})
            )
            local = datetime.combine(day, time(23, 59))
        else:
            local = datetime.combine(date.fromisoformat(text), time(23, 59))
        if not zone:
            return None
        stamp = local.replace(tzinfo=zone)
        if stamp.utcoffset() != stamp.replace(fold=1).utcoffset():
            return None  # Ambiguous or nonexistent wall time.
        return stamp.astimezone(UTC)
    except (ValueError, OverflowError, ZoneInfoNotFoundError):
        return None


def extract(
    message: MailMessage, timezone: str | None = None
) -> CreateTaskToolArgs | None:
    for line in [*message.body[:16000].splitlines(), message.subject]:
        line = line.strip()
        if line == "--" or line.startswith(
            ("On ", "-----Original Message", "---------- Forwarded")
        ):
            break
        match = REQUEST.fullmatch(line.rstrip(".?!"))
        if match and len(line) <= 400:
            title = match[1].strip()
            due = None
            deadline = DEADLINE.search(title)
            if deadline:
                due = deadline_time(deadline[1], message.received_at, timezone)
                if due:
                    title = title[: deadline.start()].strip()
            if 0 < len(title) <= 300:
                return CreateTaskToolArgs(
                    title=title,
                    due_at=due,
                    due_timezone=(timezone or "UTC") if due else None,
                    description=f"/mail?mail={message.id}",
                )
    return None


async def source(
    db: AsyncSession, owner_id: str, message_id: str | None
) -> tuple[MailMessage, dict]:
    message = await db.scalar(
        select(MailMessage)
        .where(
            MailMessage.id == message_id,
            MailMessage.owner_id == owner_id,
            MailMessage.deleted_at.is_(None),
        )
        .with_for_update()
    )
    unavailable = HTTPException(
        404, detail={"code": "SOURCE_UNAVAILABLE", "message": "Mail source unavailable"}
    )
    if not message:
        raise unavailable
    snapshot = {}
    if message.account_id or message.sync_origin == "gmail":
        account = await db.scalar(
            select(MailAccount)
            .where(
                MailAccount.id == message.account_id,
                MailAccount.owner_id == owner_id,
                MailAccount.deleted_at.is_(None),
            )
            .with_for_update()
        )
        if (
            not account
            or (message.sync_origin == "gmail" and account.provider != "gmail")
            or (
                account.provider == "gmail" and account.connection_status != "connected"
            )
        ):
            raise unavailable
        snapshot = {"account_id": account.id, "account_version": account.version}
    return message, snapshot


async def validate_approval(db: AsyncSession, action: AIAction) -> None:
    message, snapshot = await source(db, action.owner_id, action.source_id)
    run = await db.get(AIRun, action.run_id)
    timezone = run.tool_scope_json.get("timezone") if run else None
    current = extract(message, timezone)
    if (
        not run
        or run.tool_scope_json != {**snapshot, "timezone": timezone}
        or action.tool != "create_task"
        or current is None
        or current.model_dump(mode="json", exclude_none=True) != action.arguments_json
    ):
        raise HTTPException(
            409, detail={"code": "SOURCE_CHANGED", "message": "Mail source changed"}
        )


async def suggest(
    db: AsyncSession, owner_id: str, message_id: str, timezone: str | None = None
) -> AIAction | None:
    message, snapshot = await source(db, owner_id, message_id)
    action_id = str(uuid5(NAMESPACE_URL, f"aelys:{FEATURE}:{owner_id}:{message.id}"))
    existing = await db.get(AIAction, action_id)
    if existing:
        if existing.status == "pending":
            await validate_approval(db, existing)
        return existing
    if timezone:
        try:
            ZoneInfo(timezone)
        except (ValueError, ZoneInfoNotFoundError) as error:
            raise HTTPException(
                422, detail={"code": "INVALID_TIMEZONE", "message": "Unknown timezone"}
            ) from error
    args = extract(message, timezone)
    if args is None:
        return None
    # Keep internal extraction runs outside ordinary chat history.
    conversation = AIConversation(
        owner_id=owner_id, title="Mail task suggestion", deleted_at=now()
    )
    db.add(conversation)
    await db.flush()
    run = AIRun(
        owner_id=owner_id,
        conversation_id=conversation.id,
        provider="local",
        model="extractive",
        status="completed",
        completed_at=now(),
        tool_scope_json={**snapshot, "timezone": timezone},
    )
    db.add(run)
    await db.flush()
    action = AIAction(
        id=action_id,
        owner_id=owner_id,
        run_id=run.id,
        conversation_id=conversation.id,
        source_kind=FEATURE,
        source_id=message.id,
        tool="create_task",
        title=args.title,
        summary=args.due_at.isoformat() if args.due_at else "",
        arguments_json=args.model_dump(mode="json", exclude_none=True),
    )
    db.add(action)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        await source(db, owner_id, message_id)
        existing = await db.get(AIAction, action_id)
        if existing:
            return existing
        raise
    return action
