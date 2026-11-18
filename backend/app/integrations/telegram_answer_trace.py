"""Read-only, owner-authenticated provenance for completed personal Telegram runs."""
from __future__ import annotations

import hmac
import json
import re
import time
from collections.abc import Callable, Coroutine
from datetime import timedelta
from pathlib import Path
from typing import Annotated, Any, Literal
from urllib.parse import parse_qsl
from uuid import UUID

from app.ai.chat_history import HISTORY_TOOL, MAX_HISTORY_MESSAGES, history_event_query
from app.ai.crypto import decrypt_secret
from app.ai.memory import active_memory_versions
from app.ai.memory_models import OwnerMemoryFact
from app.ai.providers import _safe_source_url
from app.core.db import get_db
from app.core.models import AIConversation, AIMessage, AIRun, AIRunEvent, now
from app.domains.recurrence import utc
from cryptography.exceptions import InvalidTag
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field
from sqlalchemy import or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from .telegram_models import TelegramIntegration, TelegramPersonalJob
from .telegram_personal import authorize

PAGE = "/telegram/answer-trace"
API_PREFIX = "/api/v1" + PAGE
STATIC_PATHS = frozenset({PAGE, f"{PAGE}/app.js", f"{PAGE}/style.css"})
STATIC_DIR = Path(__file__).with_name("answer_trace_static")
MAX_AGE = 3600
_MILLISECOND = timedelta(milliseconds=1)
MAX_STEPS = 100
MAX_STEP_SOURCES = 10
MAX_MEMORY_REFS = 200
TOOL_LABELS = {
    "list_tasks": "Чтение задач",
    "create_task": "Создание задачи",
    "update_task": "Обновление задачи",
    "complete_task": "Завершение задачи",
    "search_notes": "Поиск заметок",
    "read_note": "Чтение заметки",
    "create_note": "Создание заметки",
    "read_calendar": "Чтение календаря",
    "create_event": "Создание события",
    "create_reminder": "Создание напоминания",
    "search_knowledge": "Поиск по базе знаний",
    "remember": "Сохранение факта",
    "forget": "Удаление факта",
    "web_search": "Поиск в интернете",
    HISTORY_TOOL: "Чтение истории чата",
}
EVENT_TYPES = ("ai.run.started", "ai.run.completed", "ai.tool.requested", "ai.tool.result")


class _TraceRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def handle(request: Request) -> Response:
            try:
                return await handler(request)
            except HTTPException:
                raise
            except Exception:  # noqa: BLE001 - do not serialize errors containing persisted payloads
                return JSONResponse(
                    status_code=500,
                    content={"detail": {"code": "INTERNAL_ERROR", "message": "Answer trace unavailable"}},
                )

        return handle


router = APIRouter(route_class=_TraceRoute)
static_router = APIRouter(include_in_schema=False)


class TraceSource(BaseModel):
    url: str = Field(max_length=2048)
    title: str = Field(max_length=300)


class TraceStep(BaseModel):
    id: str
    kind: str
    label: str
    query: str | None = Field(max_length=2000)
    status: Literal["pending", "completed", "failed"]
    sources: list[TraceSource] = Field(default_factory=list, max_length=MAX_STEP_SOURCES)


class TraceMemoryFact(BaseModel):
    id: str
    text: str
    version: int


class AnswerTraceOut(BaseModel):
    run_id: UUID
    duration_ms: int | None
    model: str
    steps: list[TraceStep] = Field(max_length=MAX_STEPS)
    sources: list[TraceSource] = Field(max_length=MAX_STEPS * MAX_STEP_SOURCES)
    history_message_count: int | None
    memory_facts: list[TraceMemoryFact] = Field(max_length=MAX_MEMORY_REFS)


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _unauthorized() -> HTTPException:
    return _error(401, "UNAUTHORIZED", "Invalid Telegram Mini App authentication")


def _unique_fields(pairs: list[tuple[str, str]]) -> dict[str, str]:
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError("Duplicate fields")
    return fields


def _init_data(request: Request) -> tuple[int, bytes, str]:
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        raise _unauthorized()
    scheme, _, data = values[0].partition(" ")
    if (scheme.lower() != "tma" or not 0 < len(data) <= 8192
            or not data.isascii() or any(not 33 <= ord(char) <= 126 for char in data)
            or re.search(r"%(?![0-9a-fA-F]{2})", data)):
        raise _unauthorized()

    try:
        fields = _unique_fields(parse_qsl(data, strict_parsing=True, keep_blank_values=True,
                                          errors="strict", max_num_fields=32))
        supplied = fields.pop("hash")
        auth_date = fields["auth_date"]
        if (not re.fullmatch(r"[0-9a-f]{64}", supplied) or not re.fullmatch(r"[0-9]{1,12}", auth_date)
                or not 0 <= int(time.time()) - int(auth_date) <= MAX_AGE
                or any(not re.fullmatch(r"[a-zA-Z0-9_]+", key) or "\r" in value or "\n" in value
                       for key, value in fields.items())):
            raise ValueError("Invalid signed fields")
        user = json.loads(fields["user"], object_pairs_hook=_unique_fields)
        user_id = user.get("id") if isinstance(user, dict) else None
        if type(user_id) is not int or not 0 < user_id <= 2**52:
            raise ValueError("Invalid Telegram user")
    except (KeyError, ValueError, RecursionError):
        raise _unauthorized() from None

    message = "\n".join(f"{key}={value}" for key, value in sorted(fields.items())).encode()
    return user_id, message, supplied


