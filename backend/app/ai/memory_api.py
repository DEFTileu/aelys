"""Authenticated, versioned owner memory; provenance is assigned by the server."""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from app.core.db import get_db
from app.core.security import current_principal
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    field_validator,
    model_validator,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import memory
from .errors import PolicyDenied
from .memory_models import OwnerMemoryFact

MemoryKind = Literal['preference', 'fact', 'goal', 'context']


class _MemoryRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def protected(request):
            try:
                return await handler(request)
            except RequestValidationError:
                # Pydantic's default details echo input text; memory stays private
                # even when validation fails or the client supplied extra fields.
                raise HTTPException(422, detail={'code': 'VALIDATION_ERROR',
                    'message': 'Invalid memory request'}) from None
            except PolicyDenied:
                raise HTTPException(403, detail={'code': 'POLICY_DENIED',
                    'message': 'Memory access is not permitted'}) from None
            except ValueError:
                raise HTTPException(422, detail={'code': 'VALIDATION_ERROR',
                    'message': 'Invalid memory request'}) from None
        return protected


router = APIRouter(route_class=_MemoryRoute)


class MemoryFactIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    text: str = Field(min_length=1, max_length=2000)
    kind: MemoryKind = 'fact'
    expires_at: AwareDatetime | None = None

    @field_validator('text')
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('Memory text is empty')
        return value


class MemoryFactPatch(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: StrictInt = Field(ge=1)
    text: str | None = Field(default=None, min_length=1, max_length=2000)
    kind: MemoryKind | None = None
    expires_at: AwareDatetime | None = None

    @model_validator(mode='after')
    def validate_supplied_fields(self):
        if 'text' in self.model_fields_set and (self.text is None or not self.text.strip()):
            raise ValueError('Memory text is empty')
        if 'kind' in self.model_fields_set and self.kind is None:
            raise ValueError('Memory kind is required')
        return self


class MemoryFactOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    owner_id: str
    version: int
    text: str
    kind: MemoryKind
    source: str
    source_message_id: str | None
    expires_at: datetime | None
    created_at: datetime
    updated_at: datetime

    @field_validator('expires_at', 'created_at', 'updated_at')
    @classmethod
    def utc_instants(cls, value: datetime | None) -> datetime | None:
        return None if value is None else value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


@router.get('/ai/memory', response_model=list[MemoryFactOut])
async def list_facts(response: Response, limit: int = Query(default=100, ge=1, le=100),
                     query: str | None = Query(default=None, max_length=200),
                     principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    response.headers['Cache-Control'] = 'no-store'
    return await memory.list_memory(db, user.id, limit=limit, query=query)


@router.post('/ai/memory', response_model=MemoryFactOut)
async def create_fact(body: MemoryFactIn, response: Response,
                      principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    item = await memory.remember(db, user.id, body.text, kind=body.kind,
                                 source='api', expires_at=body.expires_at)
    await db.commit()
    await db.refresh(item)
    response.headers['Cache-Control'] = 'no-store'
    return item


@router.patch('/ai/memory/{fact_id}', response_model=MemoryFactOut)
async def edit_fact(fact_id: str, body: MemoryFactPatch, response: Response,
                    principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    # Read without a row lock: the service takes its owner lock and applies the
    # mandatory version CAS. A racing edit fails rather than applying stale merges.
    item = (await db.execute(select(OwnerMemoryFact).where(OwnerMemoryFact.id == fact_id,
        OwnerMemoryFact.owner_id == user.id, OwnerMemoryFact.deleted_at.is_(None)))).scalar_one_or_none()
    if item is None:
        raise HTTPException(404, detail={'code': 'NOT_FOUND', 'message': 'Memory fact not found'})
    updated = await memory.update_fact(db, user.id, fact_id, body.version,
        text=body.text if body.text is not None else item.text,
        kind=body.kind if body.kind is not None else item.kind,
        expires_at=body.expires_at if 'expires_at' in body.model_fields_set else item.expires_at)
    await db.commit()
    await db.refresh(updated)
    response.headers['Cache-Control'] = 'no-store'
    return updated


@router.delete('/ai/memory/{fact_id}')
async def delete_fact(fact_id: str, response: Response, version: int = Query(ge=1),
                      principal=Depends(current_principal), db: AsyncSession = Depends(get_db)):
    user, _ = principal
    item = await memory.forget(db, user.id, fact_id=fact_id, version=version)
    if item is None:
        raise HTTPException(404, detail={'code': 'NOT_FOUND', 'message': 'Memory fact not found'})
    await db.commit()
    response.headers['Cache-Control'] = 'no-store'
    return {'deleted': True}
