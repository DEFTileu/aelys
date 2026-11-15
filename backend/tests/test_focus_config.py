from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest
from app.core.models import User
from app.focus import api as focus_api
from app.focus.config import (
    FocusApp,
    FocusConfig,
    FocusLimitError,
    FocusState,
    apply_edit,
    promote,
    tighten,
)
from pydantic import ValidationError
from sqlalchemy import select
from test_automation_api import _owner, automation_client  # noqa: F401

TODAY = date(2026, 11, 15)
TOMORROW = "2026-11-16"


def _app(id: str = "yt", limit: int = 30, packages: tuple[str, ...] = ("com.google.android.youtube",)) -> FocusApp:
    return FocusApp(id=id, label=id.upper(), packages=list(packages), limit_minutes=limit)


def _cfg(*apps: FocusApp) -> FocusConfig:
    return FocusConfig(apps=list(apps))


def test_tighten_takes_lowest_limit_and_union_of_packages():
    effective = _cfg(_app(limit=30, packages=("com.a",)))
    desired = _cfg(_app(limit=20, packages=("com.b",)))
    (app,) = tighten(effective, desired).apps
    assert app.limit_minutes == 20
    assert sorted(app.packages) == ["com.a", "com.b"]


def test_lowering_a_limit_and_adding_an_app_apply_now():
    state = FocusState(effective=_cfg(_app("yt", 30)))
    out = apply_edit(state, _cfg(_app("yt", 10), _app("tt", 15, ("com.tt",))), TODAY)
    assert {a.id: a.limit_minutes for a in out.effective.apps} == {"yt": 10, "tt": 15}
    assert out.pending is None and out.effective_from is None


def test_raising_a_limit_removing_an_app_or_package_is_pending_until_tomorrow():
    effective = _cfg(_app("yt", 30, ("com.a", "com.b")), _app("tt", 15, ("com.tt",)))
    for desired in (
        _cfg(_app("yt", 60, ("com.a", "com.b")), _app("tt", 15, ("com.tt",))),
        _cfg(_app("yt", 30, ("com.a", "com.b"))),
        _cfg(_app("yt", 30, ("com.a",)), _app("tt", 15, ("com.tt",))),
    ):
        out = apply_edit(FocusState(effective=effective), desired, TODAY)
        assert out.effective == effective
        assert out.pending == desired
        assert out.effective_from == TOMORROW


def test_edit_is_compared_with_effective_not_with_pending():
    state = apply_edit(FocusState(effective=_cfg(_app("yt", 30))), _cfg(_app("yt", 60)), TODAY)
    out = apply_edit(state, _cfg(_app("yt", 45)), TODAY)
    assert out.effective.apps[0].limit_minutes == 30
    assert out.pending.apps[0].limit_minutes == 45


def test_cancelling_a_loosening_clears_pending():
    effective = _cfg(_app("yt", 30))
    state = apply_edit(FocusState(effective=effective), _cfg(_app("yt", 60)), TODAY)
    out = apply_edit(state, effective, TODAY)
    assert out.pending is None and out.effective_from is None


def test_promote_applies_pending_on_or_after_effective_from():
    state = apply_edit(FocusState(effective=_cfg(_app("yt", 30))), _cfg(_app("yt", 60)), TODAY)
    assert promote(state, TODAY) == state
    for day in (date(2026, 11, 16), date(2026, 11, 20)):
        out = promote(state, day)
        assert out.effective.apps[0].limit_minutes == 60
        assert out.pending is None and out.effective_from is None


def test_same_apps_in_another_order_is_not_a_change():
    effective = _cfg(_app("a", 30, ("com.a", "com.b")), _app("b", 20, ("com.c",)))
    reordered = _cfg(_app("b", 20, ("com.c",)), _app("a", 30, ("com.b", "com.a")))
    assert apply_edit(FocusState(effective=effective), reordered, TODAY).pending is None


