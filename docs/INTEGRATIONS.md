# Aelys — Integrations, Mail, Telegram v0.2

## 1. Product ordering

**DECIDED:** собственные модули прежде внешних интеграций. Также **DECIDED:** целевой MVP включает Mail и Telegram. Следовательно, нужно разделять `доменный модуль` и `действующее подключение`.

| Feature | Сразу в модульном ядре | Внешнее подключение |
|---|---|---|
| Mail | message/thread/draft/search/import API | Gmail OAuth / IMAP later, timing OPEN |
| Calendar | native Aelys events / recurrence | Google Calendar later |
| Telegram | command/notification adapter abstraction | Реальный Bot API обязателен для рабочего бота |
| GitHub | repository association, manual links | OAuth, repo webhooks later |
| Finance | manual ledger/budgets | Банки / валютные котировки later |
| Weather / converter | utility interfaces optional | Providers later |

## 2. Mail domain

Internal entities: MailAccount, MailMessage, MailThread (or thread identifier), MailDraft, MailAttachmentRef, MailSyncState. Message IDs must be provider-aware; imported EML files get import source IDs/hashes. Do not silently duplicate imported messages.

### Planned use cases
- Search imported/connected mailbox.
- Ask AI to summarize messages from specific period and classify.
- Extract due date/task with source message reference.
- Draft a response. **Sending** is an external action requiring separate scope.

### Gmail integration (OPEN for MVP)
If approved: OAuth scopes minimized (read-only first), incremental sync/backfill, pagination, refresh/revocation, webhook/polling semantics, quota/backoff, secure token storage, thread and attachment support, no blanket model access to inbox. Separate step for send scope. Mail retention/classification settings required.

### Offline mail
Cached messages and drafts are available offline; new incoming mail and actual sending require network. Deferred send must never silently execute without the user having granted explicit send permission.

## 3. Telegram bot

### First useful commands (PROPOSED)

```text
/start       # identity binding
/today       # tasks + events today
/task <text>  # capture task
/note <text>  # capture note
/remind ...   # reminder
/help
```

Bot security:
- Enrollment challenge sent through authenticated Aelys UI, exchanged once in Telegram chat.
- Allowlist owner Telegram numeric ID, refuse commands from strangers.
- Validate webhook secret/token and idempotent `update_id`.
- Set anti-spam/rate limits; never print API keys or Mac-only transcript excerpts in Telegram without explicit feature permission.
- Acknowledgment of delayed reminders and retries; recheck if message is sent during temporary network failure.

### AI + automation
Bot can create tasks and request summaries through the same domain tools / Policy Engine. Avoid separate Telegram-specific business logic or direct database writes.

## 4. GitHub and repo tracking

A Project may reference a repo by HTTPS URL/remote and local path known **only on Mac**. Cloud store canonical repo ID/URL if user approves; never store local absolute paths by default. Read commits or associate agent runs after an integration adapter is approved.

## 5. Provider contract

```text
ProviderAdapter:
  capabilities() / auth_status()
  fetch_incremental(cursor)
  execute_write(action, scope, idempotency_key)
  revoke()
```

Not all providers implement writes. Capabilities must be explicit and feature-gated.

## 6. Decision gates

Before live Gmail: owner confirms read/draft/send scopes and sync/retention policy.
Before live Telegram: owner confirms bot-only contact model and notification categories.
Before any bank connections: separate security and data sensitivity review.