async def _authenticate(request: Request, db: AsyncSession) -> TelegramIntegration:
    user_id, message, supplied = _init_data(request)
    candidates = await db.scalars(select(TelegramIntegration).where(
        TelegramIntegration.owner_telegram_id == user_id,
        TelegramIntegration.enabled.is_(True),
        TelegramIntegration.deleted_at.is_(None),
        TelegramIntegration.encrypted_token.is_not(None),
    ))
    authenticated = []
    for candidate in candidates:
        encrypted_token = candidate.encrypted_token
        if not encrypted_token:
            continue
        try:
            token = decrypt_secret(encrypted_token)
        except (InvalidTag, ValueError):
            continue
        key = hmac.digest(b"WebAppData", token.encode(), "sha256")
        if hmac.compare_digest(hmac.digest(key, message, "sha256").hex(), supplied):
            authenticated.append(candidate)
    if len(authenticated) != 1:
        raise _unauthorized()
    return authenticated[0]


def _sources(value: object) -> list[TraceSource]:
    if not isinstance(value, list):
        return []
    sources: dict[str, TraceSource] = {}
    for entry in value:
        if not isinstance(entry, dict):
            continue
        url = _safe_source_url(entry.get("url"))
        if url is None or url in sources:
            continue
        title = entry.get("title")
        sources[url] = TraceSource(url=url, title=title[:300] if isinstance(title, str) else "")
        if len(sources) >= MAX_STEP_SOURCES:
            break
    return list(sources.values())


async def _memory_facts(
    db: AsyncSession, run: AIRun, reply_id: str | None,
) -> list[TraceMemoryFact]:
    # Older runs have only their exact prompt link. Never use a neighboring
    # assistant message in a conversation, which may belong to another run.
    message_id = reply_id or run.prompt_message_id
    if not message_id:
        return []
    raw_refs = await db.scalar(select(AIMessage.source_refs_json).where(
        AIMessage.id == message_id,
        AIMessage.conversation_id == run.conversation_id,
        AIMessage.role == ("assistant" if reply_id else "user"),
    ))
    if not isinstance(raw_refs, list):
        return []
    refs: set[tuple[str, int]] = set()
    for ref in raw_refs:
        if not isinstance(ref, dict) or ref.get("kind") != "owner_memory_fact":
            continue
        fact_id, version = ref.get("id"), ref.get("version")
        if isinstance(fact_id, str) and 0 < len(fact_id) <= 36 and type(version) is int and version > 0:
            refs.add((fact_id, version))
        if len(refs) >= MAX_MEMORY_REFS:
            break
    instant = now()
    versions = await active_memory_versions(db, run.owner_id, {fact_id for fact_id, _ in refs}, at=instant)
    active_refs = [(fact_id, version) for fact_id, version in refs if versions.get(fact_id) == version]
    if not active_refs:
        return []
    # Recheck the exact versions and activity at the text read, in case a
    # concurrent memory mutation committed after the provenance check.
    facts = await db.scalars(select(OwnerMemoryFact).where(
        OwnerMemoryFact.owner_id == run.owner_id,
        tuple_(OwnerMemoryFact.id, OwnerMemoryFact.version).in_(active_refs),
        OwnerMemoryFact.deleted_at.is_(None),
        or_(OwnerMemoryFact.expires_at.is_(None), OwnerMemoryFact.expires_at > now()),
    ).order_by(OwnerMemoryFact.id))
    return [TraceMemoryFact(id=fact.id, text=fact.text, version=fact.version) for fact in facts]