@pytest.mark.parametrize("bad", [{"packages": ["Not A Package"]}, {"packages": ["nodot"]}, {"limit_minutes": 0}, {"limit_minutes": 1441}, {"id": "Bad Id"}])
def test_models_reject_bad_values(bad):
    base = {"id": "yt", "label": "YT", "packages": ["com.a"], "limit_minutes": 30}
    with pytest.raises(ValidationError):
        FocusApp(**{**base, **bad})


def test_mixed_tighten_and_loosen_applies_the_tightening_and_defers_the_rest():
    effective = _cfg(_app("yt", 30), _app("tt", 15, ("com.tt",)))
    desired = _cfg(_app("yt", 10))
    out = apply_edit(FocusState(effective=effective), desired, TODAY)
    assert {a.id: a.limit_minutes for a in out.effective.apps} == {"tt": 15, "yt": 10}
    assert out.pending == desired and out.effective_from == TOMORROW


def test_label_only_edit_applies_now_without_pending():
    state = FocusState(effective=_cfg(_app("yt", 30)))
    out = apply_edit(state, _cfg(_app("yt", 30).model_copy(update={"label": "Renamed"})), TODAY)
    assert out.effective.apps[0].label == "Renamed"
    assert out.pending is None and out.effective_from is None


def test_tighten_overflow_raises_instead_of_clamping():
    ten = _app("yt", 30, tuple(f"com.a{i}" for i in range(10)))
    other = _app("yt", 30, tuple(f"com.b{i}" for i in range(10)))
    with pytest.raises(FocusLimitError):
        tighten(_cfg(ten), _cfg(other))
    full = _cfg(*(_app(f"a{i}", 30, (f"com.a{i}",)) for i in range(30)))
    swapped = _cfg(*(_app(f"a{i}", 30, (f"com.a{i}",)) for i in range(1, 30)), _app("new", 30, ("com.new",)))
    with pytest.raises(FocusLimitError):
        tighten(full, swapped)


def _json_app(id: str = "yt", limit: int = 30, packages: list[str] | None = None) -> dict:
    return {"id": id, "label": id, "packages": packages or [f"com.{id}"], "limit_minutes": limit}


def _day(offset: int = 0) -> str:
    return (datetime.now(UTC).date() + timedelta(days=offset)).isoformat()


async def _put(client, headers, apps, day=None):
    return await client.put("/api/v1/focus/config", json={"config": {"apps": apps}, "day": day or _day()}, headers=headers)


@pytest.mark.asyncio
async def test_api_put_then_get_round_trips(automation_client):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    first = _json_app("yt", 30, ["com.google.android.youtube"])
    put = await _put(client, headers, [first])
    assert put.status_code == 200
    assert put.json() == {"effective": {"apps": [first]}, "pending": None, "effective_from": None}

    state = (await _put(client, headers, [{**first, "limit_minutes": 60}])).json()
    assert state["effective"]["apps"][0]["limit_minutes"] == 30
    assert state["effective_from"] == _day(1)

    today = await client.get("/api/v1/focus/config", params={"day": _day()}, headers=headers)
    assert today.json() == state
    tomorrow = await client.get("/api/v1/focus/config", params={"day": _day(1)}, headers=headers)
    assert tomorrow.json()["effective"]["apps"][0]["limit_minutes"] == 60
    assert tomorrow.json()["pending"] is None


@pytest.mark.asyncio
async def test_api_rejects_invalid_bodies(automation_client):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    ok = _json_app("yt", 30, ["com.google.android.youtube"])
    bad_apps = [
        [{**ok, "packages": ["bad name"]}],
        [{**ok, "limit_minutes": 0}],
        [{**ok, "limit_minutes": 1441}],
        [{**ok, "packages": []}],
        [{**ok, "packages": [f"com.p{i}" for i in range(11)]}],
        [{**ok, "extra": 1}],
        [ok, ok],
        [_json_app(f"a{i}") for i in range(31)],
    ]
    for apps in bad_apps:
        assert (await _put(client, headers, apps)).status_code == 422, apps
    extra_top = await client.put("/api/v1/focus/config", json={"config": {"apps": [ok]}, "day": _day(), "x": 1}, headers=headers)
    assert extra_top.status_code == 422


