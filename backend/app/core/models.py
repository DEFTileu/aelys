from __future__ import annotations
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, JSON, BigInteger, Index
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base

def uid() -> str: return str(uuid.uuid4())
def now() -> datetime: return datetime.now(timezone.utc)

class Owned(Base):
    __abstract__ = True
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    email: Mapped[str | None] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    settings_json: Mapped[dict] = mapped_column(JSON, default=dict)
class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    device_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("devices.id"))
    refresh_token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class Device(Owned):
    __tablename__ = "devices"
    platform: Mapped[str] = mapped_column(String(20))
    display_name: Mapped[str] = mapped_column(String(200))
    public_key: Mapped[str | None] = mapped_column(String(255))
    credential_hash: Mapped[str] = mapped_column(String(128))
    credential_version: Mapped[int] = mapped_column(Integer, default=1)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

class Project(Owned):
    __tablename__ = "projects"
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="active")
    settings_json: Mapped[dict] = mapped_column(JSON, default=dict)

class ProjectGrant(Owned):
    __tablename__ = "project_grants"
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("projects.id"))
    device_id: Mapped[str] = mapped_column(String(36), ForeignKey("devices.id"))
    policy_id: Mapped[str] = mapped_column(String(36))
    isolation_validated: Mapped[bool] = mapped_column(Boolean, default=False)
    isolation_nonce: Mapped[str | None] = mapped_column(String(100))
    isolation_validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    network_allowed: Mapped[bool] = mapped_column(Boolean, default=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (UniqueConstraint("owner_id","project_id","device_id",name="uq_project_grant"),)

class Resource(Owned):
    __tablename__ = "resources"
    kind: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str] = mapped_column(String(100))
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("projects.id"))
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    __table_args__ = (UniqueConstraint("owner_id", "kind", "entity_id", name="uq_resource_owner_kind_entity"),)

class ResourceLink(Owned):
    __tablename__ = "resource_links"
    from_resource_id: Mapped[str] = mapped_column(String(36), ForeignKey("resources.id"))
    to_resource_id: Mapped[str] = mapped_column(String(36), ForeignKey("resources.id"))
    relation_type: Mapped[str] = mapped_column(String(50))
    __table_args__ = (UniqueConstraint("owner_id", "from_resource_id", "to_resource_id", "relation_type", name="uq_resource_link"),)

class Note(Owned):
    __tablename__ = "notes"
    title: Mapped[str] = mapped_column(String(300))
    markdown_body: Mapped[str] = mapped_column(Text, default="")
    parent_id: Mapped[str | None] = mapped_column(String(36))
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("projects.id"))

class NoteRevision(Base):
    __tablename__ = "note_revisions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    note_id: Mapped[str] = mapped_column(String(36), ForeignKey("notes.id"), index=True)
    base_version: Mapped[int] = mapped_column(Integer)
    revision_no: Mapped[int] = mapped_column(Integer)
    body: Mapped[str] = mapped_column(Text)
    source_device_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class Task(Owned):
    __tablename__ = "tasks"
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("projects.id"))
    parent_task_id: Mapped[str | None] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(30), default="todo")
    priority: Mapped[int] = mapped_column(Integer, default=0)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    due_timezone: Mapped[str | None] = mapped_column(String(64))
    rrule: Mapped[str | None] = mapped_column(String(500))

class CalendarEvent(Owned):
    __tablename__ = "calendar_events"
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("projects.id"))
    linked_task_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("tasks.id"))
    rrule: Mapped[str | None] = mapped_column(String(500))

class FinanceAccount(Owned):
    __tablename__ = "finance_accounts"
    name: Mapped[str] = mapped_column(String(200)); currency: Mapped[str] = mapped_column(String(3)); type: Mapped[str] = mapped_column(String(30), default="cash")
class FinanceCategory(Owned):
    __tablename__ = "finance_categories"
    name: Mapped[str] = mapped_column(String(200)); kind: Mapped[str] = mapped_column(String(30), default="expense")
