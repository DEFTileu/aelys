"""Focus guard rules: tightening is instant, loosening waits for the next local midnight.

Pure (no DB, no FastAPI) so the rule can be unit-tested. "Today" is the owner's local
date sent by the client, never the server clock.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Annotated

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StringConstraints,
    field_validator,
)

PackageName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$", max_length=255)]


class FocusApp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9_-]{1,40}$")]
    label: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    packages: Annotated[list[PackageName], Field(min_length=1, max_length=10)]
    limit_minutes: Annotated[StrictInt, Field(ge=1, le=1440)]

    @field_validator("packages")
    @classmethod
    def _canonical(cls, value: list[str]) -> list[str]:
        return sorted(set(value))  # order and repeats are not a change


class FocusConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    apps: Annotated[list[FocusApp], Field(max_length=30)] = []

    @field_validator("apps")
    @classmethod
    def _canonical(cls, value: list[FocusApp]) -> list[FocusApp]:
        if len({a.id for a in value}) != len(value):
            raise ValueError("duplicate app id")
        return sorted(value, key=lambda a: a.id)


class FocusState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    effective: FocusConfig = FocusConfig()
    pending: FocusConfig | None = None
    effective_from: str | None = None  # ISO date the pending config takes over


def tighten(effective: FocusConfig, desired: FocusConfig) -> FocusConfig:
    """Per app id: lowest limit, union of packages. Apps only in `effective` stay (removal is loosening)."""
    merged = {a.id: a for a in effective.apps}
    for app in desired.apps:
        old = merged.get(app.id)
        merged[app.id] = app if old is None else old.model_copy(update={
            "limit_minutes": min(old.limit_minutes, app.limit_minutes),
            "packages": sorted({*old.packages, *app.packages}),
        })
    return FocusConfig(apps=list(merged.values()))


def apply_edit(state: FocusState, desired: FocusConfig, today: date) -> FocusState:
    effective = tighten(state.effective, desired)
    if desired == effective:
        return FocusState(effective=effective)
    return FocusState(effective=effective, pending=desired, effective_from=(today + timedelta(days=1)).isoformat())


def promote(state: FocusState, today: date) -> FocusState:
    if state.pending is not None and state.effective_from and today >= date.fromisoformat(state.effective_from):
        return FocusState(effective=state.pending)
    return state
