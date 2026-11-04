"""AI Chat helpers: source scopes, tool labels, approval-gated writes and attachment text."""
from __future__ import annotations

import base64
import binascii
import io
import re
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.models import AIAction, Task
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from .tools import ToolRegistry

READ_SCOPES = frozenset({"tasks.read", "calendar.read", "notes.read", "knowledge.read"})
DEFAULT_SCOPES = ("calendar.read", "notes.read", "tasks.read")
# Chat tools that write only create a pending AIAction, so exposing them to the
# model is safe; the owner's approval is what executes them.
WRITE_SCOPES = frozenset({"tasks.write", "notes.write", "calendar.write", "reminders.write"})

_IDENTITY = (
    "You are Aelys, the owner's personal assistant inside the Aelys app (tasks, calendar, notes, knowledge base, mail, finance). "
    "Reply in the language of the owner's latest message, concisely and concretely. "
    "Never invent facts, IDs, dates or the contents of the owner's data. "
)
SYSTEM_POLICY = (
    "You may read the owner's data only through the provided read tools. "
    "Aelys reads, never changes data without asking: to change anything call the matching tool, "
    "which only proposes the change for the owner to approve; never claim a change was made before approval. "
    "Look items up before acting: list_tasks gives a task's id and current version, search_notes gives note ids for read_note, "
    "search_knowledge answers questions about the owner's documents (cite excerpts as [N1]). "
    "Turn relative times such as 'tomorrow at 10' into exact times in the owner's timezone."
)
_NO_TOOLS = (
    "No data sources are shared with you in this chat, so you cannot see or change the owner's tasks, calendar or notes. "
    "If the owner asks for that, tell them to turn the source on in this chat's sources."
)


def owner_timezone(*candidates: object) -> str:
    """First valid IANA timezone name among the candidates, else UTC."""
    for value in candidates:
        if isinstance(value, str) and 0 < len(value) <= 64:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                continue
            return value
    return "UTC"


def system_prompt(timezone: str, *, tools: bool) -> str:
    now = datetime.now(ZoneInfo(timezone))
    return f"{_IDENTITY}{SYSTEM_POLICY if tools else _NO_TOOLS}\nCurrent owner time: {now:%Y-%m-%d %H:%M} ({now:%A}), timezone {timezone}."


_SOURCE = {"list_tasks": "tasks", "create_task": "tasks", "update_task": "tasks", "complete_task": "tasks",
           "create_reminder": "tasks", "read_calendar": "calendar", "create_event": "calendar",
           "read_note": "notes", "create_note": "notes", "search_notes": "notes",
           "search_knowledge": "knowledge"}
_LABEL = {"list_tasks": "Read your tasks", "read_calendar": "Read your calendar", "read_note": "Read a note",
          "create_task": "Propose a new task", "update_task": "Propose a task change",
          "complete_task": "Propose completing a task", "create_event": "Propose a calendar event",
          "create_reminder": "Propose a reminder", "create_note": "Propose a new note",
          "search_notes": "Searched notes", "search_knowledge": "Searched knowledge base"}


def tool_meta(tool: str, result: Mapping[str, Any] | None = None) -> dict[str, str]:
    """Human `label`, `source` id (tasks|calendar|notes|knowledge) and, with a result, `detail`."""
    meta = {"label": _LABEL.get(tool, tool.replace("_", " ").capitalize())}
    if tool in _SOURCE:
        meta["source"] = _SOURCE[tool]
    if result is not None:
        items = result.get("items") if isinstance(result.get("items"), list) else None
        if result.get("proposed"):
            meta["detail"] = "Waiting for your approval"
        elif tool == "list_tasks" and items is not None:
            soon = datetime.now(UTC) + timedelta(days=7)
            due = sum(1 for item in items if _due_before(item.get("due_at"), soon))
            meta["detail"] = (f"{len(items)} task{'s' * (len(items) != 1)}" if items else "No tasks") + (f", {due} due this week" if due else "")
        elif tool == "read_calendar" and items is not None:
            meta["detail"] = f"{len(items)} event{'s' * (len(items) != 1)}" if items else "No events"
        elif tool in {"search_notes", "search_knowledge"} and items is not None:
            meta["detail"] = f"{len(items)} match{'es' * (len(items) != 1)}" if items else "No matches"
        elif tool == "read_note" and result.get("title"):
            meta["detail"] = str(result["title"])[:80]
    return meta


def _due_before(value: Any, limit: datetime) -> bool:
    try:
        due = datetime.fromisoformat(str(value))
    except ValueError:
        return False
    return due.tzinfo is not None and due <= limit