class FinanceTransaction(Owned):
    __tablename__ = "finance_transactions"
    account_id: Mapped[str] = mapped_column(String(36), ForeignKey("finance_accounts.id")); category_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("finance_categories.id")); amount: Mapped[Decimal] = mapped_column(Numeric(20,4)); currency: Mapped[str] = mapped_column(String(3)); type: Mapped[str] = mapped_column(String(20)); occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True)); notes: Mapped[str] = mapped_column(Text, default=""); idempotency_key: Mapped[str | None] = mapped_column(String(100), unique=True); related_transfer_id: Mapped[str | None] = mapped_column(String(36), index=True)
class FinanceBudget(Owned):
    __tablename__ = "finance_budgets"
    category_id: Mapped[str | None] = mapped_column(String(36)); currency: Mapped[str] = mapped_column(String(3)); period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True)); period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True)); limit_amount: Mapped[Decimal] = mapped_column(Numeric(20,4))

class FocusSession(Owned):
    __tablename__ = "focus_sessions"
    task_id: Mapped[str | None] = mapped_column(String(36)); project_id: Mapped[str | None] = mapped_column(String(36)); started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True)); ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True)); elapsed_seconds: Mapped[int] = mapped_column(Integer, default=0); mode: Mapped[str] = mapped_column(String(30), default="pomodoro"); status: Mapped[str] = mapped_column(String(20), default="active")

class MailMessage(Owned):
    __tablename__ = "mail_messages"
    account_id: Mapped[str | None] = mapped_column(String(36)); thread_id: Mapped[str | None] = mapped_column(String(100)); sender: Mapped[str] = mapped_column(String(320)); recipients: Mapped[list] = mapped_column(JSON, default=list); subject: Mapped[str] = mapped_column(String(500)); body: Mapped[str] = mapped_column(Text, default=""); received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True)); sync_origin: Mapped[str] = mapped_column(String(30), default="import")
class MailDraft(Owned):
    __tablename__ = "mail_drafts"
    account_id: Mapped[str | None] = mapped_column(String(36)); thread_id: Mapped[str | None] = mapped_column(String(100)); recipients: Mapped[list] = mapped_column(JSON, default=list); subject: Mapped[str] = mapped_column(String(500), default=""); content: Mapped[str] = mapped_column(Text, default=""); status: Mapped[str] = mapped_column(String(20), default="draft")
class MailAccount(Owned):
    __tablename__ = "mail_accounts"
    provider: Mapped[str] = mapped_column(String(30), default="local_import"); external_id: Mapped[str | None] = mapped_column(String(200)); credentials_ref: Mapped[str | None] = mapped_column(String(100)); connection_status: Mapped[str] = mapped_column(String(30), default="local_import")
class TaskReminder(Owned):
    __tablename__ = "task_reminders"
    task_id: Mapped[str] = mapped_column(String(36)); notify_at: Mapped[datetime] = mapped_column(DateTime(timezone=True)); channel: Mapped[str] = mapped_column(String(30), default="in_app"); reminder_status: Mapped[str] = mapped_column(String(20), default="pending"); idempotency_key: Mapped[str] = mapped_column(String(100), unique=True)

class AIProvider(Owned):
    __tablename__ = "ai_providers"
    kind: Mapped[str] = mapped_column(String(30)); base_url: Mapped[str | None] = mapped_column(String(500)); enabled: Mapped[bool] = mapped_column(Boolean, default=True); model_policy_json: Mapped[dict] = mapped_column(JSON, default=dict); secret_ref: Mapped[str | None] = mapped_column(String(100))
class AIProviderSecret(Base):
    __tablename__ = "ai_provider_secrets"
    provider_id: Mapped[str] = mapped_column(String(36), ForeignKey("ai_providers.id"), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), index=True)
    encrypted_value: Mapped[str] = mapped_column(Text)
    key_version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
