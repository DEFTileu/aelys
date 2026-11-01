from __future__ import annotations

from decimal import Decimal

import pytest
from test_connected_workspaces import client  # noqa: F401 - shared fixture


@pytest.mark.asyncio
async def test_note_pinned_defaults_false_toggles_with_version_and_survives_legacy_patch(client):  # noqa: F811
    note = (await client.post("/api/v1/notes", json={"title": "N", "markdown_body": "b"})).json()
    assert note["pinned"] is False
    url = f"/api/v1/notes/{note['id']}"
    pinned = (await client.patch(url, params={"version": note["version"]}, json={"title": "N", "markdown_body": "b", "pinned": True})).json()
    assert pinned["pinned"] is True and pinned["version"] == note["version"] + 1
    stale = await client.patch(url, params={"version": note["version"]}, json={"title": "N", "markdown_body": "b", "pinned": False})
    assert stale.status_code == 409
    legacy = (await client.patch(url, params={"version": pinned["version"]}, json={"title": "Renamed", "markdown_body": "b"})).json()
    assert legacy["title"] == "Renamed" and legacy["pinned"] is True  # older clients omit the flag
    unpinned = (await client.patch(url, params={"version": legacy["version"]}, json={"title": "Renamed", "markdown_body": "b", "pinned": False})).json()
    assert unpinned["pinned"] is False
    assert [n["pinned"] for n in (await client.get("/api/v1/notes")).json()] == [False]


@pytest.mark.asyncio
async def test_mail_is_read_defaults_false_and_patch_is_idempotent_and_version_checked(client):  # noqa: F811
    body = {"sender": "a@example.com", "subject": "Hi", "received_at": "2026-10-30T10:00:00Z"}
    message = (await client.post("/api/v1/mail/messages", json=body)).json()
    assert message["is_read"] is False
    url = f"/api/v1/mail/messages/{message['id']}"
    assert (await client.patch(url, json={"is_read": True, "version": message["version"] + 3})).status_code == 409
    read = (await client.patch(url, json={"is_read": True, "version": message["version"]})).json()
    assert read["is_read"] is True and read["version"] == message["version"] + 1
    assert (await client.patch(url, json={"is_read": True})).json()["version"] == read["version"]
    assert (await client.patch(url, json={"is_read": False})).json()["is_read"] is False
    assert (await client.patch(url, json={"is_read": "maybe"})).status_code == 422
    assert (await client.patch("/api/v1/mail/messages/missing", json={"is_read": True})).status_code == 404
    assert (await client.get("/api/v1/mail/messages")).json()[0]["is_read"] is False


@pytest.mark.asyncio
async def test_monthly_budgets_upsert_by_category_currency_month_with_exact_decimals(client):  # noqa: F811
    food = (await client.post("/api/v1/finance/categories", json={"name": "Food"})).json()
    put = lambda **kw: client.put("/api/v1/finance/budgets", json={"category_id": food["id"], "currency": "usd", "month": "2026-10", "limit_amount": "100.10", **kw})
    first = (await put()).json()
    assert isinstance(first["limit_amount"], str) and Decimal(first["limit_amount"]) == Decimal("100.10")
    assert first["currency"] == "USD" and first["period_start"].startswith("2026-10-01") and first["period_end"].startswith("2026-11-01")
    second = (await put(limit_amount="250.25")).json()
    assert second["id"] == first["id"] and second["version"] == first["version"] + 1 and second["limit_amount"].startswith("250.25")
    december = (await put(month="2026-12")).json()
    assert december["id"] != first["id"] and december["period_end"].startswith("2027-01-01")
    overall = (await client.put("/api/v1/finance/budgets", json={"category_id": None, "currency": "USD", "month": "2026-10", "limit_amount": "900"})).json()
    assert overall["category_id"] is None and overall["id"] != first["id"]
    assert len((await client.get("/api/v1/finance/budgets")).json()) == 3
    october = (await client.get("/api/v1/finance/budgets", params={"month": "2026-10", "currency": "usd"})).json()
    assert {b["id"] for b in october} == {first["id"], overall["id"]}
    for bad in ({"limit_amount": 10.5}, {"month": "2026-13"}, {"limit_amount": "-1"}, {"category_id": "missing"}):
        assert (await put(**bad)).status_code in {404, 422}, bad
    assert (await put(limit_amount=10.5)).status_code == 422


@pytest.mark.asyncio
async def test_transaction_list_carries_category_name(client):  # noqa: F811
    account = (await client.post("/api/v1/finance/accounts", json={"name": "Cash", "currency": "USD"})).json()
    category = (await client.post("/api/v1/finance/categories", json={"name": "Coffee"})).json()
    base = {"account_id": account["id"], "amount": "-3.50", "currency": "USD", "type": "expense", "occurred_at": "2026-10-30T08:00:00Z"}
    await client.post("/api/v1/finance/transactions", json={**base, "category_id": category["id"], "idempotency_key": "k1"})
    await client.post("/api/v1/finance/transactions", json={**base, "idempotency_key": "k2"})
    names = {t["idempotency_key"]: t["category_name"] for t in (await client.get("/api/v1/finance/transactions")).json()}
    assert names == {"k1": "Coffee", "k2": None}