async def _describe(db: AsyncSession, owner_id: str, tool: str, args: Mapping[str, Any]) -> tuple[str, str, list[dict[str, str]]]:
    def item(title: Any, detail: Any = "", meta: Any = "") -> dict[str, str]:
        return {"title": str(title)[:300], "detail": str(detail)[:300], "meta": str(meta)[:100]}

    if tool == "create_task":
        return "Create task", str(args.get("title", "")), [item(args.get("title", ""), args.get("description", ""))]
    if tool == "create_note":
        return "Create note", str(args.get("title", "")), [item(args.get("title", ""), str(args.get("markdown_body", ""))[:120])]
    if tool == "create_event":
        return "Create calendar event", str(args.get("title", "")), [item(args.get("title", ""), f"{args.get('starts_at', '')} - {args.get('ends_at', '')}", args.get("timezone", ""))]
    if tool in {"update_task", "complete_task", "create_reminder"}:
        task = await db.get(Task, str(args.get("task_id", "")))
        name = task.title if task and task.owner_id == owner_id and task.deleted_at is None else "Unknown task"
        if tool == "create_reminder":
            return "Schedule reminder", name, [item(name, args.get("notify_at", ""), args.get("channel", "telegram"))]
        changes = {k: v for k, v in args.items() if k not in {"task_id", "version"}}
        title = "Complete task" if tool == "complete_task" else "Update task"
        return title, name, [item(name, ", ".join(f"{k}: {v}" for k, v in changes.items()) or "status: completed")]
    return tool.replace("_", " ").capitalize(), "", [item(tool, str(dict(args))[:200])]


def gate_writes(registry: ToolRegistry, db: AsyncSession, owner_id: str, *, conversation_id: str, run_id: str,
                message_id: str | None, announce: Callable[[str, Mapping[str, Any]], Awaitable[None]]) -> None:
    """Replace every write handler so a chat run only persists a pending action."""
    for schema in registry.schemas():
        descriptor = registry.descriptor(str(schema["name"]))
        if not descriptor.required_scope.endswith(".write"):
            continue

        async def propose(arguments: Mapping[str, Any], tool: str = descriptor.name) -> Mapping[str, Any]:
            title, summary, items = await _describe(db, owner_id, tool, arguments)
            action = AIAction(owner_id=owner_id, conversation_id=conversation_id, run_id=run_id, message_id=message_id,
                              tool=tool, arguments_json=dict(arguments), title=title, summary=summary, items_json=items, status="pending")
            db.add(action)
            await db.flush()
            await announce("ai.action.proposed", {"run_id": run_id, "action_id": action.id, "tool": tool,
                                                  "title": title, "summary": summary, "items": items})
            return {"proposed": True, "action_id": action.id, "status": "pending_approval", "untrusted": True}

        descriptor.handler = propose


def preview(text: str) -> str:
    """First 90 characters of a message as plain text (markdown markers and newlines removed)."""
    plain = re.sub(r"[`*_#>~]|!?\[([^\]]*)\]\([^)]*\)", lambda m: m.group(1) or "", text)
    return re.sub(r"\s+", " ", plain).strip()[:90]


ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024
ATTACHMENT_STORE_CHARS = 200_000
ATTACHMENT_INJECT_CHARS = 20_000  # per file
ATTACHMENT_INJECT_TOTAL = 40_000
ATTACHMENT_SUFFIXES = {".txt", ".md", ".csv", ".json", ".pdf"}


def _bad(code: str, message: str, status: int = 422) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def extract_attachment(name: str, content_base64: str) -> tuple[str, int, str]:
    """Return (safe name, byte size, text) or raise a 422 with a typed code."""
    safe = re.sub(r"[\x00-\x1f\x7f]", "", name.replace("\\", "/").rsplit("/", 1)[-1]).strip()[:200]
    suffix = "." + safe.rsplit(".", 1)[-1].lower() if "." in safe else ""
    if suffix not in ATTACHMENT_SUFFIXES:
        raise _bad("ATTACHMENT_TYPE_UNSUPPORTED", "Only .txt, .md, .csv, .json and .pdf files are supported")
    try:
        data = base64.b64decode(content_base64, validate=True)
    except (binascii.Error, ValueError):
        raise _bad("VALIDATION_ERROR", "content_base64 is not valid base64") from None
    if len(data) > ATTACHMENT_MAX_BYTES:
        raise _bad("ATTACHMENT_TOO_LARGE", "Attachments are limited to 2 MB", 413)
    if suffix == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            text = "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception:  # noqa: BLE001 - malformed or encrypted PDFs get one fixed error
            raise _bad("ATTACHMENT_UNREADABLE", "The PDF could not be read") from None
    else:
        text = data.decode("utf-8", errors="replace")
    text = text.replace("\x00", "").strip()
    if not text:
        raise _bad("ATTACHMENT_UNREADABLE", "The file contains no readable text")
    return safe or "attachment" + suffix, len(data), text[:ATTACHMENT_STORE_CHARS]
