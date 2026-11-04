"""Bounded domain reads with owner-bound keyset cursors and conditional pages."""
from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime

from app.core.config import get_settings
from app.core.db import get_db
from app.core.models import MailMessage, Note
from app.core.security import current_principal
from app.domains.api import MailMessageDetailOut, MailMessageOut, NoteOut
from app.domains.recurrence import utc
from app.sync.cursor import CursorCodec
from app.sync.errors import SyncException
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

router = APIRouter(prefix="/read")


class ReadPage[T](BaseModel):
    items: list[T]
    next_cursor: str | None = None
    etag: str
    not_modified: bool = False
    facets: dict[str, list[str]] | None = None


def signing_key() -> bytes:
    return hashlib.sha256(get_settings().secret_key.encode()).digest()


def page_tag(owner: str, scope: str, rows) -> str:
    versions = [(row.id, row.version, str(row.updated_at)) for row in rows]
    value = json.dumps(["read-page-v1", owner, scope, versions], separators=(",", ":"))
    return f'W/"{hmac.new(signing_key(), value.encode(), hashlib.sha256).hexdigest()}"'


def matches(supplied: str | None, tag: str) -> bool:
    return bool(supplied and any(value.strip().removeprefix("W/") == tag.removeprefix("W/") for value in supplied.split(",")))


async def read_page(db: AsyncSession, owner: str, kind: str, model, dto, limit: int, cursor: str | None, q: str, folder: str | None, tag: str | None, supplied: str | None, known: str | None, response: Response):
    scope = json.dumps([kind, limit, q, folder, tag], separators=(",", ":"))
    codec = CursorCodec(signing_key())
    filters = [model.owner_id == owner, model.deleted_at.is_(None)]
    if q:
        fields = [Note.title, Note.markdown_body] if kind == "notes" else [MailMessage.sender, MailMessage.subject, MailMessage.body]
        filters.append(or_(*(field.icontains(q, autoescape=True) for field in fields)))
    if kind == "notes":
        if folder == "unfiled":
            filters.append(Note.folder.is_(None))
        elif folder and folder.startswith("folder:"):
            filters.append(Note.folder == folder[7:])
        if tag:
            if db.get_bind().dialect.name == "postgresql":
                filters.append(Note.tags.cast(JSONB).contains([tag]))
            else:
                values = func.json_each(Note.tags).table_valued("value")
                filters.append(exists(select(1).select_from(values).where(values.c.value == tag)))
    if cursor:
        try:
            decoded = codec.decode(cursor, owner_id=owner, expected_kind=f"read-{kind}")
            token_scope, boundary = json.loads(decoded.after_resource_id or "null")
            if token_scope != scope:
                raise ValueError
            if kind == "notes":
                if not isinstance(boundary, str):
                    raise ValueError
                filters.append(Note.id > boundary)
            else:
                received, item_id = boundary
                instant = utc(datetime.fromisoformat(received))
                filters.append(or_(MailMessage.received_at < instant, and_(MailMessage.received_at == instant, MailMessage.id < item_id)))
        except SyncException as error:
            raise HTTPException(error.status_code, detail={"code": error.code.value, "message": error.message}) from error
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            raise HTTPException(422, detail={"code": "VALIDATION_ERROR", "message": "Invalid read page cursor"}) from error
    order = [Note.id] if kind == "notes" else [MailMessage.received_at.desc(), MailMessage.id.desc()]
    facets = None
    if kind == "notes" and cursor is None:
        labels = (await db.execute(select(Note.folder, Note.tags).where(Note.owner_id == owner, Note.deleted_at.is_(None)))).all()
        facets = {"folders": sorted({row.folder for row in labels if row.folder}), "tags": sorted({label for row in labels for label in row.tags})}
    etag_scope = json.dumps([scope, facets], separators=(",", ":"))
    # Conditional checks transfer only versions, never full note/mail bodies.
    metadata = list((await db.execute(select(model.id, model.version, model.updated_at).where(*filters).order_by(*order).limit(limit + 1))).all())
    etag = page_tag(owner, etag_scope, metadata)
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "private, no-store"
    if matches(supplied or known, etag):
        if supplied:
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, no-store"})
        # Native IPC transports JSON only; its adapter reconstructs HTTP 304.
        return {"items": [], "next_cursor": None, "etag": etag, "not_modified": True}
    query = select(model).where(*filters).order_by(*order).limit(limit + 1)
    if kind == 'mail':
        query = query.options(defer(MailMessage.body_html))
    rows = list((await db.execute(query)).scalars())
    # Recompute after the body SELECT in case a concurrent write committed.
    etag = page_tag(owner, etag_scope, rows)
    response.headers["ETag"] = etag
    items = rows[:limit]
    next_cursor = None
    if len(rows) > limit:
        last = items[-1]
        boundary = last.id if kind == "notes" else [utc(last.received_at).isoformat(), last.id]
        next_cursor = codec.encode(kind=f"read-{kind}", owner_id=owner, commit_seq=0, after_resource_id=json.dumps([scope, boundary], separators=(",", ":")))
    return {"items": [dto.model_validate(item) for item in items], "next_cursor": next_cursor, "etag": etag, "not_modified": False, "facets": facets}


@router.get("/notes", response_model=ReadPage[NoteOut], responses={304: {"description": "Page unchanged; no response body"}})
async def notes_page(response: Response, limit: int = Query(default=50, ge=1, le=100), cursor: str | None = Query(default=None, max_length=2048), q: str = Query(default="", max_length=200), folder: str | None = Query(default=None, max_length=127), tag: str | None = Query(default=None, max_length=80), known_etag: str | None = Query(default=None, max_length=128), if_none_match: str | None = Header(default=None, max_length=512), principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    return await read_page(db, principal[0].id, "notes", Note, NoteOut, limit, cursor, q.strip(), folder, tag, if_none_match, known_etag, response)


@router.get("/mail", response_model=ReadPage[MailMessageOut], responses={304: {"description": "Page unchanged; no response body"}})
async def mail_page(response: Response, limit: int = Query(default=50, ge=1, le=100), cursor: str | None = Query(default=None, max_length=2048), q: str = Query(default="", max_length=200), known_etag: str | None = Query(default=None, max_length=128), if_none_match: str | None = Header(default=None, max_length=512), principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    return await read_page(db, principal[0].id, "mail", MailMessage, MailMessageOut, limit, cursor, q.strip(), None, None, if_none_match, known_etag, response)


@router.get("/mail/{item_id}", response_model=MailMessageDetailOut)
async def mail_detail(item_id: str, principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    row = await db.scalar(select(MailMessage).where(MailMessage.id == item_id, MailMessage.owner_id == principal[0].id, MailMessage.deleted_at.is_(None)))
    if row is None:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "Message not found"})
    return row
