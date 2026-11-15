from __future__ import annotations

from datetime import date

import pytest
from app.focus.config import (
    FocusApp,
    FocusConfig,
    FocusState,
    apply_edit,
    promote,
    tighten,
)
from pydantic import ValidationError
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


@pytest.mark.asyncio
async def test_api_put_then_get_round_trips(automation_client):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    first = {"id": "yt", "label": "YouTube", "packages": ["com.google.android.youtube"], "limit_minutes": 30}
    body = {"config": {"apps": [first]}, "day": "2026-11-15"}
    put = await client.put("/api/v1/focus/config", json=body, headers=headers)
    assert put.status_code == 200
    assert put.json() == {"effective": {"apps": [first]}, "pending": None, "effective_from": None}

    loosen = {"config": {"apps": [{**first, "limit_minutes": 60}]}, "day": "2026-11-15"}
    state = (await client.put("/api/v1/focus/config", json=loosen, headers=headers)).json()
    assert state["effective"]["apps"][0]["limit_minutes"] == 30
    assert state["effective_from"] == TOMORROW

    today = await client.get("/api/v1/focus/config", params={"day": "2026-11-15"}, headers=headers)
    assert today.json() == state
    tomorrow = await client.get("/api/v1/focus/config", params={"day": TOMORROW}, headers=headers)
    assert tomorrow.json()["effective"]["apps"][0]["limit_minutes"] == 60
    assert tomorrow.json()["pending"] is None


@pytest.mark.asyncio
async def test_api_rejects_bad_package_name_and_limit_out_of_range(automation_client):  # noqa: F811
    client, _ = automation_client
    headers = await _owner(client)
    app = {"id": "yt", "label": "YouTube", "packages": ["com.google.android.youtube"], "limit_minutes": 30}
    for bad in ({"packages": ["bad name"]}, {"limit_minutes": 0}, {"limit_minutes": 1441}):
        response = await client.put("/api/v1/focus/config", json={"config": {"apps": [{**app, **bad}]}, "day": "2026-11-15"}, headers=headers)
        assert response.status_code == 422
