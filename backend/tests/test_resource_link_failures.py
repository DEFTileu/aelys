"""Classify duplicate links without masking storage outages as user mistakes."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from app.domains import api
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError, OperationalError


@pytest.mark.asyncio
@pytest.mark.parametrize("duplicate", [True, False])
async def test_link_storage_failures_are_classified(monkeypatch, duplicate):
    failure = (
        IntegrityError("insert", {}, Exception("duplicate"))
        if duplicate
        else OperationalError("insert", {}, Exception("unavailable"))
    )
    database = SimpleNamespace(
        add=Mock(), commit=AsyncMock(side_effect=failure), rollback=AsyncMock()
    )
    monkeypatch.setattr(
        api,
        "owner_obj",
        AsyncMock(
            side_effect=[SimpleNamespace(id="left"), SimpleNamespace(id="right")]
        ),
    )
    payload = api.ResourceLinkIn(
        from_resource_id="left", to_resource_id="right", relation_type="references"
    )
    if duplicate:
        with pytest.raises(HTTPException) as caught:
            await api.link_resources(
                payload, principal=(SimpleNamespace(id="owner"), None), db=database
            )
        assert caught.value.status_code == 409
        assert caught.value.detail["code"] == "DUPLICATE"
        database.rollback.assert_awaited_once()
    else:
        with pytest.raises(OperationalError):
            await api.link_resources(
                payload, principal=(SimpleNamespace(id="owner"), None), db=database
            )
