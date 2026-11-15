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

MAX_APPS = 30
MAX_PACKAGES = 10
PackageName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$", max_length=255)]


class FocusApp(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9_-]{1,40}$")]
    label: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    packages: Annotated[list[PackageName], Field(min_length=1, max_length=MAX_PACKAGES)]
    limit_minutes: Annotated[StrictInt, Field(ge=1, le=1440)]

    @field_validator("packages")
    @classmethod
    def _canonical(cls, value: list[str]) -> list[str]:
        return sorted(set(value))  # order and repeats are not a change


class FocusConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    apps: Annotated[list[FocusApp], Field(max_length=MAX_APPS)] = []

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


class FocusLimitError(ValueError):
    """The tightened result would not fit the limits; never clamp, since dropping a package would loosen."""


def _shape(config: FocusConfig) -> dict[str, tuple[int, list[str]]]:
    """What the delay rule compares: a label change is never a loosening."""
    return {a.id: (a.limit_minutes, a.packages) for a in config.apps}


def tighten(effective: FocusConfig, desired: FocusConfig) -> FocusConfig:
    """Per app id: lowest limit, union of packages, the desired label. Apps only in `effective` stay (removal is loosening)."""
    merged = {a.id: a for a in effective.apps}
    for app in desired.apps:
        old = merged.get(app.id)
        packages = sorted({*old.packages, *app.packages}) if old else app.packages
        if len(packages) > MAX_PACKAGES:
            raise FocusLimitError(f"App '{app.id}' would have {len(packages)} packages; at most {MAX_PACKAGES} are allowed")
        merged[app.id] = FocusApp(id=app.id, label=app.label, packages=packages,
                                  limit_minutes=min(old.limit_minutes, app.limit_minutes) if old else app.limit_minutes)
    if len(merged) > MAX_APPS:
        raise FocusLimitError(f"{len(merged)} apps would be guarded; at most {MAX_APPS} are allowed (removals only apply tomorrow)")
    return FocusConfig(apps=list(merged.values()))


def apply_edit(state: FocusState, desired: FocusConfig, today: date) -> FocusState:
    effective = tighten(state.effective, desired)
    if _shape(desired) == _shape(effective):
        return FocusState(effective=effective)
    return FocusState(effective=effective, pending=desired, effective_from=(today + timedelta(days=1)).isoformat())


def promote(state: FocusState, today: date) -> FocusState:
    if state.pending is not None and state.effective_from and today >= date.fromisoformat(state.effective_from):
        return FocusState(effective=state.pending)
    return state
