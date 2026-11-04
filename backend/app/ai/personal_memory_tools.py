"""Explicit memory tools for verified owner text/voice turns only."""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from .tools import ToolDescriptor, ToolRegistry


class RememberArgs(BaseModel):
    model_config = ConfigDict(extra='forbid')
    text: str = Field(min_length=1, max_length=2000)
    kind: Literal['preference','fact','goal','context'] = 'fact'
    expires_at: AwareDatetime | None = None


class ForgetArgs(BaseModel):
    model_config = ConfigDict(extra='forbid')
    fact_id: str | None = Field(default=None, min_length=1, max_length=36)
    text: str | None = Field(default=None, min_length=1, max_length=2000)
    version: int | None = Field(default=None, ge=1)

    @model_validator(mode='after')
    def exact_target(self):
        if bool(self.fact_id) == bool(self.text) or (self.fact_id and self.version is None):
            raise ValueError('Supply exact text or fact_id with its current version')
        return self


def register_memory_tools(registry: ToolRegistry, db: AsyncSession, owner_id: str,
                          event_id: str, source_message_id: str | None, *, source: str = 'telegram_ai') -> None:
    async def remember_fact(arguments: Mapping[str, Any]) -> Mapping[str, Any]:
        from .memory import remember
        args = RememberArgs.model_validate(arguments)
        item = await remember(db, owner_id, args.text, kind=args.kind, expires_at=args.expires_at,
                              source=source, source_message_id=source_message_id or event_id)
        return {'id':item.id,'version':item.version,'kind':item.kind,'remembered':True}

    async def forget_fact(arguments: Mapping[str, Any]) -> Mapping[str, Any]:
        from .memory import forget
        args = ForgetArgs.model_validate(arguments)
        item = await forget(db, owner_id, fact_id=args.fact_id, text=args.text, version=args.version)
        return {'forgotten':item is not None,'id':item.id if item else None,'version':item.version if item else None}

    registry.register(ToolDescriptor('remember', 'Remember an explicit owner fact; never infer facts from conversation',
        'memory.remember', lambda raw: RememberArgs.model_validate(raw).model_dump(mode='json'), remember_fact,
        input_schema=RememberArgs.model_json_schema()))
    registry.register(ToolDescriptor('forget', 'Forget only the fact explicitly identified by the owner',
        'memory.forget', lambda raw: ForgetArgs.model_validate(raw).model_dump(mode='json'), forget_fact,
        input_schema=ForgetArgs.model_json_schema()))
