"""The board's weather: the owner's city (coordinates rounded to 0.1 degree), a 30-minute forecast cache, and the endpoints.

Off by default: no row means no weather and no outbound call. Only the rounded coordinates ever leave for Open-Meteo.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta

import httpx
from app.companion.commands import owner_caller
from app.companion.models import CompanionWeather
from app.core import db as database
from app.core.db import get_db
from app.core.models import Device, User
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)
router = APIRouter()

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
REFRESH_EVERY = timedelta(minutes=30)
FETCH_TIMEOUT_SECONDS = 10.0
HOURS_KEPT = 12  # cached hours after the fetch; the snapshot shows the next MAX_HOURS_SHOWN of them
MAX_HOURS_SHOWN = 5
MAX_AGE = timedelta(hours=24)  # a day-old reading is worse than none


def coarse(value: float) -> float:
    """0.1 degree is about 10 km; `+ 0.0` turns -0.0 into 0.0."""
    return round(value, 1) + 0.0


async def _get_json(lat: float, lon: float) -> dict:
    params: dict[str, str | float | int] = {"latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 2, "current": "temperature_2m,weather_code",
              "hourly": "temperature_2m,weather_code", "daily": "temperature_2m_max,temperature_2m_min"}
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS) as client:
        response = await client.get(FORECAST_URL, params=params)
        response.raise_for_status()
        return response.json()


def parse_forecast(payload: dict, now: datetime) -> dict:
    """The small cache entry from an Open-Meteo answer; raises on anything missing so a bad answer never replaces a good one."""
    offset = int(payload["utc_offset_seconds"])
    hours = []
    hourly = payload["hourly"]
    for stamp, temp, code in zip(hourly["time"], hourly["temperature_2m"], hourly["weather_code"], strict=True):
        at = datetime.fromisoformat(stamp).replace(tzinfo=UTC) - timedelta(seconds=offset)  # local wall time -> UTC
        if at > now and temp is not None and code is not None:
            hours.append({"at": at.isoformat(), "t": round(temp), "c": int(code)})
        if len(hours) == HOURS_KEPT:
            break
    current, daily = payload["current"], payload["daily"]
    return {"t": round(current["temperature_2m"]), "c": int(current["weather_code"]), "hi": round(daily["temperature_2m_max"][0]),
            "lo": round(daily["temperature_2m_min"][0]), "off": offset, "hours": hours}


async def refresh_if_due(owner_id: str, now: datetime) -> bool:
    """Fetch the owner's forecast if their city is set and the last try was over 30 minutes ago; True if the cache changed.

    The claim is one atomic UPDATE, so two pushes (or two workers) never fetch twice. A failure keeps the last good forecast.
    """
    async with database.SessionLocal() as db:
        claimed = await db.execute(update(CompanionWeather).where(
            CompanionWeather.owner_id == owner_id, (CompanionWeather.attempted_at.is_(None)) | (CompanionWeather.attempted_at <= now - REFRESH_EVERY),
        ).values(attempted_at=now))
        await db.commit()
        if not claimed.rowcount:
            return False
        row = await db.get(CompanionWeather, owner_id, populate_existing=True)
        lat, lon = row.lat, row.lon
    try:
        forecast = parse_forecast(await asyncio.wait_for(_get_json(lat, lon), FETCH_TIMEOUT_SECONDS), now)
    except (httpx.HTTPError, TimeoutError, ValueError, KeyError, IndexError, TypeError) as exc:  # never the URL or coordinates: they are the owner's
        logger.warning("companion weather fetch failed owner=%s reason=%s", owner_id, type(exc).__name__)
        return False
    async with database.SessionLocal() as db:  # lat/lon guard: the owner may have picked another city meanwhile
        saved = await db.execute(update(CompanionWeather).where(CompanionWeather.owner_id == owner_id, CompanionWeather.lat == lat, CompanionWeather.lon == lon)
                                 .values(forecast_json=forecast, fetched_at=now))
        await db.commit()
    return bool(saved.rowcount)


def snapshot_view(row: CompanionWeather | None, now: datetime) -> dict | None:
    """The `weather` object for the snapshot, or None when there is no city, no data, or only day-old data."""
    if row is None or not row.forecast_json or row.fetched_at is None:
        return None
    forecast = row.forecast_json
    fetched = row.fetched_at if row.fetched_at.tzinfo else row.fetched_at.replace(tzinfo=UTC)
    if now - fetched > MAX_AGE:
        return None
    offset = timedelta(seconds=forecast["off"])
    upcoming = [(datetime.fromisoformat(h["at"]), h) for h in forecast["hours"]]
    return {"temp": forecast["t"], "code": forecast["c"], "hi": forecast["hi"], "lo": forecast["lo"], "updated": fetched,
            "hours": [{"h": (at + offset).hour, "t": h["t"], "c": h["c"]} for at, h in upcoming if at > now][:MAX_HOURS_SHOWN]}


async def refresh_loop(interval: float = 600.0) -> None:
    """Nudge owners with an online board so a push (which refreshes if due) happens even when nothing else changes."""
    from app.companion.hub import hub  # lazy: hub imports this module

    while True:
        await asyncio.sleep(interval)
        for owner_id in hub.online_owners():
            hub.mark_owner_dirty(owner_id)


class WeatherIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=64)
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)

    @field_validator("name")
    @classmethod
    def _named(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        return value


class WeatherOut(BaseModel):
    name: str | None = None
    lat: float | None = None
    lon: float | None = None
    updated: datetime | None = None  # when the cached forecast was fetched; None until the first good fetch


def _out(row: CompanionWeather | None) -> WeatherOut:
    return WeatherOut(name=row.name, lat=row.lat, lon=row.lon, updated=row.fetched_at) if row else WeatherOut()


@router.get("/weather", response_model=WeatherOut)
async def get_weather(principal: tuple[User, Device] = Depends(owner_caller), db: AsyncSession = Depends(get_db)):
    return _out(await db.get(CompanionWeather, principal[0].id))


@router.put("/weather", response_model=WeatherOut)
async def put_weather(body: WeatherIn, principal: tuple[User, Device] = Depends(owner_caller), db: AsyncSession = Depends(get_db)):
    from app.companion.hub import mark_dirty  # lazy: hub imports this module

    owner_id = principal[0].id
    lat, lon = coarse(body.lat), coarse(body.lon)
    row = await db.get(CompanionWeather, owner_id)
    if row is None:
        row = CompanionWeather(owner_id=owner_id, name=body.name, lat=lat, lon=lon)
        db.add(row)
    else:
        if (row.lat, row.lon) != (lat, lon):  # same place: keep the cache, so re-saving cannot dodge the 30-minute limit
            row.forecast_json = row.fetched_at = row.attempted_at = None
        row.name, row.lat, row.lon = body.name, lat, lon
    mark_dirty(db, owner_id)
    await db.commit()
    return _out(row)


@router.delete("/weather", response_model=WeatherOut)
async def delete_weather(principal: tuple[User, Device] = Depends(owner_caller), db: AsyncSession = Depends(get_db)):
    from app.companion.hub import mark_dirty

    row = await db.get(CompanionWeather, principal[0].id)
    if row is not None:
        await db.delete(row)
        mark_dirty(db, principal[0].id)
        await db.commit()
    return WeatherOut()
