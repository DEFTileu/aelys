"""Opt-in, bounded web search tool for interactive owner turns."""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .tools import ToolDescriptor, ToolRegistry


class SearchArgs(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    query: str = Field(min_length=1, max_length=300)


class WebSearch:
    """The shared turn binds the provider call and its per-turn budget."""

    def __init__(self) -> None:
        self.execute: Callable[[str], Awaitable[Mapping[str, Any]]] | None = None

    async def __call__(self, args: Mapping[str, Any]) -> Mapping[str, Any]:
        if self.execute is None:
            raise RuntimeError('Search unavailable outside an owner turn')
        return await self.execute(str(args['query']))


def register_web_search(registry: ToolRegistry) -> None:
    def validate(args: Mapping[str, Any]) -> Mapping[str, Any]:
        return SearchArgs.model_validate(args).model_dump()

    registry.register(ToolDescriptor('web_search', 'Search the web for current information',
        'web.search', validate, WebSearch(), external_effect=True,
        input_schema=SearchArgs.model_json_schema()))
