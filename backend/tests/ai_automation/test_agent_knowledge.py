from __future__ import annotations

from datetime import UTC, datetime

import pytest
from app.ai.agent_knowledge import current, retrieve
from app.ai.errors import PolicyDenied
from app.ai.policy import ServerPolicyEngine
from app.core.models import Note, User
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["Tell me about Aelys", "Что такое аелис?", "Расскажи про ЭЛИС"])
async def test_builtin_aelys_facts_match_name_aliases(ai_test_engine, query):
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    async with factory() as db:
        user = User(email="agent-knowledge@example.test", password_hash="unused")
        db.add(user)
        await db.flush()

        result = await retrieve(db, user.id, query)

    builtin = next(source for source in result if source["id"] == "builtin:aelys")
    assert builtin["version"] == 1
    assert len(builtin["excerpt"]) <= 1600
    assert "Tauri 2" in builtin["excerpt"] and "Rust" in builtin["excerpt"]
    assert "Aelys is the owner's personal" in builtin["excerpt"]
    assert "acceptance" in builtin["excerpt"].lower()
    assert "/Users/" not in builtin["excerpt"]
    assert "line " not in builtin["excerpt"].lower()


@pytest.mark.asyncio
async def test_notes_require_exact_tag_and_knowledge_consent(ai_test_engine):
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    async with factory() as db:
        owner = User(email="agent-knowledge-optin@example.test", password_hash="unused")
        db.add(owner)
        await db.flush()
        notes = [
            Note(owner_id=owner.id, title="Flag only", markdown_body="Shareable profile fact", knowledge_enabled=True, tags=[]),
            Note(owner_id=owner.id, title="Tag only", markdown_body="Shareable profile fact", knowledge_enabled=False, tags=["agent-context"]),
            Note(owner_id=owner.id, title="Near tag", markdown_body="Shareable profile fact", knowledge_enabled=True, tags=["prefix-agent-context"]),
            Note(owner_id=owner.id, title="Eligible", markdown_body="Shareable profile fact", knowledge_enabled=True, tags=["agent-context", "other"]),
        ]
        db.add_all(notes)
        await db.flush()

        result = await retrieve(db, owner.id, "shareable profile fact")

    assert [source["id"] for source in result] == [notes[-1].id]
    assert result[0]["version"] == 1


@pytest.mark.asyncio
async def test_retrieval_is_owner_scoped_and_current_references_revoke(ai_test_engine):
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    async with factory() as db:
        owner = User(email="agent-knowledge-owner@example.test", password_hash="unused")
        other = User(email="agent-knowledge-other@example.test", password_hash="unused")
        db.add_all([owner, other])
        await db.flush()
        note = Note(owner_id=owner.id, title="Profile", markdown_body="Owner project fact", knowledge_enabled=True, tags=["agent-context"])
        foreign = Note(owner_id=other.id, title="Foreign", markdown_body="Owner project fact", knowledge_enabled=True, tags=["agent-context"])
        db.add_all([note, foreign])
        await db.flush()
        ref = {"id": note.id, "version": note.version}

        assert await retrieve(db, owner.id, "owner project fact") == [
            {"id": note.id, "version": 1, "title": "Profile", "excerpt": "Owner project fact"}
        ]
        assert await retrieve(db, owner.id, "How does Rust work?") == []
        assert await current(db, owner.id, [ref])
        assert not await current(db, owner.id, [{"id": foreign.id, "version": 1}])
        assert not await current(db, owner.id, [ref, {"id": foreign.id, "version": 1}])

        note.version = 2
        await db.flush()
        assert not await current(db, owner.id, [ref])
        note.version = 1
        note.knowledge_enabled = False
        await db.flush()
        assert not await current(db, owner.id, [ref])
        note.knowledge_enabled = True
        note.tags = ["Agent-context"]
        await db.flush()
        assert not await current(db, owner.id, [ref])
        note.tags = ["agent-context"]
        note.deleted_at = datetime.now(UTC)
        await db.flush()
        assert not await current(db, owner.id, [ref])
        assert await current(db, owner.id, [{"id": "builtin:aelys", "version": 1}])
        assert not await current(db, owner.id, [{"id": "builtin:aelys", "version": 2}])


@pytest.mark.asyncio
async def test_results_and_candidate_scan_are_bounded(ai_test_engine):
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    async with factory() as db:
        owner = User(email="agent-knowledge-bounds@example.test", password_hash="unused")
        db.add(owner)
        await db.flush()
        db.add_all([
            Note(owner_id=owner.id, title=f"Fact {index}", markdown_body="Public project fact " + ("x" * 2000), knowledge_enabled=True, tags=["agent-context"])
            for index in range(8)
        ])
        await db.flush()
        result = await retrieve(db, owner.id, "public project fact")
        assert len(result) == 6
        assert all(len(source["excerpt"]) <= 1600 for source in result)
        assert sum(len(source["excerpt"]) for source in result) <= 9600

        db.add_all([
            Note(owner_id=owner.id, title=f"Overflow {index}", markdown_body="unrelated", knowledge_enabled=True, tags=["agent-context"])
            for index in range(101)
        ])
        await db.flush()
        with pytest.raises(HTTPException) as error:
            await retrieve(db, owner.id, "public project fact")
        assert error.value.status_code == 422
        assert error.value.detail["code"] == "KNOWLEDGE_CANDIDATE_LIMIT"


@pytest.mark.asyncio
async def test_builtin_and_note_refs_are_validated_together(ai_test_engine):
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)
    async with factory() as db:
        owner = User(email="agent-knowledge-refs@example.test", password_hash="unused")
        db.add(owner)
        await db.flush()
        note = Note(owner_id=owner.id, title="Fact", markdown_body="Project context", knowledge_enabled=True, tags=["agent-context"])
        db.add(note)
        await db.flush()
        assert await current(db, owner.id, [
            {"id": "builtin:aelys", "version": 1},
            {"id": note.id, "version": 1},
        ])
        note.tags = []
        await db.flush()
        assert not await current(db, owner.id, [
            {"id": "builtin:aelys", "version": 1},
            {"id": note.id, "version": 1},
        ])


@pytest.mark.asyncio
async def test_policy_engine_authorizes_read(ai_test_engine, monkeypatch):
    factory = async_sessionmaker(ai_test_engine, expire_on_commit=False)

    def deny(self, tool, call, context):
        raise PolicyDenied("knowledge read denied")

    monkeypatch.setattr(ServerPolicyEngine, "authorize", deny)
    async with factory() as db:
        with pytest.raises(PolicyDenied, match="knowledge read denied"):
            await retrieve(db, "owner-id", "Aelys")
