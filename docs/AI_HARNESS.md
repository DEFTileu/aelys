# Aelys — AI Harness, Model Router & Knowledge Retrieval v0.2

## 1. Agent responsibilities

Aelys AI Assistant is an application-level agent orchestration layer, not a replacement for Claude Code/Codex CLI. It:
- interprets user requests;
- chooses suitable LLM with user-owned API keys;
- selects tools across Aelys modules;
- retrieves minimal relevant knowledge with citations;
- asks Policy Engine for authorization before actual actions;
- tracks runs, steps, costs and failures.

**Coding-agent control:** `start_agent_run` is a tool of the assistant that delegates to Mac Runtime. The assistant itself must not gain generic arbitrary shell on backend or Mac.

## 2. Primary architecture

```text
User prompt
  -> Conversation Service (stores normal, allowed chat content)
  -> Routing Policy (task/category + capabilities + cost + health)
  -> Provider Adapter (Claude API, OpenRouter, future)
  -> Agent Loop (tools / context / stop / budget)
  -> Tool Registry + Policy Engine
  -> Domain Service or Mac Runtime scoped request
  -> Evidence/citations + safe answer
```

## 3. BYOK key management

- Owner registers provider credential using authenticated endpoint.
- Encrypt at rest with key material outside database; decrypt only within authorized provider-call path.
- UI and logs show masked provider identifier and last-four key chars only if safe; never expose secret on GET.
- Key rotation, deletion, disable, per-provider budget and rate limits.
- Distinguish server-side BYOK and local provider keys; **where keys live is OPEN**, so keep secret-store abstraction.
- Never pass provider keys as agent-visible tools, system prompts or CLI process env unless explicitly required and restricted.

## 4. Routing policy (initial deterministic rules)

Inputs: user preference, task kind, required tool capabilities, context length, privacy classification, provider/model availability, allowed per-request/monthly budget, latency preference.

Examples:

| Task kind | Selection goal |
|---|---|
| Simple classification/summary | cheap, fast, reliable model |
| Tool-using todo/calendar action | tool calling + JSON schema competence |
| Long-form architecture reasoning | stronger reasoning/context capacity |
| Private local session analysis | only provider permitted by data-release policy; else refuse or use local processing |
| Default unknown task | configured favorite general model |

Fallback to another model only when equivalent capabilities and privacy policy permit. Manual override must take precedence except invalid/forbidden selection.

Logging: provider, model, token usage, estimated cost, routing reason codes; *no raw prompt/session content in analytics by default*.

## 5. Tool registry

Typed tools initially:

| Tool | Operation | Policy scope |
|---|---|---|
| `search_resources` | read | allowed notes/tasks/docs/project IDs |
| `list_tasks`, `get_calendar` | read | owner/project |
| `create_task`, `update_task` | write | tasks.write |
| `create_note` | write | notes.write |
| `create_event` | write | calendar.write |
| `list_finance_summary` | read | finances.read (opt-in, sensitive) |
| `search_mail` | read | mail.read (scoped) |
| `draft_mail` | write local draft | mail.drafts.write |
| `send_mail` | external | separate explicit permission, no default grant |
| `search_agent_sessions` | live private read | named Mac/project, data egress policy |
| `start_agent_run`, `cancel_agent_run` | remote code execution | named Mac/project sandbox grant |

All tools: validated Pydantic input/output, clear cancellation and timeouts, trace/correlation IDs, redacted errors. Agent's claims are not authorization credentials.

## 6. Local session retrieval privacy

- Search runs on Mac; session text not replicated to cloud DB.
- Transient context fragments can be forwarded through backend to external LLM **only with owner's explicit provider egress policy**. Search with `local_only` disallows provider forwarding.
- If Mac absent, show what can be answered from neutral metadata and state limitations.
- Returned answer may be synced only if user policy permits storing derived chat output; source snippets never automatically retained in prompts/logs/embeddings.
- Cite `device/session/span` opaque refs; these resolve on Mac, not from cloud storage.
- External provider retention policies are outside Aelys's direct control and must be disclosed in settings/docs.

## 7. Tool execution pattern

```text
1. Classify request/required scopes.
2. Retrieve least-privileged context.
3. Select model, reserve token/cost budget.
4. Model chooses typed tool.
5. Validate arguments + Policy Engine authorizes.
6. Execute through domain service or remote runtime with idempotency.
7. Attach provenance + status; loop within step/time budget.
8. Respond with result, uncertainty and references.
```

Rule-based automation uses the same tool registry but has separate rule identity/permissions and strictly bounded execution.

## 8. Anti-prompt-injection controls

- Contents of emails, web pages, notes, repo code and CLI outputs are **untrusted data**, never system instructions.
- Model cannot read raw API keys, bypass policies, change grants or decide permission on its own.
- Retrieval is scoped by user/project/provider; redact likely tokens/secrets before provider transmission.
- External effects (email send, git push, deploy, delete outside sandbox) forbidden by default unless explicit policy.

## 9. Evaluation & acceptance

- Automatic routing picks only models meeting capability, budget and privacy constraints.
- Provider failure results in transparent fallback or actionable error, not duplicated tool side effects.
- Tool invocation requires verified policy; injection text in email cannot initiate unrelated command.
- Mac local session privacy contract validated through DB and log inspection.
- Answers referencing local agent sessions have valid opaque citations or state missing evidence.
- Billing estimates/retries don't exceed configured budgets without explicit additional approval.

## 10. Framework decision

Exact SDK unresolved. Evaluate OpenAI Agents SDK / direct provider SDK / other orchestration library against: streaming, external provider adapters, tracing/redaction, typed tools, cancellation, policy interception, license and testability. Do not hardwire provider SDK into every domain module.
