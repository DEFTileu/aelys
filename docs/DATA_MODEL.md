# Aelys — Data Model v0.2 (логическая спецификация)

Эта схема — **предложение**, а не готовые Alembic миграции. Важнейшее разделение: PostgreSQL **не содержит полные истории Claude Code/Codex**. Cloud session index допускает только заранее согласованные метаданные.

## 1. Общие соглашения

- Primary keys: UUIDv7 или UUIDv4 с явным единым решением в реализации. UUID создаётся клиентом для offline create.
- `owner_id` присутствует на пользовательских сущностях; FK/unique checks предотвращают cross-account leaks.
- Времена-моменты `timestamptz` в UTC; для повторений отдельно IANA timezone + recurrence rule.
- `version bigint NOT NULL DEFAULT 1`, `created_at`, `updated_at`, nullable `deleted_at` у синхронизируемых сущностей; soft delete/tombstones, затем GC после watermark устройств.
- Денежные значения `numeric(20, 4)` или minor units c ISO 4217 и специфицированной точностью; никогда `float`.
- JSONB для расширяемых настроек, но стабильные основные поля и constraints нормализованы.

## 2. Core

### users
`id PK`, `email UNIQUE NULL`, `password_hash NULL`, `created_at`, `settings_json`. Single-user instance всё равно использует идентичность владельца.

### devices
`id PK`, `owner_id FK`, `platform ENUM(web,macos,android,helper)`, `display_name`, `public_key/fingerprint`, `credential_version`, `last_seen_at`, `revoked_at`.

### projects
`id PK`, `owner_id FK`, `name`, `description`, `status ENUM(active,archived)`, `settings_json`, timestamps/version.

### resources
`id PK`, `owner_id FK`, `kind ENUM(note,task,event,file,mail,finance_transaction,focus_session,ai_chat,agent_session,repository)`, `entity_id UUID/string`, `project_id FK NULL` (optional primary project association), metadata strictly non-secret, timestamps/version.

Constraints: `(kind, entity_id, owner_id)` unique; resource must be owned by current user. For external agent session, stable `entity_id` can refer to cloud-safe `agent_session_index.id`. Never put local absolute paths or prompt titles in metadata by default.

### resource_links
`id PK`, `owner_id FK`, `from_resource_id FK`, `to_resource_id FK`, `relation_type`, timestamps; unique `(owner_id,from_resource_id,to_resource_id,relation_type)` and cycle rules depending on relation. Связь должна указывать только на разрешённые объекты.

## 3. User modules

### notes / note_revisions
`notes(id PK, owner_id, title, markdown_body, parent_id NULL, project_id NULL, version, deleted_at, ...)`.
`note_revisions(id PK, note_id FK, base_version, revision_no, body, source_device_id, created_at)`.
Conflicting simultaneous revisions: preserve both branches, don't silently overwrite body.

### tasks / task_reminders
`tasks(id,owner_id,project_id NULL,parent_task_id NULL,title,description,status,priority,due_at NULL,due_timezone NULL,rrule NULL,version,...)`.
`task_reminders(id,task_id,notify_at,channel,status,idempotency_key)`; task hierarchy constrained to same owner and no cycles.

### calendar_events
`(id, owner_id, project_id NULL, title, description, starts_at, ends_at, timezone, all_day, rrule NULL, recurrence_exceptions JSONB, linked_task_id NULL, version)`; prohibit `ends_at < starts_at` except correctly represented all-day semantics.

### finance_accounts / transactions / categories / budgets
`finance_accounts(id,owner_id,name,currency,type,...)`.
`transactions(id,owner_id,account_id,category_id NULL,amount numeric,currency,type,date,related_transfer_id NULL,notes,...)`; transaction corrections audited; transfers balanced per model.
`budgets(id,owner_id,category_id NULL,currency,period_start,period_end,limit_amount,...)`.

### focus_sessions
`id,owner_id,task_id NULL,project_id NULL,started_at,ended_at NULL,elapsed_seconds,mode,device_id,status,version`. One active timer per user by policy or conflict resolution.

### mail_accounts / mail_messages / mail_drafts
`mail_accounts(id,owner_id,provider,external_id,credentials_ref NULL,connection_status)`.
`mail_messages(id,owner_id,account_id,provider_message_id NULL,thread_id NULL,from/to,subject,received_at,body_storage_ref NULL,sync_origin)`.
`mail_drafts(id,owner_id,account_id,thread_id NULL,content,status,version)`.
If Gmail OAuth is not in MVP, mail records may come from import; do not invent provider IDs.

## 4. AI

### ai_providers / ai_provider_secrets
`ai_providers(id,owner_id,kind,base_url,enabled,model_policy_json)`; secrets stored by **reference to encrypted secret store**, not raw `api_key` in a general settings table.

### ai_conversations / ai_messages / ai_runs
`ai_conversations(id,owner_id,project_id NULL,title,created_at,...)`.
`ai_messages(id,conversation_id,role,content,source_refs_json,safety_classification,created_at)`.
`ai_runs(id,conversation_id,provider,model,status,token_counts,cost_estimate,started_at,completed_at,...)`.
**Rule:** raw local agent session excerpt (if retrieved) must not be persisted in AI chat transcript unless user explicitly chose to retain it. Store redacted citation refs and response as allowed; audit content retention setting.

