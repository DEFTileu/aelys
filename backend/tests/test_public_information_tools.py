from datetime import UTC, datetime

import httpx
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.ai.tools import ToolRegistry


async def test_official_rates_use_requested_as_of_date_and_nominal():
    from app.ai.public_information import (
        PUBLIC_INFORMATION_SCOPES,
        register_public_information,
    )

    def respond(request):
        assert request.url.host == "nationalbank.kz"
        assert request.url.params["fdate"] == "25.11.2026"
        return httpx.Response(200, text="""<rates><date>25.11.2026</date>
          <item><title>JPY</title><description>320.89</description><quant>100</quant></item>
          <item><title>USD</title><description>502.01</description><quant>1</quant></item>
        </rates>""")

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        registry = ToolRegistry(ServerPolicyEngine())
        register_public_information(registry, client=client, clock=lambda: datetime(2026, 11, 25, 12, tzinfo=UTC))
        context = PermissionContext(actor="test", scopes=PUBLIC_INFORMATION_SCOPES, external_scopes=PUBLIC_INFORMATION_SCOPES)
        result = await registry.invoke(ToolCall("get_exchange_rate", {"base": "JPY", "quote": "KZT", "amount": "100"}), context)
        assert result["rate"] == "3.2089" and result["converted"] == "320.8900"
        assert result["effective_date"] == "2026-11-25"


async def test_weather_resolves_public_city_and_returns_local_forecast():
    from app.ai.public_information import (
        PUBLIC_INFORMATION_SCOPES,
        register_public_information,
    )

    def respond(request):
        if request.url.host == "geocoding-api.open-meteo.com":
            assert request.url.params["name"] == "Алматы"
            assert request.url.params["countryCode"] == "KZ"
            return httpx.Response(200, json={"results": [
                {"name": "Алматы", "country": "Казахстан", "country_code": "KZ", "latitude": 43.25, "longitude": 76.95,
                 "population": 1977011, "admin1": "Алматы"},
                {"name": "Алматы", "country": "Казахстан", "country_code": "KZ", "latitude": 49.0, "longitude": 73.0,
                 "population": 1000, "admin1": "Карагандинская область"},
            ]})
        assert request.url.host == "api.open-meteo.com"
        assert request.url.params["timezone"] == "auto"
        assert request.url.params["latitude"] == "43.25"
        return httpx.Response(200, json={
            "timezone": "Asia/Almaty", "current": {"time": "2026-11-25T17:00", "temperature_2m": 3},
            "daily": {"time": ["2026-11-25", "2026-11-26"], "temperature_2m_min": [-4, -5],
                      "temperature_2m_max": [5, 6], "precipitation_probability_max": [5, 10], "weather_code": [0, 2]},
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        registry = ToolRegistry(ServerPolicyEngine())
        register_public_information(registry, client=client)
        context = PermissionContext(actor="test", scopes=PUBLIC_INFORMATION_SCOPES, external_scopes=PUBLIC_INFORMATION_SCOPES)
        result = await registry.invoke(ToolCall("get_weather", {"city": "Алматы", "country_code": "KZ"}), context)
        assert result["city"] == "Алматы" and result["timezone"] == "Asia/Almaty"
        assert result["forecast"][1]["date"] == "2026-11-26"
        assert result["forecast"][1]["precipitation_probability_percent"] == 10