class AIConversation(Owned):
    __tablename__ = "ai_conversations"
    project_id: Mapped[str | None] = mapped_column(String(36)); title: Mapped[str] = mapped_column(String(300), default="Conversation"); tool_scope_json: Mapped[dict] = mapped_column(JSON, default=dict)
class AIMessage(Base):
    __tablename__ = "ai_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid); conversation_id: Mapped[str] = mapped_column(String(36), ForeignKey("ai_conversations.id")); role: Mapped[str] = mapped_column(String(20)); content: Mapped[str] = mapped_column(Text); source_refs_json: Mapped[list] = mapped_column(JSON, default=list); created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
class AIRun(Owned):
    __tablename__ = "ai_runs"
    conversation_id: Mapped[str] = mapped_column(String(36), ForeignKey("ai_conversations.id")); prompt_message_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ai_messages.id"), nullable=True); provider_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("ai_providers.id"), nullable=True); provider: Mapped[str] = mapped_column(String(50)); model: Mapped[str] = mapped_column(String(150)); status: Mapped[str] = mapped_column(String(30), default="queued"); idempotency_key: Mapped[str | None] = mapped_column(String(150), nullable=True); request_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True); tool_scope_json: Mapped[dict] = mapped_column(JSON, default=dict); token_counts: Mapped[dict] = mapped_column(JSON, default=dict); cost_estimate: Mapped[Decimal] = mapped_column(Numeric(20,8), default=Decimal("0")); started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True)); completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (Index("ix_ai_run_owner_idempotency", "owner_id", "idempotency_key", unique=True),)

class AIRunEvent(Base):
    __tablename__ = "ai_run_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    run_id: Mapped[str] = mapped_column(String(36), ForeignKey("ai_runs.id"), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    event_id: Mapped[str] = mapped_column(String(100))
    event_type: Mapped[str] = mapped_column(String(80))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    __table_args__ = (UniqueConstraint("run_id", "sequence", name="uq_ai_run_event_sequence"), UniqueConstraint("run_id", "event_id", name="uq_ai_run_event_id"))

class AgentSessionIndex(Owned):
    __tablename__ = "agent_session_index"
    device_id: Mapped[str] = mapped_column(String(36)); project_id: Mapped[str | None] = mapped_column(String(36)); adapter: Mapped[str] = mapped_column(String(30)); opaque_local_session_ref: Mapped[str] = mapped_column(String(255)); started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True)); last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True)); message_count: Mapped[int | None] = mapped_column(Integer); state: Mapped[str] = mapped_column(String(30), default="active")
class AgentRun(Owned):
    __tablename__ = "agent_runs"
    project_id: Mapped[str] = mapped_column(String(36)); device_id: Mapped[str] = mapped_column(String(36)); adapter: Mapped[str] = mapped_column(String(30)); status: Mapped[str] = mapped_column(String(30), default="queued"); request_policy_id: Mapped[str] = mapped_column(String(36)); idempotency_key: Mapped[str | None] = mapped_column(String(150), nullable=True); lease_id: Mapped[str | None] = mapped_column(String(36)); lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True)); cancellation_requested: Mapped[bool] = mapped_column(Boolean, default=False); error_code: Mapped[str | None] = mapped_column(String(80)); result_metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    __table_args__ = (Index("ix_agent_run_owner_idempotency", "owner_id", "idempotency_key", unique=True),)
    task: Mapped[str] = mapped_column(Text, default="")

class ActivityEvent(Owned):
    __tablename__ = "activity_events"
    resource_id: Mapped[str | None] = mapped_column(String(36)); event_kind: Mapped[str] = mapped_column(String(80)); actor_kind: Mapped[str] = mapped_column(String(30)); actor_id: Mapped[str | None] = mapped_column(String(36)); occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now); non_sensitive_metadata: Mapped[dict] = mapped_column(JSON, default=dict)
