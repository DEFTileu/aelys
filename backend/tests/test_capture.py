"""Shared capture is owner-scoped, flush-only, and always revisions notes."""
import pytest
from app.ai.api import _tool_registry
from app.ai.models import PermissionContext, ToolCall
from app.core.models import Note, NoteRevision, Project, Task, User
from app.domains import capture
from fastapi import HTTPException
from sqlalchemy import select

pytest_plugins = ("test_telegram_business",)


async def test_capture_rolls_back_and_rejects_foreign_parents(setup):
    _client, sessions, _ = setup
    async with sessions() as db:
        owner = (await db.execute(select(User))).scalar_one()
        db.add(User(id='other'))
        db.add_all([Project(id='foreign', owner_id='other', name='private'),
                    Task(id='parent', owner_id='other', title='private'),
                    Note(id='note-parent', owner_id='other', title='private')])
        await db.commit()
        for make, fields in [(capture.create_task, {'project_id': 'foreign'}),
                             (capture.create_task, {'parent_task_id': 'parent'}),
                             (capture.create_note, {'parent_id': 'note-parent'})]:
            with pytest.raises(HTTPException) as exc:
                await make(db, owner.id, title='test', **fields)
            assert exc.value.status_code == 404
        note = await capture.create_note(db, owner.id, title='note', markdown_body='body')
        assert (await db.execute(select(NoteRevision).where(NoteRevision.note_id == note.id))).scalar_one().revision_no == 1
        note_id = note.id
        await db.rollback()
        assert await db.get(Note, note_id) is None


async def test_ai_note_has_initial_revision(setup):
    _, sessions, _ = setup
    async with sessions() as db:
        owner = (await db.execute(select(User))).scalar_one()
        registry = _tool_registry(db, owner.id, 'test-event')
        result = await registry.invoke(ToolCall('create_note', {'title': 'AI note', 'markdown_body': 'hello'}),
                                        PermissionContext(actor='test', scopes=frozenset({'notes.write'})))
        revision = (await db.execute(select(NoteRevision).where(NoteRevision.note_id == result['id']))).scalar_one()
        assert (revision.base_version, revision.revision_no, revision.body) == (0, 1, 'hello')
