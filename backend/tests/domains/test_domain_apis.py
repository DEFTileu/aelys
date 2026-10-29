from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from backend.app.domains.common import Base, ConflictError, NotFoundError
from backend.app.domains.finance import AccountCreate, TransactionCreate, create_account, create_transaction
from backend.app.domains.mail import MailAccountCreate, MessageImport, create_account as create_mail_account, import_message
from backend.app.domains.productivity import Note, NoteCreate, NoteRevision, TaskCreate, create_note, create_task
from backend.app.domains.projects import ProjectCreate, ProjectPatch, ProjectService, ResourceCreate
from backend.app.domains.sync import InMemorySyncStore, SyncAction, SyncOperation
from backend.app.domains.productivity import EventCreate, ReminderCreate, create_event, create_reminder
from backend.app.domains.ai import ConversationCreate, ProviderCreate, RunCreate, create_conversation, create_provider, create_run


@pytest.fixture()
def session():
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        yield db
        db.rollback()


def test_projects_are_owner_scoped_and_versioned(session: Session):
    service = ProjectService(session)
    project = service.create("owner-a", ProjectCreate(name="Aelys"))
    session.commit()
    assert service.repo.list("owner-a")[0].name == "Aelys"
    with pytest.raises(NotFoundError):
        service.repo.get(project.id, "owner-b")
    updated = service.update("owner-a", project.id, ProjectPatch(version=1, name="Aelys Core"))
    assert updated.version == 2
    with pytest.raises(ConflictError):
        service.update("owner-a", project.id, ProjectPatch(version=1, name="stale"))


def test_notes_keep_revision_and_tasks_support_owner_scoping(session: Session):
    note = create_note(NoteCreate(title="Spec", markdown_body="# v1"), session, "owner-a")
    session.commit()
    create_note(NoteCreate(title="Other", markdown_body="private"), session, "owner-b")
    note.markdown_body = "# v2"
    note.version = 2
    session.add(NoteRevision(owner_id="owner-a", note_id=note.id, base_version=1, revision_no=2, body=note.markdown_body))
    task = create_task(TaskCreate(title="Test API"), session, "owner-a")
    session.commit()
    assert task.owner_id == "owner-a"
    assert session.query(NoteRevision).filter_by(note_id=note.id).count() == 1
    assert session.query(Note).filter_by(owner_id="owner-b").count() == 1


def test_finance_rejects_float_and_replays_idempotency(session: Session):
    account = create_account(AccountCreate(name="Cash", currency="KZT"), session, "owner-a")
    session.commit()
    with pytest.raises(Exception):
        TransactionCreate(account_id=account.id, amount=1.25, currency="KZT", transaction_type="expense", occurred_on="2026-10-28", idempotency_key="float")
    payload = TransactionCreate(account_id=account.id, amount=Decimal("10.20"), currency="KZT", transaction_type="expense", occurred_on="2026-10-28", idempotency_key="tx-1")
    first = create_transaction(payload, session, "owner-a")
    session.commit()
    second = create_transaction(payload, session, "owner-a")
    assert first.id == second.id
    assert first.amount == Decimal("10.2000")


def test_mail_is_local_import_and_does_not_return_secret_reference(session: Session):
    account = create_mail_account(MailAccountCreate(), session, "owner-a")
    message = import_message(MessageImport(account_id=account.id, sender="a@example.test", received_at=datetime.now(timezone.utc), body_text="hello"), session, "owner-a")
    assert account.provider == "local_import"
    assert message.sync_origin == "local_import"
    assert not hasattr(message, "api_key")


def test_sync_is_idempotent_and_blocks_private_agent_payloads():
    store = InMemorySyncStore(); owner = "owner-a"; device = uuid4(); resource = uuid4()
    op = SyncOperation(operation_id=uuid4(), device_id=device, resource_kind="task", resource_id=resource, action=SyncAction.create, base_version=0, patch={"title": "x"})
    first = store.push(owner, [op]); replay = store.push(owner, [op])
    assert first.results[0].status == "applied"
    assert replay.results[0].version == first.results[0].version
    pulled = store.pull(owner)
    assert len(pulled.changes) == 1
    with pytest.raises(ValueError):
        SyncOperation(operation_id=uuid4(), device_id=device, resource_kind="agent_transcript", resource_id=uuid4(), action=SyncAction.create, base_version=0, patch={"body": "secret"})


def test_calendar_reminder_and_ai_provider_contracts(session: Session):
    task = create_task(TaskCreate(title="Review contract"), session, "owner-a")
    event = create_event(EventCreate(title="Review", starts_at=datetime.now(timezone.utc), ends_at=datetime.now(timezone.utc) + timedelta(hours=1)), session, "owner-a")
    reminder = create_reminder(task.id, ReminderCreate(task_id=task.id, notify_at=datetime.now(timezone.utc), idempotency_key="rem-1"), session, "owner-a")
    assert reminder.task_id == task.id and event.owner_id == "owner-a"
    provider = create_provider(ProviderCreate(kind="claude", model_policy={"default_model": "claude-test"}, secret_ref="vault://owner-a/claude"), session, "owner-a")
    conversation = create_conversation(ConversationCreate(title="Daily"), session, "owner-a")
    run = create_run(RunCreate(conversation_id=conversation.id, message="Summarize tasks", idempotency_key="run-1"), session, "owner-a")
    assert run.model == "claude-test"
    assert provider.secret_ref == "vault://owner-a/claude"


def test_agent_session_resource_metadata_is_allowlisted():
    safe=ResourceCreate(kind="agent_session", entity_id="opaque-1", metadata={"adapter":"codex_cli","state":"indexed","message_count":2})
    assert safe.metadata["adapter"] == "codex_cli"
    with pytest.raises(ValueError):
        ResourceCreate(kind="agent_session", entity_id="opaque-2", metadata={"transcript":"private"})