### agent_session_index (CLOUD ONLY)
`id PK`, `owner_id`, `device_id`, `project_id NULL`, `adapter ENUM(claude_code,codex_cli)`, `opaque_local_session_ref`, `started_at`, `last_activity_at`, `message_count NULL`, `state`, `last_indexed_at`.
No `prompt`, `messages`, `summary`, `embedding`, source code, absolute path, command history, transcript titles by default. Keep minimal cloud-safe metadata; encrypt/ref HMAC any local identifiers if linkable.

### agent_runs (command orchestration)
`id PK`, `owner_id`, `project_id`, `device_id`, `adapter`, `status`, `request_policy_id`, `lease_until`, `created_at`, `started_at`, `completed_at`, `error_code NULL`, `result_metadata_json` (redacted)`.
Long-form results and CLI logs local-only; streamed snippets transient and redacted.

## 5. Automation / audit

### automation_rules
`id,owner_id,name,enabled,trigger_kind,conditions_json,actions_json,policy_ref,rate_limit_json,version`.
### automation_executions
`id,rule_id,event_id UNIQUE per rule,run_status,attempt,started_at,finished_at,error_code`; idempotent.
### activity_events
`id,owner_id,resource_id NULL,event_kind,actor_kind,actor_id,occurred_at,non_sensitive_metadata`.
### audit_logs
`id,owner_id,action,actor,scope,decision,outcome,correlation_id,created_at,redacted_metadata`; append-only by application logic and archival policy.

## 6. Synchronization

### sync_changes
`seq bigserial PK`, `owner_id`, `resource_kind`, `resource_id`, `version`, `operation ENUM(create,update,delete)`, `changed_fields_json/patch_json`, `created_at`, `visibility_scope`; payload MUST exclude local-only session contents and secrets.

### client_operations
`operation_id UUID PK`, `owner_id`, `device_id`, `resource_id`, `base_version`, `result_status`, `applied_version NULL`, `applied_seq NULL`, `server_response_digest`, `created_at`; prevents duplicate application.

### device_sync_cursors
`owner_id,device_id,last_ack_seq,updated_at`; tracks safe compaction. Need snapshot/bootstrap strategy for old/new devices.

## 7. Local macOS database (never auto-upload raw data)

- `local_agent_sessions(adapter, local_session_ref, allowed_project_id, discovered_at, ...)`.
- `local_agent_messages(session_ref, seq, role, content, timestamps)`.
- `local_agent_fts` (FTS5, message content indexed locally).
- `local_agent_runs` (local process PID/handle, sandbox policy, status, encrypted/redacted logs).
- `local_sync_outbox` (only whitelisted metadata for cloud).

No schema migration should add transcript/body/embedding to cloud `agent_session_index` without new explicit ADR.

## 8. Indexes, constraints, migrations

- Index `tasks(owner_id,due_at,status)`, `calendar_events(owner_id,starts_at)`, `resources(owner_id,kind,project_id)`, `resource_links(from_resource_id)`, `sync_changes(owner_id,seq)`.
- PostgreSQL FTS on allowed notes and imported mails; private Mac session FTS only local.
- Foreign keys and owner checks are mandatory; implement soft-deleted resource filtering consistently.
- Alembic migration(s) + seed minimal single-user config + integration tests for versioning/constraints.

## Phase 3 persistence follow-through (2026-10-29)

- `calendar_reminders`: Owned/versioned, `event_id` FK, `notify_at`,
  `channel=in_app`, `reminder_status`, unique `idempotency_key`, nullable
  `offset_seconds` and `occurrence_at` for forward-compatible recurring schedules.
  Delivery/cancellation uses conditional version transitions; notifications have
  a unique reminder+occurrence dedup key. Included in owner export/restore.
- FocusSession has a partial unique index on `owner_id` while status is active
  and the row is not deleted, covering concurrent device starts at the DB layer.
- Finance transaction amount and budget limit use ExactMoney: NUMERIC(20,4) on
  PostgreSQL and VARCHAR(40) on SQLite. SQLite NUMERIC affinity otherwise binds
  Decimal through binary float; migration 0019 prevents future precision loss.
  Historical values already rounded by an older SQLite database cannot be
  reconstructed by this migration. No cloud schema for private agent data or
  secrets changes in this phase.
- Migrations: 0017 calendar reminders; 0018 active-owner Focus uniqueness;
  0019 exact SQLite money; 0020 recurring-reminder cursor/offset.

### Implemented Telegram Business persistence (migration 0022)

- `telegram_integrations`: one connector per owner, encrypted write-only token,
  bot identity/capability, explicit assistant/provider settings, numeric bound
  Telegram owner, hashed expiring challenge, durable update cursor and worker lease.
- `telegram_business_connections`: Telegram connection ID, integration/owner scope,
  enabled state and only the supported reply/read rights.
- `telegram_business_messages`: owner/versioned integration/connection/chat/message
  identity, minimal text/direction/time, editable draft and send state. Composite
  remote identity is unique. Message text, draft, chat label and business persona
  use AES-GCM encrypted text fields; raw updates are never persisted.
- `telegram_update_receipts`: unique `(integration_id,update_id)`; receipt commits
  with message ingestion and cursor. No content or credentials in the receipt.

Business content is erased after seven days, on incoming deletion/revocation, or
on explicit disconnect. Connector tables are not part of general owner export
or offline sync. AI run audits retain counts/cost and metadata, without Telegram
message content in `ai_messages`. These are implemented schema details; other
PROPOSED entities in this document remain proposals.
