"""Bounded, owner-curated facts for contact-facing agent commands."""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.ai.knowledge import chunks, words
from app.ai.models import PermissionContext, ToolCall
from app.ai.policy import ServerPolicyEngine
from app.ai.untrusted import UntrustedData
from app.core.models import Note
from fastapi import HTTPException
from sqlalchemy import String, cast, select
from sqlalchemy.ext.asyncio import AsyncSession

AGENT_CONTEXT_TAG = "agent-context"
MAX_SOURCES = 6
MAX_EXCERPT_CHARS = 1600
MAX_CANDIDATE_NOTES = 100
MAX_CANDIDATE_CHARS = 4_000_000
BUILTIN_ID = "builtin:aelys"
BUILTIN_VERSION = 1
BUILTIN_TITLE = "Aelys project context"
BUILTIN_EXCERPT = (
    "Aelys is the owner's personal, open-source project. Its intended "
    "product is a single-user, offline-first personal system. The web application "
    "uses React and TypeScript; the backend uses Python and FastAPI; the macOS "
    "application uses Tauri 2 and Rust, with PostgreSQL in the server stack. "
    "Aelys is still in progress. This short project description does not establish "
    "that every planned capability has passed acceptance or shipped."
)
_ALIASES = ("aelys", "аелис", "элис")


@dataclass(frozen=True)
class _ReadKnowledge:
    name: str = "retrieve_agent_knowledge"
    required_scope: str = "knowledge.read"
    external_effect: bool = False


def _authorize_read(owner_id: str) -> None:
    ServerPolicyEngine().authorize(
        _ReadKnowledge(),
        ToolCall("retrieve_agent_knowledge", {}),
        PermissionContext(actor=f"owner:{owner_id}", scopes=frozenset({"knowledge.read"})),
    )


def _matches_builtin(query: str) -> bool:
    tokens = set(re.findall(r"[^\W_]+", query.casefold()))
    return bool(tokens.intersection(_ALIASES))


def _eligible_notes_statement(owner_id: str):
    # Matching the quoted JSON string limits candidates in SQL; the Python
    # equality check below enforces exact, case-sensitive tag equality.
    tags_json = cast(Note.tags, String)
    return (
        select(Note)
        .where(
            Note.owner_id == owner_id,
            Note.deleted_at.is_(None),
            Note.knowledge_enabled.is_(True),
            tags_json.contains(f'"{AGENT_CONTEXT_TAG}"'),
        )
        .order_by(Note.id)
        .limit(MAX_CANDIDATE_NOTES + 1)
    )


async def retrieve(db: AsyncSession, owner_id: str, query: str) -> list[dict]:
    """Return at most six relevant, explicitly curated owner facts."""
    _authorize_read(owner_id)
    if not isinstance(query, str) or not query.strip():
        return []

    notes = list((await db.execute(_eligible_notes_statement(owner_id))).scalars())
    if len(notes) > MAX_CANDIDATE_NOTES:
        raise HTTPException(
            status_code=422,
            detail={"code": "KNOWLEDGE_CANDIDATE_LIMIT", "message": "Knowledge candidate set is too large"},
        )
    if sum(len(note.title) + len(note.markdown_body) for note in notes) > MAX_CANDIDATE_CHARS:
        raise HTTPException(
            status_code=422,
            detail={"code": "KNOWLEDGE_CANDIDATE_LIMIT", "message": "Knowledge candidate set is too large"},
        )

    selected: list[tuple[int, str, dict]] = []
    for note in notes:
        if not isinstance(note.tags, list) or AGENT_CONTEXT_TAG not in note.tags:
            continue
        best: tuple[int, int, str] | None = None
        for chunk in chunks(note.markdown_body, size=MAX_EXCERPT_CHARS):
            excerpt = chunk.text[:MAX_EXCERPT_CHARS]
            haystack = f"{note.title} {chunk.heading} {excerpt}".casefold()
            score = sum(1 for token in words(query) if token in haystack)
            if score and (best is None or score > best[0]):
                best = (score, chunk.start, excerpt)
        if best:
            score, start, excerpt = best
            safe_excerpt = UntrustedData(note.id, excerpt).redacted().text[:MAX_EXCERPT_CHARS]
            selected.append((score, note.id, {
                "id": note.id,
                "version": note.version,
                "title": note.title,
                "excerpt": safe_excerpt,
                "_start": start,
            }))

    selected.sort(key=lambda item: (-item[0], item[1], item[2]["_start"]))
    results: list[dict] = []
    if _matches_builtin(query):
        results.append({
            "id": BUILTIN_ID,
            "version": BUILTIN_VERSION,
            "title": BUILTIN_TITLE,
            "excerpt": BUILTIN_EXCERPT[:MAX_EXCERPT_CHARS],
        })
    for _, _, result in selected:
        if len(results) >= MAX_SOURCES:
            break
        result.pop("_start")
        results.append(result)
    return results


async def current(db: AsyncSession, owner_id: str, refs: list[dict]) -> bool:
    """Return whether every provenance reference still names current eligible data."""
    _authorize_read(owner_id)
    if not isinstance(refs, list) or len(refs) > 70:
        return False

    note_refs: dict[str, int] = {}
    for ref in refs:
        if not isinstance(ref, dict):
            return False
        ref_id, version = ref.get("id"), ref.get("version")
        if ref_id == BUILTIN_ID and version == BUILTIN_VERSION and type(version) is int:
            continue
        if not isinstance(ref_id, str) or not ref_id or type(version) is not int or version < 1:
            return False
        if ref_id in note_refs and note_refs[ref_id] != version:
            return False
        note_refs[ref_id] = version

    if not note_refs:
        return True
    notes = list((await db.execute(
        _eligible_notes_statement(owner_id).where(Note.id.in_(note_refs))
    )).scalars())
    current_versions = {
        note.id: note.version
        for note in notes
        if isinstance(note.tags, list) and AGENT_CONTEXT_TAG in note.tags
    }
    return all(current_versions.get(note_id) == version for note_id, version in note_refs.items())
