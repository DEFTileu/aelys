"""Encrypted owner export/restore for synced Aelys data.

The export deliberately excludes authentication sessions, device credentials,
provider secrets, project grants, and raw Mac agent session content. The key is
operator supplied through AELYS_EXPORT_KEY and is never stored in the export.
"""

from __future__ import annotations

import base64
import json
import os
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.inspection import inspect

from .models import (
    ActivityEvent,
    AIConversation,
    AIMessage,
    AIProvider,
    AIRun,
    AutomationExecution,
    AutomationRule,
    CalendarEvent,
    CalendarReminder,
    FinanceAccount,
    FinanceBudget,
    FinanceCategory,
    FinanceTransaction,
    FocusSession,
    HistoryEntry,
    MailAccount,
    MailDraft,
    MailMessage,
    Note,
    NoteRevision,
    Notification,
    Project,
    Resource,
    ResourceLink,
    Task,
    TaskReminder,
)

EXPORT_VERSION = 1
MAGIC = b"AELYS-EXPORT-1\n"

EXPORT_MODELS = (
    Project, Resource, ResourceLink, Note, Task, CalendarEvent, CalendarReminder,
    FinanceAccount, FinanceCategory, FinanceTransaction, FinanceBudget,
    FocusSession, MailAccount, MailMessage, MailDraft, TaskReminder,
    AIProvider, AIConversation, AIRun, ActivityEvent, Notification,
    HistoryEntry, AutomationRule, AutomationExecution,
)


def _key() -> bytes:
    value = os.environ.get("AELYS_EXPORT_KEY", "")
    if not value:
        raise RuntimeError("AELYS_EXPORT_KEY must be set for encrypted export/restore")
    try:
        raw = bytes.fromhex(value) if len(value) == 64 else base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except ValueError as exc:
        raise RuntimeError("AELYS_EXPORT_KEY must be 32-byte hex or URL-safe base64") from exc
    if len(raw) != 32:
        raise RuntimeError("AELYS_EXPORT_KEY must decode to exactly 32 bytes")
    return raw


def _json_value(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    return value


def _row(model: type, value: Any) -> dict[str, Any]:
    mapper: Any = inspect(model)
    columns: Any = mapper.columns
    return {column.key: _json_value(getattr(value, column.key)) for column in columns}


async def build_owner_export(db: AsyncSession, owner_email: str) -> dict[str, Any]:
    from .models import User

    owner = (await db.execute(select(User).where(User.email == owner_email))).scalar_one_or_none()
    if not owner:
        raise RuntimeError("owner email was not found")
    tables: dict[str, list[dict[str, Any]]] = {}
    for model in EXPORT_MODELS:
        if not hasattr(model, "owner_id"):
            continue
        rows = (await db.execute(select(model).where(model.owner_id == owner.id))).scalars().all()
        tables[model.__tablename__] = [_row(model, item) for item in rows]

    note_ids = [row["id"] for row in tables.get("notes", [])]
    if note_ids:
        revisions = (await db.execute(select(NoteRevision).where(NoteRevision.note_id.in_(note_ids)))).scalars().all()
        tables["note_revisions"] = [_row(NoteRevision, item) for item in revisions]
    conversation_ids = [row["id"] for row in tables.get("ai_conversations", [])]
    if conversation_ids:
        messages = (await db.execute(select(AIMessage).where(AIMessage.conversation_id.in_(conversation_ids)))).scalars().all()
        tables["ai_messages"] = [_row(AIMessage, item) for item in messages]

    return {
        "format_version": EXPORT_VERSION,
        "owner": {"id": owner.id, "email": owner.email},
        "privacy": {
            "encrypted": True,
            "excluded": ["auth_sessions", "devices", "ai_provider_secrets", "gmail_credentials", "gmail_oauth_states", "gmail_draft_links", "telegram_integrations", "telegram_business_connections", "telegram_business_messages", "telegram_update_receipts", "project_grants", "raw_mac_agent_sessions", "credentials"],
        },
        "exported_at": datetime.now().astimezone().isoformat(),
        "tables": tables,
    }


def write_encrypted_export(path: str | Path, payload: dict[str, Any]) -> None:
    nonce = os.urandom(12)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    encrypted = AESGCM(_key()).encrypt(nonce, body, MAGIC)
    Path(path).write_bytes(MAGIC + nonce + encrypted)


def read_encrypted_export(path: str | Path) -> dict[str, Any]:
    raw = Path(path).read_bytes()
    if not raw.startswith(MAGIC) or len(raw) <= len(MAGIC) + 12:
        raise RuntimeError("invalid Aelys export envelope")
    nonce_start = len(MAGIC)
    body = AESGCM(_key()).decrypt(raw[nonce_start:nonce_start + 12], raw[nonce_start + 12:], MAGIC)
    payload = json.loads(body)
    if payload.get("format_version") != EXPORT_VERSION:
        raise RuntimeError("unsupported Aelys export format")
    return payload


def _decode_column(model: type, key: str, value: Any) -> Any:
    mapper: Any = inspect(model)
    columns: Any = mapper.columns
    column: Any = columns.get(key)
    if column is None or value is None:
        return value
    type_name = column.type.__class__.__name__
    if type_name == "DateTime" and isinstance(value, str):
        return datetime.fromisoformat(value)
    if type_name == "Date" and isinstance(value, str):
        return date.fromisoformat(value)
    if type_name == "Numeric" and isinstance(value, str):
        return Decimal(value)
    return value


RESTORE_MODELS: dict[str, Any] = {model.__tablename__: model for model in EXPORT_MODELS}
RESTORE_MODELS.update({"note_revisions": NoteRevision, "ai_messages": AIMessage})


async def restore_owner_export(db: AsyncSession, owner_email: str, payload: dict[str, Any]) -> int:
    from .models import User

    owner = (await db.execute(select(User).where(User.email == owner_email))).scalar_one_or_none()
    if not owner:
        raise RuntimeError("target owner email was not found; bootstrap the single owner first")
    count = 0
    for table, rows in payload.get("tables", {}).items():
        model = RESTORE_MODELS.get(table)
        if model is None:
            continue
        for raw in rows:
            mapper: Any = inspect(model)
            columns: Any = mapper.columns
            values = {key: _decode_column(model, key, value) for key, value in raw.items() if key in columns}
            if "owner_id" in columns:
                values["owner_id"] = owner.id
            db.add(model(**values))
            count += 1
    await db.commit()
    return count