@pytest.mark.asyncio
async def test_api_tighten_overflow_is_422_and_stored_state_still_loads(automation_client):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    ten = _json_app("yt", 30, [f"com.a{i}" for i in range(10)])
    assert (await _put(client, headers, [ten])).status_code == 200
    overflow = await _put(client, headers, [{**ten, "packages": [f"com.b{i}" for i in range(10)]}])
    assert overflow.status_code == 422
    assert overflow.json()["detail"]["code"] == "FOCUS_LIMIT"
    got = await client.get("/api/v1/focus/config", params={"day": _day()}, headers=headers)
    assert got.status_code == 200 and got.json()["effective"]["apps"] == [ten]


@pytest.mark.asyncio
async def test_api_swapping_an_app_at_30_is_422_and_stored_state_still_loads(automation_client):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    thirty = [_json_app(f"a{i}") for i in range(30)]
    assert (await _put(client, headers, thirty)).status_code == 200
    swapped = await _put(client, headers, [*thirty[1:], _json_app("new")])
    assert swapped.status_code == 422 and swapped.json()["detail"]["code"] == "FOCUS_LIMIT"
    got = await client.get("/api/v1/focus/config", params={"day": _day()}, headers=headers)
    assert got.status_code == 200 and len(got.json()["effective"]["apps"]) == 30


@pytest.mark.asyncio
async def test_api_label_only_edit_applies_now(automation_client):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    await _put(client, headers, [_json_app("yt")])
    state = (await _put(client, headers, [{**_json_app("yt"), "label": "Renamed"}])).json()
    assert state["effective"]["apps"][0]["label"] == "Renamed"
    assert state["pending"] is None


@pytest.mark.asyncio
async def test_api_rejects_a_day_far_from_the_server_date(automation_client):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    for offset in (-2, 2, 30):
        assert (await _put(client, headers, [_json_app()], day=_day(offset))).status_code == 422
        got = await client.get("/api/v1/focus/config", params={"day": _day(offset)}, headers=headers)
        assert got.status_code == 422
    for offset in (-1, 1):
        got = await client.get("/api/v1/focus/config", params={"day": _day(offset)}, headers=headers)
        assert got.status_code == 200


@pytest.mark.asyncio
async def test_api_get_writes_only_when_promotion_changes_state(automation_client, monkeypatch):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    await _put(client, headers, [_json_app("yt", 30)])
    await _put(client, headers, [_json_app("yt", 60)])  # pending until tomorrow
    saves = []
    original = focus_api._save
    async def spy(db, user, state):
        saves.append(state)
        return await original(db, user, state)
    monkeypatch.setattr(focus_api, "_save", spy)

    await client.get("/api/v1/focus/config", params={"day": _day()}, headers=headers)
    assert saves == []
    promoted = await client.get("/api/v1/focus/config", params={"day": _day(1)}, headers=headers)
    assert len(saves) == 1 and promoted.json()["effective"]["apps"][0]["limit_minutes"] == 60
    await client.get("/api/v1/focus/config", params={"day": _day(1)}, headers=headers)
    assert len(saves) == 1


@pytest.mark.asyncio
async def test_api_corrupt_stored_state_reads_as_empty(automation_client):  # noqa: F811
    client, factory = automation_client
    headers = await _owner(client)
    async with factory() as db:
        user = (await db.execute(select(User))).scalar_one()
        user.settings_json = {**(user.settings_json or {}), "focus": {"effective": {"apps": [{"id": "x"}]}}}
        await db.commit()
    got = await client.get("/api/v1/focus/config", params={"day": _day()}, headers=headers)
    assert got.status_code == 200 and got.json()["effective"] == {"apps": []}
    assert (await _put(client, headers, [_json_app()])).status_code == 200
