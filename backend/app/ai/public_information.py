"""Read-only weather forecasts and official exchange rates for the assistant."""
from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime
from decimal import Decimal, localcontext
from typing import Any
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import httpx
from app.companion.weather import FORECAST_URL
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .tools import ToolDescriptor, ToolRegistry

_WEATHER_SCOPE = "public.weather"
_RATE_SCOPE = "public.exchange_rate"
PUBLIC_INFORMATION_SCOPES = frozenset({_WEATHER_SCOPE, _RATE_SCOPE})
_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
_RATES_URL = "https://nationalbank.kz/rss/get_rates.cfm"
_ALMATY = ZoneInfo("Asia/Almaty")
_MAX_RESPONSE = 256_000


class WeatherQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    city: str = Field(min_length=2, max_length=70, description="Public city name only, without an address")
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$", description="ISO 3166-1 country code if known")
    region: str | None = Field(default=None, min_length=2, max_length=70, description="Province or region for cities with the same name")
    days: int = Field(default=3, ge=1, le=7, description="Number of days starting from today in the city")

    @field_validator("city")
    @classmethod
    def _public_city_name(cls, value: str) -> str:
        if not all(char.isalpha() or char in " -.‘’'" for char in value) or not any(char.isalpha() for char in value):
            raise ValueError("Provide a city name only")
        return value


class RateQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    base: str = Field(pattern=r"^[A-Z]{3}$", description="ISO currency code of the currency to convert")
    quote: str = Field(default="KZT", pattern=r"^[A-Z]{3}$")
    amount: Decimal = Field(default=Decimal(1), ge=0, max_digits=18, decimal_places=6, allow_inf_nan=False)
    as_of: date | None = Field(default=None, description="ISO date; defaults to today in Kazakhstan")


async def _request(url: str, params: Mapping[str, str | float | int], client: httpx.AsyncClient | None) -> bytes:
    if client is None:
        async with httpx.AsyncClient(timeout=8.0, trust_env=False) as remote:
            return await _request(url, params, remote)
    async with client.stream("GET", url, params=params, follow_redirects=False) as response:
        response.raise_for_status()
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > _MAX_RESPONSE:
                raise ValueError("Public data response too large")
        return bytes(body)


async def _weather(query: WeatherQuery, client: httpx.AsyncClient | None, clock: Callable[[], datetime]) -> dict[str, Any]:
    params: dict[str, str | int] = {"name": query.city, "count": 8, "language": "en"}
    if query.country_code:
        params["countryCode"] = query.country_code
    places = json.loads(await _request(_GEOCODE_URL, params, client)).get("results") or []
    if not places:
        return {"error": "CITY_NOT_FOUND", "source": "Open-Meteo"}
    if query.region:
        places = [item for item in places if (item.get("admin1") or "").casefold() == query.region.casefold()]
        if not places:
            return {"error": "CITY_NOT_FOUND_IN_REGION", "source": "Open-Meteo"}
    exact = [item for item in places if item.get("name", "").casefold() == query.city.casefold()]
    if len(exact) > 1:
        exact.sort(key=lambda item: item.get("population") or 0, reverse=True)
        largest, next_largest = (item.get("population") or 0 for item in exact[:2])
        if largest < max(50_000, 10 * next_largest):
            return {"error": "AMBIGUOUS_CITY", "matches": [
                {"city": item.get("name"), "region": item.get("admin1"), "country_code": item.get("country_code")}
                for item in exact
            ]}
    city = (exact or places)[0]
    payload = json.loads(await _request(FORECAST_URL, {
        "latitude": float(city["latitude"]), "longitude": float(city["longitude"]),
        "timezone": "auto", "forecast_days": query.days,
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
        "daily": "temperature_2m_min,temperature_2m_max,precipitation_probability_max,weather_code",
    }, client))
    daily = payload["daily"]
    forecast = [
        {"date": iso_date, "min_c": low, "max_c": high, "precipitation_probability_percent": rain, "weather_code": code}
        for iso_date, low, high, rain, code in zip(
            daily["time"], daily["temperature_2m_min"], daily["temperature_2m_max"],
            daily["precipitation_probability_max"], daily["weather_code"], strict=True,
        )
    ]
    return {"source": "Open-Meteo", "city": city["name"], "country": city.get("country"),
            "timezone": payload["timezone"], "current": payload["current"], "forecast": forecast,
            "retrieved_at": clock().isoformat()}


