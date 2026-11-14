import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from app.companion import weather
from app.companion.models import CompanionWeather
from app.companion.snapshot import CompanionSnapshot, build_snapshot, for_device
from app.core import db
from app.core.models import CalendarEvent, Notification, Task, User
from app.main import app
from companion_helpers import B, bearer, claim_owner, companion_token, pair_companion
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

NOW = datetime(2026, 11, 13, 9, 30, tzinfo=UTC)
OFFSET = 3 * 3600  # the test city is UTC+3


def payload(now=NOW, temp=7.4):
    """An Open-Meteo answer: hourly local wall-clock stamps from the start of the local day, two days."""
    start = (now + timedelta(seconds=OFFSET)).replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    stamps = [start + timedelta(hours=i) for i in range(48)]
    return {"utc_offset_seconds": OFFSET, "current": {"temperature_2m": temp, "weather_code": 61},
            "daily": {"temperature_2m_max": [9.6, 10.0], "temperature_2m_min": [-0.4, 1.0]},
            "hourly": {"time": [s.strftime("%Y-%m-%dT%H:%M") for s in stamps], "temperature_2m": [float(i) for i in range(48)],
                       "weather_code": [i % 4 for i in range(48)]}}


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/weather.db")
    async with engine.begin() as connection:
        await connection.run_sync(db.Base.metadata.create_all)
    monkeypatch.setattr(db, "SessionLocal", async_sessionmaker(engine, expire_on_commit=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http
    await engine.dispose()


@pytest.fixture
def fetches(monkeypatch):
    """No network in tests: every call to Open-Meteo is recorded here and answered with the sample forecast."""
    class Calls(list):
        def set(self, value):
            fake.result = value

    calls = Calls()

    async def fake(lat, lon):
        calls.append((lat, lon))
        if isinstance(fake.result, Exception):
            raise fake.result
        return fake.result
    fake.result = payload()
    monkeypatch.setattr(weather, "_get_json", fake)
    return calls


async def owner_session(client):
    _, session = await claim_owner(client)
    return session, (await client.get(f"{B}/me", headers=bearer(session))).json()["id"]


async def put_city(client, session, **body):
    return await client.put(f"{B}/companion/weather", headers=bearer(session), json={"name": "Testville", "lat": 12.345, "lon": 45.678} | body)


async def snap(owner_id, now=NOW):
    async with db.SessionLocal() as session:
        return await build_snapshot(session, owner_id, now)


def test_parse_forecast_rounds_and_keeps_only_future_hours():
    cached = weather.parse_forecast(payload(), NOW)
    assert (cached["t"], cached["c"], cached["hi"], cached["lo"], cached["off"]) == (7, 61, 10, -0, OFFSET)
    assert len(cached["hours"]) == weather.HOURS_KEPT
    assert cached["hours"][0]["at"] == "2026-11-13T10:00:00+00:00" and cached["hours"][0]["t"] == 13  # local 13:00 is index 13
    with pytest.raises(KeyError):
        weather.parse_forecast({**payload(), "current": {}}, NOW)


@pytest.mark.asyncio
async def test_put_rounds_coordinates_and_get_returns_them(client):
    session, _ = await owner_session(client)
    assert (await client.get(f"{B}/companion/weather", headers=bearer(session))).json() == {"name": None, "lat": None, "lon": None, "updated": None}
    put = await put_city(client, session, name="  Testville  ", lat=-0.04, lon=45.649)
    assert put.status_code == 200 and put.json() == {"name": "Testville", "lat": 0.0, "lon": 45.6, "updated": None}
    assert (await client.get(f"{B}/companion/weather", headers=bearer(session))).json()["lat"] == 0.0
    async with db.SessionLocal() as s:
        row = await s.get(CompanionWeather, (await client.get(f"{B}/me", headers=bearer(session))).json()["id"])
        assert (row.lat, row.lon) == (0.0, 45.6) and str(row.lat) == "0.0"  # never -0.0, never the precise value


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [{"lat": 90.1}, {"lat": -91}, {"lon": 180.5}, {"lon": -181}, {"name": ""}, {"name": "   "}, {"name": "x" * 65},
                                  {"lat": "nan"}, {"lat": None}, {"extra": 1}])
async def test_put_rejects_bad_input(client, body):
    session, _ = await owner_session(client)
    assert (await put_city(client, session, **body)).status_code == 422


@pytest.mark.asyncio
async def test_put_accepts_the_limits(client):
    session, _ = await owner_session(client)
    assert (await put_city(client, session, name="x" * 64, lat=-90, lon=180)).status_code == 200


@pytest.mark.asyncio
async def test_delete_turns_weather_off_and_a_board_cannot_use_the_endpoints(client, fetches):
    session, owner_id = await owner_session(client)
    assert (await client.get(f"{B}/companion/weather")).status_code == 401
    await put_city(client, session)
    assert await weather.refresh_if_due(owner_id, NOW) and (await snap(owner_id)).weather
    assert (await client.delete(f"{B}/companion/weather", headers=bearer(session))).json()["name"] is None
    assert (await snap(owner_id)).weather is None
    assert "weather" not in json.loads((await snap(owner_id)).model_dump_json())  # no field, not a null
    assert not await weather.refresh_if_due(owner_id, NOW + timedelta(hours=5)) and len(fetches) == 1  # no city: no outbound call
    assert (await client.delete(f"{B}/companion/weather", headers=bearer(session))).status_code == 200  # idempotent


@pytest.mark.asyncio
async def test_a_paired_board_may_not_read_or_set_the_city(client):
    _, board_key, device_id = await pair_companion(client)
    token = await companion_token(client, board_key, device_id)
    for method in ("get", "put", "delete"):
        kwargs = {"json": {"name": "x", "lat": 1, "lon": 1}} if method == "put" else {}
        assert (await getattr(client, method)(f"{B}/companion/weather", headers={"Authorization": f"Bearer {token}"}, **kwargs)).status_code == 403


@pytest.mark.asyncio
async def test_no_city_no_weather_no_call(client, fetches):
    _, owner_id = await owner_session(client)
    assert not await weather.refresh_if_due(owner_id, NOW)
    assert fetches == [] and (await snap(owner_id)).weather is None


@pytest.mark.asyncio
async def test_fetch_sends_only_rounded_coordinates_and_fills_the_snapshot(client, fetches):
    session, owner_id = await owner_session(client)
    await put_city(client, session)
    assert await weather.refresh_if_due(owner_id, NOW)
    assert fetches == [(12.3, 45.7)]
    w = (await snap(owner_id)).weather
    assert (w.temp, w.code, w.hi, w.lo, w.updated) == (7, 61, 10, 0, NOW)
    assert [(h.h, h.t, h.c) for h in w.hours] == [(13, 13, 1), (14, 14, 2), (15, 15, 3), (16, 16, 0), (17, 17, 1)]  # the next 5 hours, city-local
    wire = (await snap(owner_id)).model_dump_json()
    assert "Testville" not in wire and "55" not in wire  # the board gets neither the name nor coordinates


@pytest.mark.asyncio
async def test_cache_window_is_thirty_minutes(client, fetches):
    session, owner_id = await owner_session(client)
    await put_city(client, session)
    assert await weather.refresh_if_due(owner_id, NOW)
    assert not await weather.refresh_if_due(owner_id, NOW + timedelta(minutes=29, seconds=59))
    assert len(fetches) == 1
    assert await weather.refresh_if_due(owner_id, NOW + timedelta(minutes=30))
    assert len(fetches) == 2
    # re-saving the same place does not reset the window; another place does
    await put_city(client, session, name="Renamed", lat=12.34)
    assert not await weather.refresh_if_due(owner_id, NOW + timedelta(minutes=31)) and len(fetches) == 2
    await put_city(client, session, lat=10.0)
    assert await weather.refresh_if_due(owner_id, NOW + timedelta(minutes=31)) and fetches[-1] == (10.0, 45.7)


@pytest.mark.asyncio
async def test_failure_keeps_the_last_good_forecast_and_waits_out_the_window(client, fetches):
    session, owner_id = await owner_session(client)
    await put_city(client, session)
    await weather.refresh_if_due(owner_id, NOW)
    for failure in (httpx.ConnectTimeout("t"), httpx.HTTPStatusError("500", request=httpx.Request("GET", "http://x"), response=httpx.Response(500)),
                    TimeoutError(), ValueError("not json"), {"current": {}}):
        fetches.set(failure)
        later = NOW + timedelta(hours=1)
        assert not await weather.refresh_if_due(owner_id, later)
        assert (await snap(owner_id, later)).weather.temp == 7  # still the good value, never an error and never an empty snapshot
        async with db.SessionLocal() as s:
            row = await s.get(CompanionWeather, owner_id)
            row.attempted_at = NOW  # rewind the window for the next kind of failure
            await s.commit()
    attempts = len(fetches)
    assert not await weather.refresh_if_due(owner_id, NOW + timedelta(minutes=10)) and len(fetches) == attempts
    async with db.SessionLocal() as s:  # a failed first fetch leaves no weather and the snapshot still builds
        await s.delete(await s.get(CompanionWeather, owner_id))
        await s.commit()
        s.add(CompanionWeather(owner_id=owner_id, name="n", lat=1.0, lon=1.0))
        await s.commit()
    assert not await weather.refresh_if_due(owner_id, NOW) and (await snap(owner_id)).weather is None


@pytest.mark.asyncio
async def test_old_forecast_is_dropped_and_past_hours_are_not_shown(client, fetches):
    session, owner_id = await owner_session(client)
    await put_city(client, session)
    await weather.refresh_if_due(owner_id, NOW)
    assert (await snap(owner_id, NOW + timedelta(hours=3))).weather.hours[0].h == 16
    assert (await snap(owner_id, NOW + timedelta(hours=25))).weather is None


@pytest.mark.asyncio
async def test_owners_never_see_each_others_weather(client, fetches):
    session, owner_id = await owner_session(client)
    async with db.SessionLocal() as s:
        other = User(email="other@test.example")
        s.add(other)
        await s.commit()
        other_id = other.id
    await put_city(client, session)
    await weather.refresh_if_due(owner_id, NOW)
    assert (await snap(other_id)).weather is None
    assert not await weather.refresh_if_due(other_id, NOW) and len(fetches) == 1


@pytest.mark.asyncio
async def test_lost_mode_hides_the_weather(client, fetches, monkeypatch):
    session, owner_id = await owner_session(client)
    await put_city(client, session)
    await weather.refresh_if_due(owner_id, NOW)
    full = await snap(owner_id)

    async def lost(*_):
        return True
    monkeypatch.setattr("app.companion.snapshot.lost_mode_on", lost)
    async with db.SessionLocal() as s:
        assert (await for_device(s, full, "board")).weather is None


@pytest.mark.asyncio
async def test_weather_fits_the_frame_budget_with_a_full_cyrillic_snapshot(client, fetches):
    session, owner_id = await owner_session(client)
    await put_city(client, session)
    await weather.refresh_if_due(owner_id, NOW)
    long = "Я" * 120
    async with db.SessionLocal() as s:
        s.add_all([Task(owner_id=owner_id, title=long, due_at=NOW + timedelta(hours=h + 1)) for h in range(5)])
        s.add_all([CalendarEvent(owner_id=owner_id, title=long, starts_at=NOW + timedelta(hours=h + 1), ends_at=NOW + timedelta(hours=h + 2)) for h in range(4)])
        s.add_all([Notification(owner_id=owner_id, kind="calendar." + "k" * 14, title=long, created_at=NOW - timedelta(minutes=i)) for i in range(5)])
        await s.commit()
    full = await snap(owner_id)
    wire = json.dumps({"type": "snapshot", "snapshot": full.model_dump(mode="json")}, separators=(",", ":"), ensure_ascii=False).encode()
    assert full.weather and len(full.weather.hours) == 5 and len(wire) <= 4096
    assert len(json.dumps(full.weather.model_dump(mode="json"), separators=(",", ":"))) < 300
    assert isinstance(full, CompanionSnapshot) and full.next_task and full.next_event and len(full.notices) == 5  # weather never evicts the v1 fields


@pytest.mark.asyncio
async def test_a_push_refreshes_a_due_forecast_once_and_a_broken_fetch_still_sends(client, fetches):
    from app.companion.hub import hub
    session, owner_id = await owner_session(client)
    await put_city(client, session)
    sent = []

    async def send(message):
        sent.append(message)
    hub._owner_locks.clear()
    unregister = hub.register("board-1", owner_id, send)
    try:
        assert await hub.push_snapshot("board-1") and await hub.push_snapshot("board-1")
        assert len(fetches) == 1 and sent[0]["snapshot"]["weather"]["temp"] == 7 and sent[1]["snapshot"]["weather"]["temp"] == 7
        fetches.set(httpx.ConnectError("down"))
        async with db.SessionLocal() as s:
            (await s.get(CompanionWeather, owner_id)).attempted_at = NOW - timedelta(days=1)
            await s.commit()
        assert await hub.push_snapshot("board-1")  # the failed refresh never blocks the push
        assert sent[2]["snapshot"]["weather"]["temp"] == 7
    finally:
        unregister()
