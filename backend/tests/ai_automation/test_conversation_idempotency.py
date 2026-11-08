"""Owner-scoped conversation receipts with real independent database sessions.

Phase 4 / task 2. Optional keys preserve legacy creates. Fingerprints describe
validated input including defaults, not mutable conversation fields. No receipt
expiry is introduced; product decisions marked OPEN are unchanged.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from app.core import db
from app.core.models import AIConversation, AuthSession, Note, Project, User, now
from app.core.security import create_token
from app.main import app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import Select, select
from sqlalchemy.engine import Result
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.sql import Executable

PATH = "/api/v1/ai/conversations"
KEY = {"Idempotency-Key": "conversation-create-1"}

@pytest.mark.asyncio
async def test_capability_requires_authenticated_owner(client):
    response = await client.get('/api/v1/ai/capabilities')
    assert response.status_code == 200
    assert response.json() == {"conversation_create_idempotency": True}


@pytest.fixture
async def client(
    ai_test_engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[AsyncClient]:
    monkeypatch.setattr(
        db, "SessionLocal", async_sessionmaker(ai_test_engine, expire_on_commit=False)
    )
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        boot = await client.post(
            "/api/v1/auth/bootstrap",
            json={
                "email": "conversation@example.test",
                "password": "correct horse battery staple",
            },
        )
        assert boot.status_code == 200, boot.text
        client.headers["Authorization"] = f"Bearer {boot.json()['access_token']}"
        yield client


async def rows() -> list[AIConversation]:
    async with db.SessionLocal() as session:
        return list(await session.scalars(select(AIConversation)))


async def test_optional_keys_defaults_and_response_contract(
    client: AsyncClient,
) -> None:
    first = await client.post(PATH, headers=KEY, json={})
    retry = await client.post(
        PATH,
        headers={"idempotency-key": KEY["Idempotency-Key"]},
        json={
            "title": "Conversation",
            "project_id": None,
            "knowledge": None,
            "tool_scope": {},
        },
    )
    assert first.status_code == retry.status_code == 200
    assert first.json() == retry.json()
    assert set(first.json()) == {
        "id",
        "owner_id",
        "project_id",
        "title",
        "tool_scope_json",
        "pinned",
        "version",
        "created_at",
        "updated_at",
        "deleted_at",
    }
    unkeyed = [await client.post(PATH, json={}) for _ in range(2)]
    other_key = await client.post(
        PATH, headers={"Idempotency-Key": "another-key"}, json={}
    )
    responses = [first, *unkeyed, other_key]
    assert all(response.status_code == 200 for response in responses)
    assert len({response.json()["id"] for response in responses}) == 4
    listing = await client.get(PATH)
    assert listing.status_code == 200
    assert all(set(item) == set(first.json()) | {"preview", "usage"} for item in listing.json())
    stored = await rows()
    keyed = next(item for item in stored if item.id == first.json()["id"])
    assert keyed.idempotency_key == KEY["Idempotency-Key"]
    assert (
        keyed.request_fingerprint is not None and len(keyed.request_fingerprint) == 64
    )
    assert all(
        item.request_fingerprint is None
        for item in stored
        if item.idempotency_key is None
    )


@pytest.mark.parametrize(
    "changed",
    [
        {"title": "Different"},
        {"project_id": "different-project"},
        {"tool_scope": {"scopes": ["tasks.write"]}},
        {"tool_scope": {"ignored_field": True}},
        {"knowledge": {"note_ids": ["different-note"]}},
    ],
)
async def test_different_original_request_conflicts(
    client: AsyncClient, changed: dict[str, Any]
) -> None:
    assert (await client.post(PATH, headers=KEY, json={})).status_code == 200
    conflict = await client.post(PATH, headers=KEY, json=changed)
    assert conflict.status_code == 409, conflict.text
    assert conflict.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert len(await rows()) == 1


async def test_fingerprint_survives_conversation_mutation(client: AsyncClient) -> None:
    payload = {
        "title": "Original",
        "tool_scope": {"scopes": ["tasks.write"], "options": {"b": 2, "a": 1}},
    }
    created = await client.post(PATH, headers=KEY, json=payload)
    assert created.status_code == 200
    async with db.SessionLocal() as session:
        item = await session.get(AIConversation, created.json()["id"])
        assert item is not None
        original_fingerprint = item.request_fingerprint
        item.title = "Renamed"
        item.tool_scope_json = {"scopes": []}
        await session.commit()
    reordered = {
        **payload,
        "tool_scope": {"options": {"a": 1, "b": 2}, "scopes": ["tasks.write"]},
    }
    retry = await client.post(PATH, headers=KEY, json=reordered)
    assert retry.status_code == 200
    assert retry.json()["id"] == created.json()["id"]
    assert retry.json()["title"] == "Renamed"
    changed = await client.post(PATH, headers=KEY, json={"title": "Renamed"})
    assert changed.status_code == 409
    assert (await rows())[0].request_fingerprint == original_fingerprint


async def test_same_key_isolated_by_owner(client: AsyncClient) -> None:
    original = await client.post(PATH, headers=KEY, json={})
    async with db.SessionLocal() as session:
        user = User(email="other-conversation@example.test")
        session.add(user)
        await session.flush()
        auth = AuthSession(
            owner_id=user.id,
            refresh_token_hash="other-conversation-session",
            expires_at=now(),
        )
        session.add(auth)
        await session.commit()
        token = create_token(user.id, "access", 900, session_id=auth.id)
        owner_id = user.id
    headers = {**KEY, "Authorization": f"Bearer {token}"}
    other = await client.post(PATH, headers=headers, json={"title": "Other owner"})
    retry = await client.post(PATH, headers=headers, json={"title": "Other owner"})
    assert original.status_code == other.status_code == retry.status_code == 200
    assert other.json() == retry.json()
    assert other.json()["owner_id"] == owner_id
    assert other.json()["id"] != original.json()["id"]
    assert len(await rows()) == 2


async def test_deleted_key_remains_reserved(client: AsyncClient) -> None:
    created = await client.post(PATH, headers=KEY, json={})
    async with db.SessionLocal() as session:
        item = await session.get(AIConversation, created.json()["id"])
        assert item is not None
        item.deleted_at = now()
        await session.commit()
    retry = await client.post(PATH, headers=KEY, json={})
    assert retry.status_code == 409
    assert retry.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert len(await rows()) == 1


async def test_key_shared_across_owner_devices_still_requires_auth(
    client: AsyncClient,
) -> None:
    created = await client.post(PATH, headers=KEY, json={})
    assert created.status_code == 200
    device = await client.post(
        "/api/v1/devices/enroll",
        json={"platform": "web", "display_name": "Other device"},
    )
    assert device.status_code == 200
    headers = {**KEY, "Authorization": f"Bearer {device.json()['access_token']}"}
    retry = await client.post(PATH, headers=headers, json={})
    assert retry.status_code == 200 and retry.json() == created.json()
    revoked = await client.post(f"/api/v1/devices/{device.json()['device_id']}/revoke")
    assert revoked.status_code == 200
    rejected = await client.post(PATH, headers=headers, json={})
    assert rejected.status_code == 401
    assert len(await rows()) == 1


def test_openapi_declares_optional_key_and_conflict() -> None:
    operation = app.openapi()["paths"][PATH]["post"]
    header = next(
        parameter
        for parameter in operation["parameters"]
        if parameter["name"] == "Idempotency-Key"
    )
    assert header["in"] == "header" and not header["required"]
    assert "409" in operation["responses"]


@pytest.mark.parametrize("key", ["", "   ", "x" * 151])
async def test_invalid_key_does_not_write(client: AsyncClient, key: str) -> None:
    response = await client.post(PATH, headers={"Idempotency-Key": key}, json={})
    assert response.status_code == 422
    assert await rows() == []


@pytest.mark.parametrize("kind", ["project", "knowledge", "policy"])
async def test_invalid_request_does_not_reserve_key(
    client: AsyncClient, kind: str
) -> None:
    payload = {
        "project": {"project_id": "missing"},
        "knowledge": {"knowledge": {"note_ids": ["missing"]}},
        "policy": {"tool_scope": {"scopes": ["unregistered.write"]}},
    }[kind]
    rejected = await client.post(PATH, headers=KEY, json=payload)
    assert rejected.status_code == (403 if kind == "policy" else 404)
    assert await rows() == []
    assert (await client.post(PATH, headers=KEY, json={})).status_code == 200


async def test_project_and_knowledge_retry_uses_original_receipt(
    client: AsyncClient,
) -> None:
    # Receipt lookup does not re-run creation against sources changed since then.
    owner = (await client.get("/api/v1/me")).json()["id"]
    async with db.SessionLocal() as session:
        project = Project(owner_id=owner, name="Knowledge project")
        session.add(project)
        await session.flush()
        note = Note(
            owner_id=owner,
            project_id=project.id,
            title="Source",
            markdown_body="text",
            knowledge_enabled=True,
        )
        session.add(note)
        await session.commit()
        project_id, note_id = project.id, note.id
    payload = {
        "project_id": project_id,
        "knowledge": {"project_id": project_id, "note_ids": [note_id]},
    }
    created = await client.post(PATH, headers=KEY, json=payload)
    assert created.status_code == 200, created.text
    async with db.SessionLocal() as session:
        note = await session.get(Note, note_id)
        assert note is not None
        note.knowledge_enabled = False
        await session.commit()
    retry = await client.post(PATH, headers=KEY, json=payload)
    assert retry.status_code == 200
    assert retry.json() == created.json()


async def test_unrelated_integrity_failure_is_not_a_key_conflict(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def broken_commit(self: AsyncSession) -> None:
        raise IntegrityError(
            "synthetic unrelated constraint", {}, ValueError("synthetic")
        )

    monkeypatch.setattr(AsyncSession, "commit", broken_commit)
    with pytest.raises(IntegrityError):
        await client.post(PATH, headers=KEY, json={})
    assert await rows() == []


@pytest.mark.parametrize(
    "different_payload", [False, True], ids=["same-payload", "different-payload"]
)
async def test_concurrent_create_uses_database_uniqueness(
    client: AsyncClient,
    ai_test_engine: AsyncEngine,
    monkeypatch: pytest.MonkeyPatch,
    different_payload: bool,
) -> None:
    both_read = asyncio.Event()
    sessions: list[AsyncSession] = []
    connections: list[object] = []

    class RacingSession(AsyncSession):
        async def execute(
            self, statement: Executable, *args: Any, **kwargs: Any
        ) -> Result[Any]:
            result = await super().execute(statement, *args, **kwargs)
            is_lookup = (
                isinstance(statement, Select)
                and any(
                    column.get("entity") is AIConversation
                    for column in statement.column_descriptions
                )
                and "ai_conversations.idempotency_key" in str(statement.whereclause)
            )
            if not is_lookup or self in sessions:
                return result
            frozen = result.freeze()
            assert frozen().scalar_one_or_none() is None
            connection = await self.connection()
            sessions.append(self)
            connections.append(connection.sync_connection.connection.driver_connection)
            if len(sessions) == 2:
                assert sessions[0] is not sessions[1]
                assert connections[0] is not connections[1]
                both_read.set()
            await asyncio.wait_for(both_read.wait(), 5)
            return frozen()

    monkeypatch.setattr(
        db,
        "SessionLocal",
        async_sessionmaker(
            ai_test_engine, class_=RacingSession, expire_on_commit=False
        ),
    )
    payloads = [
        {"title": "First"},
        {"title": "Other" if different_payload else "First"},
    ]
    # Verify persistence even if the regression produces a real HTTP 500.
    async with AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test",
        headers=client.headers,
    ) as racing_client:
        responses = await asyncio.wait_for(
            asyncio.gather(
                *(
                    racing_client.post(PATH, headers=KEY, json=payload)
                    for payload in payloads
                )
            ),
            10,
        )
    assert both_read.is_set()
    assert sorted(response.status_code for response in responses) == (
        [200, 409] if different_payload else [200, 200]
    ), [(response.status_code, response.text) for response in responses]
    async with async_sessionmaker(ai_test_engine, expire_on_commit=False)() as session:
        stored = list(await session.scalars(select(AIConversation)))
    assert len(stored) == 1
    assert stored[0].idempotency_key == KEY["Idempotency-Key"]
    for payload, response in zip(payloads, responses, strict=True):
        if response.status_code == 200:
            assert response.json()["id"] == stored[0].id
            assert stored[0].title == payload["title"]
        else:
            assert response.json()["detail"]["code"] == "IDEMPOTENCY_CONFLICT"