async def _exchange(query: RateQuery, client: httpx.AsyncClient | None, clock: Callable[[], datetime]) -> dict[str, Any]:
    as_of = query.as_of or clock().astimezone(_ALMATY).date()
    formatted_date = as_of.strftime("%d.%m.%Y")
    payload = await _request(_RATES_URL, {"fdate": formatted_date}, client)
    if b"<!DOCTYPE" in payload.upper() or b"<!ENTITY" in payload.upper() or b"\x00" in payload:
        raise ValueError("Invalid currency feed")
    feed = ElementTree.fromstring(payload)
    if feed.tag != "rates" or feed.findtext("date") != formatted_date:
        return {"error": "RATE_DATE_UNAVAILABLE", "effective_date": as_of.isoformat()}
    rates = {"KZT": Decimal(1)}
    requested = {query.base, query.quote} - rates.keys()
    with localcontext() as arithmetic:
        arithmetic.prec = 34
        for item in feed.findall("item"):
            code = item.findtext("title")
            if not code or code not in requested:
                continue
            value = Decimal(item.findtext("description") or "").normalize()
            nominal = Decimal(item.findtext("quant") or "")
            if value.is_finite() and nominal.is_finite() and value > 0 and nominal > 0:
                rates[code] = value / nominal
        if missing := requested - rates.keys():
            return {"error": "CURRENCY_NOT_SUPPORTED", "missing": sorted(missing), "effective_date": as_of.isoformat()}
        rate = rates[query.base] / rates[query.quote]
        converted = format(query.amount * rate, "f")
        return {"source": "National Bank of Kazakhstan", "kind": "official_reference_rate",
                "effective_date": as_of.isoformat(), "base": query.base, "quote": query.quote,
                "rate": format(rate, "f"), "amount": format(query.amount, "f"), "converted": converted}


def register_public_information(
    registry: ToolRegistry, *, client: httpx.AsyncClient | None = None,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> None:
    async def weather(args: Mapping[str, Any]) -> Mapping[str, Any]:
        try:
            return await _weather(WeatherQuery.model_validate(args), client, clock)
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError, AttributeError):
            return {"error": "WEATHER_UNAVAILABLE", "source": "Open-Meteo"}

    async def rates(args: Mapping[str, Any]) -> Mapping[str, Any]:
        try:
            return await _exchange(RateQuery.model_validate(args), client, clock)
        except (httpx.HTTPError, TimeoutError, ValueError, ArithmeticError, ElementTree.ParseError):
            return {"error": "RATES_UNAVAILABLE", "source": "National Bank of Kazakhstan"}

    registry.register(ToolDescriptor("get_weather",
        "Read current conditions and a daily forecast. Supply a public city from the conversation; ask for a city if unknown. "
        "Weather codes use WMO, temperatures are Celsius. Use the forecast date in the city's timezone.",
        _WEATHER_SCOPE, lambda args: WeatherQuery.model_validate(args).model_dump(mode="json"), weather,
        external_effect=True, input_schema=WeatherQuery.model_json_schema()))
    registry.register(ToolDescriptor("get_exchange_rate",
        "Read the official National Bank of Kazakhstan reference rate on a date, including an optional conversion; "
        "quote the effective date and distinguish it from a bank or exchange-office buy/sell price.",
        _RATE_SCOPE, lambda args: RateQuery.model_validate(args).model_dump(mode="json"), rates,
        external_effect=True, input_schema=RateQuery.model_json_schema()))