class Notification(Owned):
    __tablename__ = "notifications"
    kind: Mapped[str] = mapped_column(String(80)); title: Mapped[str] = mapped_column(String(300)); body: Mapped[str | None] = mapped_column(Text); read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True)); dedup_key: Mapped[str | None] = mapped_column(String(150), unique=True); data_json: Mapped[dict] = mapped_column(JSON, default=dict)
class HistoryEntry(Owned):
    __tablename__ = "history_entries"
    resource_id: Mapped[str | None] = mapped_column(String(36)); action: Mapped[str] = mapped_column(String(80)); actor: Mapped[str] = mapped_column(String(80)); metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
class AutomationRule(Owned):
    __tablename__ = "automation_rules"
    name: Mapped[str] = mapped_column(String(200)); enabled: Mapped[bool] = mapped_column(Boolean, default=True); trigger_kind: Mapped[str] = mapped_column(String(80)); conditions_json: Mapped[dict] = mapped_column(JSON, default=dict); actions_json: Mapped[list] = mapped_column(JSON, default=list); policy_ref: Mapped[str] = mapped_column(String(100)); rate_limit_json: Mapped[dict] = mapped_column(JSON, default=dict)
class AutomationExecution(Base):
    __tablename__ = "automation_executions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid); owner_id: Mapped[str] = mapped_column(String(36)); rule_id: Mapped[str] = mapped_column(String(36)); event_id: Mapped[str] = mapped_column(String(36)); run_status: Mapped[str] = mapped_column(String(30)); attempt: Mapped[int] = mapped_column(Integer, default=1); started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now); finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True)); error_code: Mapped[str | None] = mapped_column(String(80)); __table_args__ = (UniqueConstraint("rule_id", "event_id", name="uq_automation_event"),)

class SyncChange(Base):
    __tablename__ = "sync_changes"
    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True); owner_id: Mapped[str] = mapped_column(String(36), index=True); resource_kind: Mapped[str] = mapped_column(String(40)); resource_id: Mapped[str] = mapped_column(String(36)); version: Mapped[int] = mapped_column(Integer); operation: Mapped[str] = mapped_column(String(20)); payload: Mapped[dict] = mapped_column(JSON, default=dict); committed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
class ClientOperation(Base):
    __tablename__ = "client_operations"
    operation_id: Mapped[str] = mapped_column(String(36), primary_key=True); owner_id: Mapped[str] = mapped_column(String(36)); device_id: Mapped[str] = mapped_column(String(36)); resource_id: Mapped[str] = mapped_column(String(36)); result_status: Mapped[str] = mapped_column(String(30)); applied_version: Mapped[int | None] = mapped_column(Integer); applied_seq: Mapped[int | None] = mapped_column(BigInteger); response_json: Mapped[dict] = mapped_column(JSON, default=dict); created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
class SyncRecord(Base):
    __tablename__ = "sync_records"
    owner_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    resource_kind: Mapped[str] = mapped_column(String(40), primary_key=True)
    resource_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
class SyncCompactionWatermark(Base):
    __tablename__ = "sync_compaction_watermarks"
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    watermark: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, nullable=False)
class DeviceSyncCursor(Base):
    __tablename__ = "device_sync_cursors"
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id"), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(36), ForeignKey("devices.id"), primary_key=True)
    last_ack_seq: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now, nullable=False)
class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid); owner_id: Mapped[str] = mapped_column(String(36)); action: Mapped[str] = mapped_column(String(100)); actor: Mapped[str] = mapped_column(String(100)); scope: Mapped[str] = mapped_column(String(200)); decision: Mapped[str] = mapped_column(String(30)); outcome: Mapped[str] = mapped_column(String(30)); correlation_id: Mapped[str] = mapped_column(String(36)); redacted_metadata: Mapped[dict] = mapped_column(JSON, default=dict); created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