def _project_step(steps: dict[str, TraceStep], event: AIRunEvent) -> None:
    tool = event.payload.get("tool")
    call_id = event.payload.get("call_id")
    if not isinstance(tool, str) or tool not in TOOL_LABELS or not isinstance(call_id, str) or not 0 < len(call_id) <= 256:
        return
    step = steps.get(call_id)
    if event.event_type == "ai.tool.requested":
        if step is not None or len(steps) >= MAX_STEPS:
            return
        query = event.payload.get("query")
        if tool == HISTORY_TOOL:
            metadata = history_event_query({
                key: event.payload[key] for key in ("start_at", "end_at", "before_message_id") if key in event.payload
            })
            details = []
            if "start_at" in metadata:
                details.append(f'{metadata["start_at"]} — {metadata["end_at"]}')
            if "before_message_id" in metadata:
                details.append(f'До сообщения {metadata["before_message_id"]}')
            query = "\n".join(details) or None
        steps[call_id] = TraceStep(
            id=event.id, kind=tool, label=TOOL_LABELS[tool],
            query=query[:2000] if tool in {"web_search", HISTORY_TOOL} and isinstance(query, str) else None,
            status="pending",
        )
    elif step is not None and step.kind == tool and step.status == "pending":
        result = event.payload.get("result")
        if isinstance(result, dict):
            step.status = "failed" if "error" in result else "completed"
            if tool == "web_search" and step.status == "completed":
                step.sources = _sources(result.get("sources"))
            elif tool == HISTORY_TOOL and step.status == "completed":
                count = result.get("count")
                if type(count) is int and 0 <= count <= MAX_HISTORY_MESSAGES:
                    step.label = f"{step.label} · сообщений: {count}"


@router.get(f"{PAGE}/{{run_id}}", response_model=AnswerTraceOut)
async def answer_trace(
    run_id: str, request: Request, db: Annotated[AsyncSession, Depends(get_db)],
) -> AnswerTraceOut:
    integration = await _authenticate(request, db)
    authorize(integration, "ai.personal.read")
    try:
        parsed_run_id = UUID(run_id)
    except ValueError:
        raise _error(404, "NOT_FOUND", "Answer trace not found") from None

    job = TelegramPersonalJob
    bound_job = select(job.id).where(
        job.run_id == AIRun.id, job.conversation_id == AIRun.conversation_id,
        job.owner_id == integration.owner_id, job.integration_id == integration.id,
        job.state == "done", job.deleted_at.is_(None),
    ).exists()
    run = await db.scalar(select(AIRun).join(AIConversation, AIRun.conversation_id == AIConversation.id).where(
        AIRun.id == str(parsed_run_id), AIRun.owner_id == integration.owner_id,
        AIRun.status == "completed", AIRun.deleted_at.is_(None),
        AIConversation.owner_id == integration.owner_id, AIConversation.deleted_at.is_(None),
        bound_job,
    ))
    if run is None:
        raise _error(404, "NOT_FOUND", "Answer trace not found")

    events = await db.stream_scalars(select(AIRunEvent).where(
        AIRunEvent.run_id == run.id, AIRunEvent.event_type.in_(EVENT_TYPES),
    ).order_by(AIRunEvent.sequence).execution_options(yield_per=100))
    model = run.model
    started_count = completed_count = None
    reply_id = None
    steps: dict[str, TraceStep] = {}
    async for event in events:
        if not isinstance(event.payload, dict):
            continue
        count = event.payload.get("history_message_count")
        valid_count = count if type(count) is int and count >= 0 else None
        if event.event_type == "ai.run.started":
            started_count = valid_count
            used_model = event.payload.get("model")
            if isinstance(used_model, str) and used_model:
                model = used_model[:150]
        elif event.event_type == "ai.run.completed":
            completed_count = valid_count
            message_id = event.payload.get("reply_message_id")
            if isinstance(message_id, str) and 0 < len(message_id) <= 36:
                reply_id = message_id
        else:
            _project_step(steps, event)

    sources: dict[str, TraceSource] = {}
    for step in steps.values():
        for source in step.sources:
            sources.setdefault(source.url, source)
    duration_ms = (
        max(0, (utc(run.completed_at) - utc(run.started_at)) // _MILLISECOND)
        if run.started_at is not None and run.completed_at is not None else None
    )
    return AnswerTraceOut(
        run_id=parsed_run_id, duration_ms=duration_ms, model=model,
        steps=list(steps.values()), sources=list(sources.values()),
        history_message_count=completed_count if completed_count is not None else started_count,
        memory_facts=await _memory_facts(db, run, reply_id),
    )


@static_router.get(PAGE, response_class=FileResponse)
async def answer_trace_page() -> FileResponse:
    return _static_file("index.html", "text/html")


@static_router.get(f"{PAGE}/app.js", response_class=FileResponse)
async def answer_trace_js() -> FileResponse:
    return _static_file("app.js", "text/javascript")


@static_router.get(f"{PAGE}/style.css", response_class=FileResponse)
async def answer_trace_css() -> FileResponse:
    return _static_file("style.css", "text/css")


def _static_file(filename: str, media_type: str) -> FileResponse:
    path = STATIC_DIR / filename
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, media_type=media_type)
