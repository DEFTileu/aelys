"""Real Alembic upgrade/downgrade, legacy data and database uniqueness checks."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest
from app.core.models import AIConversation, AIMessage, User
from sqlalchemy import inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

HEAD = "0045_ai_conversation_idempotency"
PREVIOUS = "0044_hide_business_service_chats"
INDEX = "ix_ai_conversation_owner_idempotency"


async def migrate(engine: AsyncEngine, *args: str) -> None:
    backend = Path(__file__).resolve().parents[2]
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "alembic",
        *args,
        cwd=backend,
        env={
            **os.environ,
            "AELYS_DATABASE_URL": engine.url.render_as_string(hide_password=False),
            "AELYS_SECRET_KEY": "synthetic-conversation-migration-key-0123456789",
            "PYTHONPATH": str(backend),
        },
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 30)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    detail = output.decode(errors="replace")
    if engine.url.password:
        detail = detail.replace(engine.url.password, "[REDACTED]")
    assert process.returncode == 0, detail


async def test_legacy_upgrade_and_round_trip(ai_test_engine: AsyncEngine) -> None:
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    async with factory() as session:
        user = User(email="legacy-conversation@example.test")
        other = User(email="other-legacy-conversation@example.test")
        session.add_all([user, other])
        await session.flush()
        conversation = AIConversation(
            owner_id=user.id,
            title="Keep legacy",
            version=7,
            tool_scope_json={"scopes": ["tasks.write"]},
        )
        session.add(conversation)
        await session.flush()
        message = AIMessage(
            conversation_id=conversation.id, role="user", content="Keep message"
        )
        session.add(message)
        await session.commit()
        owner_id, other_owner_id = user.id, other.id
        conversation_id, message_id = conversation.id, message.id

    # SQLite fixture starts with create_all; PostgreSQL starts at migrated head.
    await migrate(ai_test_engine, "stamp", HEAD)
    await migrate(ai_test_engine, "downgrade", PREVIOUS)
    async with ai_test_engine.connect() as connection:
        columns = await connection.run_sync(
            lambda sync: {
                column["name"]
                for column in inspect(sync).get_columns("ai_conversations")
            }
        )
        assert "idempotency_key" not in columns and "request_fingerprint" not in columns
        assert (
            await connection.scalar(
                text("SELECT content FROM ai_messages WHERE id=:id"), {"id": message_id}
            )
            == "Keep message"
        )

    await migrate(ai_test_engine, "upgrade", "head")
    await migrate(ai_test_engine, "check")
    async with factory() as session:
        legacy = await session.get(AIConversation, conversation_id)
        assert legacy is not None
        assert (legacy.title, legacy.version, legacy.tool_scope_json) == (
            "Keep legacy",
            7,
            {"scopes": ["tasks.write"]},
        )
        assert legacy.idempotency_key is None and legacy.request_fingerprint is None
        # Nullable keys allow multiple legacy/non-idempotent creates per owner.
        session.add_all(
            [
                AIConversation(owner_id=owner_id, title="Unkeyed"),
                AIConversation(
                    owner_id=owner_id,
                    title="Keyed",
                    idempotency_key="same-key",
                    request_fingerprint="a" * 64,
                ),
                AIConversation(
                    owner_id=other_owner_id,
                    title="Other owner",
                    idempotency_key="same-key",
                    request_fingerprint="b" * 64,
                ),
            ]
        )
        await session.commit()
    async with ai_test_engine.connect() as connection:
        indexes = await connection.run_sync(
            lambda sync: inspect(sync).get_indexes("ai_conversations")
        )
        index = next(index for index in indexes if index["name"] == INDEX)
        assert index["unique"] and index["column_names"] == [
            "owner_id",
            "idempotency_key",
        ]
    async with factory() as session:
        session.add(
            AIConversation(
                owner_id=owner_id,
                title="Duplicate",
                idempotency_key="same-key",
                request_fingerprint="c" * 64,
            )
        )
        with pytest.raises(IntegrityError):
            await session.commit()
        await session.rollback()

    await migrate(ai_test_engine, "downgrade", PREVIOUS)
    await migrate(ai_test_engine, "upgrade", "head")
    await migrate(ai_test_engine, "check")
    async with factory() as session:
        assert len(list(await session.scalars(select(AIConversation)))) == 4
        preserved_message = await session.get(AIMessage, message_id)
        assert (
            preserved_message is not None
            and preserved_message.content == "Keep message"
        )
        legacy = await session.get(AIConversation, conversation_id)
        assert legacy is not None and legacy.version == 7
