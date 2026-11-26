# From an opened message to an approved task

The owner chooses **Suggest a task** in an open mail message, checks the title,
deadline and source, then chooses **Create task** or **Dismiss**. The selected
work item is “Mail extraction → task”, listed under Phase 7 task 4 in this
checkout. The assignment refers to the same item as Phase 8 task 4.

## Evidence behind the implementation

Mukherjee et al. distinguish identifying a commitment from composing a useful
task title. Their method uses thread context when the commitment alone is
underspecified. This slice copies an explicit request from one selected message
and abstains on unmatched text. Their generation scores do not measure the
accuracy of this local extractor. [Smart To-Do (original paper)](https://www.microsoft.com/en-us/research/wp-content/uploads/2020/04/SmartToDo.pdf)

Chen et al. study structured separation of instructions and data. In this
implementation, mail cannot select a tool, project, destination, query or scope.
The parser can populate a title and deadline. The server constructs the link
from the stored message ID. Incoming content has no path to an LLM provider
or connector in this extractor. [StruQ (original paper)](https://arxiv.org/abs/2402.06363)

Google documents distinct Gmail read, draft and send permissions. Extraction
uses the existing local copy obtained through EML import or explicit Gmail sync.
A proposal binds to the local account and its connection version. Revocation
learned by Aelys invalidates approval. Detecting a remote-only revocation would
require a provider request, outside this local operation. [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

## Approval, provenance and replay

The task title and deadline pass through the shared CreateTaskToolArgs schema.
One deterministic AIAction ID per owner and local message makes duplicates and
dismissals durable. The database transaction includes the internal conversation,
run and action. Approval claims the pending action, locks and checks its source
and account, recomputes the candidate, then invokes the existing policy-checked
create_task tool. Task and sync projection commit with the approval. Read-state
changes preserve a proposal. An account reconnection or changed candidate blocks
the old approval. A previously approved task survives source removal. Its stored
description contains the local mail link. No schema migration is required.

Telegram still uses its separately enabled private Business chat, bounded
tool-free model extraction and private owner callback. The synthetic
`test_full_owner_command_extract_callback_flow_commits_before_private_confirmation`
exercises opt-in, ingestion, duplicate callbacks and a single task sync change.
The Business card identifies its chat and the action stores the local message ID.
The existing Telegram card has no clickable message permalink. The Telegram Bot
API distinguishes Business connections from the chats whose messages the bot
receives. [Telegram Bot API](https://core.telegram.org/bots/api#businessconnection)

## Scope and integration

- First explicit English/Russian request in the first 16,000 plain-text characters
  or subject. Common quoted lines and reply boundaries are excluded. HTML-only
  requests, implicit assignments, pronoun resolution, multiple tasks and
  cross-message deduplication remain outside this slice.
- The parser understands ISO dates/times and today/tomorrow after a deadline
  marker. Relative days use the stored received timestamp in the owner's browser
  zone. Dates without a clock use 23:59, matching the task editor. Missing zone
  data or ambiguous local times leave the original wording in the title.
- The UI requires an online owner session to propose or approve. It uses no
  background mailbox processing. No production accounts or messages were used.
- Base commit 455a05d precedes ab80544. Inspection of 9f18c65 and ab80544 showed
  a separate group history opt-in. That setting grants no task extraction scope.
  The shared approval and private Business extractor match across those bases.
  Integrators should regenerate OpenAPI on the combined tree and preserve both
  sets of shared-client methods. The common prompt and context builder have no
  changes in this slice.

В объединённой ветке нативный мост разрешает POST-запрос предложения задачи для
одного письма. Подтверждение и отказ используют существующие маршруты AI Actions.

## Reproducing validation

Run the following from the repository root with backend test/quality extras and
workspace dependencies installed. Set `AELYS_TEST_AI_POSTGRES_ADMIN_URL` to the
test fixture's disposable loopback PostgreSQL admin URL to run contention tests.

```sh
backend/.venv/bin/pytest -q backend/tests/ai_automation/test_mail_task_contention.py backend/tests/ai_automation/test_telegram_task_suggestions_postgres.py backend/tests/test_mail_task_suggestions.py backend/tests/test_gmail_connection.py backend/tests/test_telegram_task_suggestions.py
pnpm --filter @aelys/web test src/tests/mail-html.test.tsx src/tests/tasks-workspace.test.tsx
pnpm typecheck
pnpm build
backend/.venv/bin/ruff check backend/app/domains/{mail_task_suggestions,api}.py backend/app/ai/actions.py backend/tests/{test_mail_task_suggestions,test_gmail_connection,ai_automation/test_mail_task_contention}.py
backend/.venv/bin/bandit -q backend/app/domains/mail_task_suggestions.py backend/app/ai/actions.py
(cd backend && .venv/bin/mypy --explicit-package-bases --follow-imports=silent --ignore-missing-imports app/domains/mail_task_suggestions.py)
```

On SQLite and disposable PostgreSQL 16 the backend run passed 95 cases. The three
skips are the SQLite parameter of PostgreSQL-only Telegram tests. The two web
suites passed 39 cases. TypeScript, production build, Ruff, Bandit and the scoped
mypy check passed. Vite reported its chunk-size warning. A temporary Git index
loaded from ab80544 accepted the full staged patch with `git apply --cached --check`.
