/** Wire types for the mounted FastAPI /api/v1 application. Dates are ISO strings. */

export type Id = string;
export type IsoDateTime = string;
export type IsoDate = string;
export type DecimalString = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly details: JsonObject;
}

export interface ErrorEnvelope {
  readonly error: ErrorBody;
  readonly request_id: string;
}

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
}
// password_setup is absent on servers that predate setup tokens, where password setup was always available.
export interface BrowserAuthStatus { readonly initialized: boolean; readonly can_resume: boolean; readonly password_setup?: boolean; }
export interface BrowserSession { readonly access_token: string; readonly device_id: Id | null; readonly token_type: string; }
export interface RefreshRequest {
  readonly refresh_token: string;
}
export interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: string;
}
export interface MeResponse {
  readonly id: Id;
  readonly email: string | null;
  readonly device_id: Id | null;
}

export type DevicePlatform = "web" | "macos" | "android" | "helper";
export interface DeviceEnroll {
  readonly platform: DevicePlatform;
  readonly display_name: string;
  readonly public_key?: string | null;
}
export interface DeviceResponse {
  readonly id: Id;
  readonly platform: string;
  readonly display_name: string;
  readonly revoked_at: IsoDateTime | null;
}
export interface DeviceEnrollmentResponse {
  readonly device_id: Id;
  readonly credential: string;
  readonly access_token: string;
}
export interface RevokeResponse {
  readonly revoked: boolean;
}

export type ProjectStatus = "active" | "archived" | string;
export interface ProjectCreate {
  readonly name: string;
  readonly description?: string;
}
export interface ProjectPatch {
  readonly version?: number;
  readonly name?: string;
  readonly description?: string;
  readonly status?: ProjectStatus;
}
export interface ProjectResponse {
  readonly name: string;
  readonly description: string;
  readonly id: Id;
  readonly status: ProjectStatus;
  readonly version: number;
}
export interface ProjectGrantCreate {
  readonly device_id: Id;
  readonly policy_id?: Id;
  readonly network_allowed?: boolean;
}
export interface ProjectGrantResponse {
  readonly id: Id;
  readonly project_id: Id;
  readonly device_id: Id;
  readonly policy_id: Id;
  readonly isolation_nonce: string;
  readonly isolation_validated: boolean;
  readonly network_allowed: boolean;
}
export type ResourceKind =
  | "note"
  | "task"
  | "event"
  | "file"
  | "mail"
  | "finance_transaction"
  | "focus_session"
  | "ai_chat"
  | "agent_session"
  | "repository";
export interface ResourceCreate {
  readonly kind: ResourceKind;
  readonly entity_id: string;
  readonly project_id?: Id | null;
  readonly metadata?: JsonObject;
}
export interface ResourceResponse {
  readonly id: Id;
  readonly owner_id: Id;
  readonly kind: ResourceKind;
  readonly entity_id: string;
  readonly project_id: Id | null;
  readonly metadata_json: JsonObject;
  readonly version: number;
}
export interface ResourceLinkCreate {
  readonly from_resource_id: Id;
  readonly to_resource_id: Id;
  readonly relation_type: string;
}
export interface ResourceLinkResponse {
  readonly id: Id;
}
export interface DeleteResponse {
  readonly deleted: boolean;
}

export interface NoteIn {
  readonly knowledge_enabled?: boolean;
  readonly folder?: string | null;
  readonly tags?: readonly string[];
  readonly title: string;
  readonly markdown_body?: string;
  readonly parent_id?: Id | null;
  readonly project_id?: Id | null;
  /** Omit to keep the stored value on update. */
  readonly pinned?: boolean;
}
export interface NoteOut {
  readonly knowledge_enabled?: boolean;
  readonly folder?: string | null;
  readonly tags?: readonly string[];
  /** Absent when talking to a backend that predates the field. */
  readonly pinned?: boolean;
  readonly title: string;
  readonly markdown_body: string;
  readonly parent_id: Id | null;
  readonly project_id: Id | null;
  readonly id: Id;
  readonly version: number;
  // Absent when talking to a backend that predates the field.
  readonly updated_at?: IsoDateTime | null;
}

export interface ReadPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly etag: string;
  readonly not_modified: boolean;
  readonly facets?: Readonly<Record<string, readonly string[]>> | null;
}
export interface NoteRevision {
  readonly id: Id;
  readonly note_id: Id;
  readonly base_version: number;
  readonly revision_no: number;
  readonly body: string;
  readonly source_device_id: Id | null;
  readonly created_at: IsoDateTime;
}

export interface TaskIn {
  readonly title: string;
  readonly description?: string;
  readonly project_id?: Id | null;
  readonly parent_task_id?: Id | null;
  readonly status?: string;
  readonly priority?: number;
  readonly due_at?: IsoDateTime | null;
  readonly due_timezone?: string | null;
  readonly rrule?: string | null;
}
export interface TaskOut {
  readonly started_at?: IsoDateTime | null;
  readonly completed_at?: IsoDateTime | null;
  readonly title: string;
  readonly description: string;
  readonly project_id: Id | null;
  readonly parent_task_id: Id | null;
  readonly status: string;
  readonly priority: number;
  readonly due_at: IsoDateTime | null;
  readonly due_timezone: string | null;
  readonly rrule: string | null;
  readonly id: Id;
  readonly version: number;
}
export interface TaskPatch extends TaskIn { readonly version?: number; }
export interface ReminderIn {
  readonly task_id: Id;
  readonly notify_at: IsoDateTime;
  readonly channel?: string;
  readonly idempotency_key: string;
}
export interface TaskReminder extends ReminderIn {
  readonly id: Id;
  readonly owner_id: Id;
  readonly status?: string;
  readonly reminder_status?: string;
}

export interface EventIn {
  readonly title: string;
  readonly description?: string;
  readonly starts_at: IsoDateTime;
  readonly ends_at: IsoDateTime;
  readonly timezone?: string;
  readonly all_day?: boolean;
  readonly project_id?: Id | null;
  readonly linked_task_id?: Id | null;
  readonly rrule?: string | null;
  readonly reminder_at?: IsoDateTime | null;
}
export interface EventOut {
  readonly external_source?: string | null;
  readonly external_id?: string | null;
  readonly title: string;
  readonly description: string;
  readonly starts_at: IsoDateTime;
  readonly ends_at: IsoDateTime;
  readonly timezone: string;
  readonly all_day: boolean;
  readonly project_id: Id | null;
  readonly linked_task_id: Id | null;
  readonly rrule: string | null;
  readonly id: Id;
  readonly version: number;
}
export interface EventPatch extends EventIn { readonly version: number; }
export interface EventOccurrence extends EventOut {
  readonly occurrence_id: string;
  readonly series_starts_at: IsoDateTime;
  readonly series_ends_at: IsoDateTime;
}
export interface CalendarReminderIn {
  readonly event_id: Id;
  readonly notify_at: IsoDateTime;
  readonly channel?: string;
  readonly idempotency_key: string;
}
export interface CalendarReminder extends CalendarReminderIn {
  readonly id: Id;
  readonly owner_id: Id;
  readonly reminder_status: string;
  readonly version: number;
}
export interface FocusIn {
  readonly task_id?: Id | null;
  readonly project_id?: Id | null;
  readonly started_at: IsoDateTime;
  readonly mode?: string;
}
export interface FocusOut {
  readonly id: Id;
  readonly owner_id: Id;
  readonly task_id: Id | null;
  readonly project_id: Id | null;
  readonly started_at: IsoDateTime;
  readonly mode: string;
  readonly ended_at: IsoDateTime | null;
  readonly elapsed_seconds: number;
  /** "active" | "paused" | "completed" */
  readonly status: string;
  readonly version: number;
  /** Set while status is "paused". */
  readonly paused_at?: IsoDateTime | null;
  /** Accumulated paused time, excluded from elapsed_seconds. */
  readonly paused_seconds?: number;
}

export interface FinanceAccountIn {
  readonly name: string;
  readonly currency: string;
  readonly type?: string;
}
export interface FinanceAccount {
  readonly name: string;
  readonly currency: string;
  readonly type: string;
  readonly id: Id;
  readonly owner_id: Id;
  readonly version: number;
}
export interface FinanceCategoryIn {
  readonly name: string;
  readonly kind?: string;
}
export interface FinanceCategory {
  readonly name: string;
  readonly kind: string;
  readonly id: Id;
  readonly owner_id: Id;
  readonly version: number;
}
export interface FinanceBudgetIn {
  readonly category_id?: Id | null;
  readonly currency: string;
  readonly period_start: IsoDateTime;
  readonly period_end: IsoDateTime;
  readonly limit_amount: DecimalString;
}
export interface FinanceBudget {
  readonly category_id: Id | null;
  readonly currency: string;
  readonly period_start: IsoDateTime;
  readonly period_end: IsoDateTime;
  readonly limit_amount: DecimalString;
  readonly id: Id;
  readonly owner_id: Id;
  readonly version: number;
}
/** Monthly budget upsert; category_id null is the overall budget for the month. */
export interface FinanceBudgetPut {
  readonly category_id?: Id | null;
  readonly currency: string;
  /** YYYY-MM */
  readonly month: string;
  readonly limit_amount: DecimalString;
}
export interface TransactionIn {
  readonly account_id: Id;
  readonly category_id?: Id | null;
  readonly amount: DecimalString;
  readonly currency: string;
  readonly type: string;
  readonly occurred_at: IsoDateTime;
  readonly notes?: string;
  readonly idempotency_key?: string | null;
}
export interface FinanceTransaction {
  readonly account_id: Id;
  readonly category_id: Id | null;
  readonly amount: DecimalString;
  readonly currency: string;
  readonly type: string;
  readonly occurred_at: IsoDateTime;
  readonly notes: string;
  readonly idempotency_key: string | null;
  readonly id: Id;
  readonly owner_id: Id;
  readonly version: number;
  readonly related_transfer_id: Id | null;
  /** Filled by the list endpoint; null when uncategorised. */
  readonly category_name?: string | null;
}
export interface FinanceTransferIn {
  readonly from_account_id: Id;
  readonly to_account_id: Id;
  readonly amount: DecimalString;
  readonly currency: string;
  readonly occurred_at: IsoDateTime;
  readonly notes?: string;
  readonly idempotency_key: string;
}
export interface FinanceTransfer {
  readonly transfer_id: Id;
  readonly debit: FinanceTransaction;
  readonly credit: FinanceTransaction;
}
export interface FinanceSummary {
  readonly total: DecimalString | null;
  readonly count: number;
  readonly currencies: readonly { readonly currency: string; readonly balance: DecimalString; readonly income: DecimalString; readonly expense: DecimalString }[];
}

export interface MailAccountIn {
  readonly provider?: string;
  readonly external_id?: string | null;
}
export interface MailAccount {
  readonly version?: number;
  readonly provider: string;
  readonly external_id: string | null;
  readonly id: Id;
  readonly owner_id: Id;
  readonly connection_status: string;
}
export interface MessageIn {
  readonly account_id?: Id | null;
  readonly thread_id?: string | null;
  readonly sender: string;
  readonly recipients?: readonly string[];
  readonly subject: string;
  readonly body?: string;
  readonly received_at: IsoDateTime;
  readonly sync_origin?: string;
}
export interface MailMessage {
  readonly account_id: Id | null;
  readonly thread_id: string | null;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly body: string;
  /** HTML alternative is returned only by the message detail endpoint. */
  readonly body_html?: string | null;
  readonly received_at: IsoDateTime;
  readonly sync_origin: string;
  readonly id: Id;
  readonly owner_id: Id;
  /** Absent when talking to a backend that predates the field. */
  readonly is_read?: boolean;
  readonly version?: number;
}
export interface MailMessageReadIn {
  readonly is_read: boolean;
  readonly version?: number;
}
export interface DraftIn {
  readonly account_id?: Id | null;
  readonly thread_id?: string | null;
  readonly recipients?: readonly string[];
  readonly subject?: string;
  readonly content?: string;
}
export interface MailDraft {
  readonly account_id: Id | null;
  readonly thread_id: string | null;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly content: string;
  readonly id: Id;
  readonly owner_id: Id;
  readonly status: string;
  readonly version: number;
}
export interface DraftPatch extends DraftIn { readonly version: number; }

export interface SearchResult {
  readonly kind?: string;
  readonly resource_type?: string;
  readonly id?: Id;
  readonly resource_id?: Id;
  readonly title: string;
  readonly snippet?: string | null;
  readonly project_id?: Id | null;
}
export interface SearchResponse {
  readonly results: readonly SearchResult[];
}
export interface ActivityEvent {
  readonly id: Id;
  readonly owner_id: Id;
  readonly resource_id: Id | null;
  readonly event_kind: string;
  readonly actor_kind: string;
  readonly actor_id: Id | null;
  readonly occurred_at: IsoDateTime;
  readonly non_sensitive_metadata: JsonObject;
}
export interface HistoryEntry {
  readonly id: Id;
  readonly owner_id: Id;
  readonly resource_id: Id | null;
  readonly action: string;
  readonly actor: string;
  readonly metadata_json: JsonObject;
  readonly created_at: IsoDateTime;
}
export interface NotificationCreate {
  readonly kind: string;
  readonly title: string;
  readonly body?: string | null;
  readonly dedup_key?: string | null;
  readonly data?: JsonObject;
}
export interface Notification extends NotificationCreate {
  readonly id: Id;
  readonly owner_id: Id;
  readonly read_at: IsoDateTime | null;
  readonly data_json: JsonObject;
  readonly created_at: IsoDateTime;
}

export type SyncAction = "create" | "update" | "delete";
export interface SyncOperation {
  readonly operation_id: Id;
  readonly device_id: Id;
  readonly resource_kind: string;
  readonly resource_id: Id;
  readonly action: SyncAction;
  readonly base_version?: number;
  readonly client_timestamp?: IsoDateTime | null;
  readonly patch?: JsonObject;
}
export interface SyncPushRequest {
  readonly device_id: Id;
  readonly operations: readonly SyncOperation[];
}
export interface SyncReceipt {
  readonly operation_id: Id;
  readonly status: string;
  readonly version?: number | null;
  readonly cursor?: string | null;
  readonly conflict?: JsonObject | null;
}
export interface SyncPushResponse {
  readonly results: readonly SyncReceipt[];
  readonly server_cursor: string;
}
export interface SyncChange {
  readonly seq: number;
  readonly resource_kind: string;
  readonly resource_id: Id;
  readonly version: number;
  readonly operation: SyncAction;
  readonly payload: JsonObject;
}
export interface SyncPullResponse {
  readonly changes: readonly SyncChange[];
  readonly next_cursor: string;
  readonly has_more: boolean;
}
export interface SyncStatusResponse {
  readonly latest_cursor: string;
  readonly acknowledged_cursor: string;
  readonly acknowledged_seq: number;
  readonly compaction_watermark: number;
}
export interface SyncAckRequest {
  readonly device_id: Id;
  readonly cursor: string;
}
export interface SyncAckResponse {
  readonly device_id: Id;
  readonly acknowledged_seq: number;
  readonly acknowledged_cursor: string;
  readonly compaction_watermark: number;
}
export interface SyncBootstrapResource {
  readonly resource_kind: string;
  readonly resource_id: Id;
  readonly version: number;
  readonly payload: JsonObject;
  readonly deleted: boolean;
}
export interface SyncBootstrapResponse {
  readonly snapshot_watermark: string;
  readonly cursor: string;
  readonly resources: readonly SyncBootstrapResource[];
  readonly next_page_token: string | null;
  readonly has_more: boolean;
}

export type MemoryFactKind = "preference" | "fact" | "goal" | "context";
export interface MemoryFactIn { readonly text: string; readonly kind?: MemoryFactKind; readonly expires_at?: IsoDateTime | null; }
export interface MemoryFactPatch { readonly version: number; readonly text?: string; readonly kind?: MemoryFactKind; readonly expires_at?: IsoDateTime | null; }
export interface OwnerMemoryFact extends MemoryFactIn {
  readonly id: Id; readonly owner_id: Id; readonly version: number; readonly kind: MemoryFactKind;
  readonly source: string; readonly source_message_id: string | null; readonly expires_at: IsoDateTime | null;
  readonly created_at: IsoDateTime; readonly updated_at: IsoDateTime;
}

export type AIProviderKind = "claude" | "openrouter" | "transcription";
export interface ProviderIn {
  readonly kind: AIProviderKind;
  readonly base_url?: string | null;
  readonly enabled?: boolean;
  readonly model_policy?: JsonObject;
  readonly secret_ref?: string | null;
}
/** Which provider and model each AI feature uses; a missing feature falls back to the oldest ready provider. */
export type AIFeature = "chat" | "english" | "automation" | "transcription";
export interface AIFeatureChoice { readonly provider_id: Id; readonly model?: string | null }
export type AIFeatureDefaults = { readonly [K in AIFeature]?: AIFeatureChoice | null };
export interface AIProvider extends ProviderIn {
  readonly id: Id;
  readonly enabled: boolean;
  readonly model_policy?: JsonObject;
  readonly has_secret?: boolean;
}
export interface ProviderPatch { readonly enabled?: boolean; readonly model_policy?: JsonObject; }
export interface ProviderProbe { readonly connected: boolean; readonly code: string; }
export interface SecretIn { readonly api_key: string; }
export interface ConversationIn {
  readonly knowledge?: KnowledgeScope;
  readonly project_id?: Id | null;
  readonly title?: string;
}
/** Read scopes a chat can grant to Aelys (stored in tool_scope_json.scopes). */
export type AIReadScope = "tasks.read" | "calendar.read" | "notes.read" | "knowledge.read";
export interface AIUsage { readonly input_tokens: number; readonly output_tokens: number; readonly estimated_cost: number | string }
export interface AICapabilities { readonly conversation_create_idempotency: boolean }
export interface AIConversation extends ConversationIn {
  readonly tool_scope_json?: { readonly scopes?: readonly string[]; readonly knowledge?: KnowledgeScope };
  readonly id: Id;
  readonly owner_id: Id;
  readonly version: number;
  readonly pinned?: boolean;
  readonly updated_at?: IsoDateTime;
  readonly preview?: string;
  readonly usage?: AIUsage;
}
export interface ConversationPatch { readonly pinned?: boolean; readonly title?: string; readonly scopes?: readonly string[] }
export type AIMessageRole = "user" | "assistant" | "system" | "tool";
export interface AIMessageIn {
  readonly role: AIMessageRole;
  readonly content: string;
  readonly source_refs?: readonly JsonObject[];
}
export type AIFeedback = "up" | "down" | null;
/** A tool step the agent took for an answer, kept so it still shows after a reload. */
export interface AIRunStep { readonly id: string; readonly label: string; readonly detail?: string; readonly source?: string }
export interface AIMessage extends AIMessageIn {
  readonly source_refs_json?: readonly KnowledgeSource[];
  readonly steps?: readonly AIRunStep[];
  readonly attachments?: readonly { readonly name: string; readonly size: number }[];
  readonly feedback?: AIFeedback;
  readonly id: Id;
  readonly conversation_id: Id;
  readonly created_at: IsoDateTime;
}
export interface KnowledgeScope {
  readonly note_ids?: readonly Id[];
  readonly project_id?: Id | null;
}
export interface KnowledgeSource {
  readonly label: string;
  readonly note_id: Id;
  readonly title: string;
  readonly version: number;
  readonly heading: string;
  readonly start: number;
  readonly end: number;
  readonly excerpt: string;
}
export type AIRoutingEffort = "low" | "medium" | "high";
export type RoutingInput = JsonObject & { readonly provider_id?: string; readonly provider?: string; readonly model?: string; readonly effort?: AIRoutingEffort };
export interface AIRunIn {
  readonly knowledge?: KnowledgeScope;
  readonly conversation_id: Id;
  readonly message: string;
  readonly routing?: RoutingInput;
  readonly tool_scope?: JsonObject;
  readonly attachment_ids?: readonly Id[];
  readonly idempotency_key: string;
}
export interface AIAttachmentIn { readonly name: string; readonly content_base64: string }
export interface AIAttachment { readonly id: Id; readonly name: string; readonly size: number; readonly chars: number }
export interface AIActionItem { readonly title: string; readonly detail?: string; readonly meta?: string }
export type AIActionStatus = "pending" | "approved" | "rejected" | "failed";
/** A change Aelys proposed and will only apply once the owner approves it. */
export interface AIAction {
  readonly id: Id;
  readonly tool: string;
  readonly title: string;
  readonly summary: string;
  readonly items: readonly AIActionItem[];
  readonly status: AIActionStatus;
  readonly result?: unknown;
  /** The answer the proposal belongs to (older runs point at the prompt instead). */
  readonly message_id?: Id | null;
}
export interface AIRun {
  readonly id: Id;
  readonly owner_id: Id;
  readonly conversation_id: Id;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly idempotency_key: string | null;
  readonly token_counts: JsonObject;
  readonly cost_estimate: DecimalString;
  readonly started_at: IsoDateTime | null;
  readonly completed_at: IsoDateTime | null;
}
export interface AIProviderSecretResponse {
  readonly stored: boolean;
  readonly provider_id: Id;
  readonly last_four: string;
}

export type AgentAdapter = "claude_code" | "codex_cli";
export interface AgentRunIn {
  readonly device_id: Id;
  readonly project_id: Id;
  readonly adapter: AgentAdapter;
  readonly task: string;
  readonly policy_id: Id;
  readonly idempotency_key: string;
}
export interface AgentDevice extends DeviceResponse {}
export interface AgentSession {
  readonly id: Id;
  readonly owner_id: Id;
  readonly device_id: Id;
  readonly project_id: Id | null;
  readonly adapter: AgentAdapter | string;
  readonly opaque_local_session_ref: string;
  readonly started_at: IsoDateTime | null;
  readonly last_activity_at: IsoDateTime | null;
  readonly message_count: number | null;
  readonly state: string;
  /** Display-only metadata reported by the Mac; absent/null for older runtimes. */
  readonly workspace_path?: string | null;
  readonly sandbox?: string | null;
  readonly network?: AgentNetworkMode | null;
  /** Metadata-only timeline (max 200, redacted); never transcripts. */
  readonly events?: readonly AgentSessionEvent[];
}
export type AgentNetworkMode = "blocked" | "allowlist" | "open";
export interface AgentSessionEvent {
  readonly kind: string;
  readonly message: string;
  readonly at: IsoDateTime;
}
export interface AgentSessionStopResponse {
  readonly session_id: Id;
  readonly status: "stop_requested";
  readonly run_ids: readonly Id[];
}
export interface SessionSearch {
  readonly query: string;
  readonly project_id?: Id | null;
  readonly limit?: number;
}
export interface SessionSearchResponse {
  readonly status: string;
  readonly results: readonly JsonObject[];
}
export interface AgentRun extends AgentRunIn {
  readonly id: Id;
  readonly owner_id: Id;
  readonly status: string;
  readonly lease_id: Id | null;
  readonly lease_until: IsoDateTime | null;
  readonly cancellation_requested: boolean;
  readonly error_code: string | null;
  readonly result_metadata_json: JsonObject;
}
export interface CredentialLeaseIn {
  readonly run_id: Id;
  readonly device_id: Id;
  readonly project_id: Id;
  readonly grant_id: Id;
  readonly provider: "claude_api_key" | "open_ai_api_key";
}
export interface CredentialLeaseResponse {
  readonly lease_id: Id;
  readonly run_id: Id;
  readonly device_id: Id;
  readonly project_id: Id;
  readonly grant_id: Id;
  readonly provider: string;
  readonly issued_at: IsoDateTime;
  readonly expires_at: IsoDateTime;
  readonly signed_payload: string;
  readonly signature: readonly number[];
  readonly backend_public_key: readonly number[];
}

export interface AutomationRuleIn {
  readonly name: string;
  readonly trigger_kind: string;
  readonly conditions?: JsonObject;
  readonly actions?: readonly JsonObject[];
  readonly policy_ref: string;
  readonly rate_limit?: JsonObject;
  readonly enabled?: boolean;
  /** Send true when creating from a reviewed /automations/draft proposal: policy is then enforced at creation. */
  readonly reviewed_draft?: boolean;
}
export interface AutomationDraftIn {
  /** Provide exactly one of description or rule. */
  readonly description?: string;
  readonly rule?: AutomationRuleIn;
}
export interface AutomationDraft {
  readonly source: "structured" | "ai" | "parser";
  /** Proposed rule; never saved by the draft call. */
  readonly rule: AutomationRuleIn & { readonly conditions: JsonObject; readonly actions: readonly JsonObject[]; readonly rate_limit: JsonObject; readonly enabled: boolean };
  readonly policy: {
    readonly policy_ref: string;
    readonly registered: boolean;
    readonly allowed: boolean;
    readonly issues: readonly string[];
  };
  readonly saved: false;
}
export type AutomationRunStatus = "success" | "skipped" | "blocked_by_policy" | "failed" | "running";
export interface AutomationRun {
  readonly id: Id;
  readonly rule_id: Id;
  readonly rule_name: string;
  readonly event_id: string;
  readonly status: AutomationRunStatus;
  readonly error_code: string | null;
  readonly attempt: number;
  readonly started_at: IsoDateTime;
  readonly finished_at: IsoDateTime | null;
}
export interface AutomationRule extends AutomationRuleIn {
  readonly id: Id;
  readonly owner_id: Id;
}
export interface AutomationEventIn {
  readonly event_id: Id;
  readonly event_kind: string;
  readonly payload?: JsonObject;
}
export interface AutomationExecution {
  readonly id: Id;
  readonly rule_id: Id;
  readonly event_id: Id;
  readonly run_status: string;
  readonly attempt: number;
  readonly started_at: IsoDateTime;
  readonly finished_at: IsoDateTime | null;
  readonly error_code: string | null;
}
export interface AutomationDryRunResponse {
  readonly rule_id: Id;
  readonly event_id: Id;
  readonly would_execute: boolean;
  readonly actions: readonly JsonObject[];
}
export interface AutomationDispatchResponse {
  readonly event_id: Id;
  readonly results: readonly JsonObject[];
}

export interface SSEEvent<T = JsonObject> {
  readonly event: string;
  readonly data: T;
  readonly id?: string;
}

/** Separate readonly primary calendar connection; tokens never leave the server. */
export interface GoogleCalendarStatus {
  readonly configured: boolean;
  readonly connection: { readonly id: Id; readonly version: number; readonly calendar_id: string;
    readonly status: 'connected' | 'error' | 'disconnected'; readonly last_synced_at: IsoDateTime | null;
    readonly last_error_code: string | null } | null;
}
export interface GoogleCalendarSync { readonly imported: number; readonly deleted: number; readonly full_sync: boolean; }

/** English daily module. Dates are YYYY-MM-DD in the client's local calendar. */
export interface EnglishWord {
  readonly id: Id;
  readonly lemma: string;
  readonly part_of_speech: string;
  readonly ipa: string;
  readonly definition_en: string;
  readonly translation_ru: string;
  readonly example: string;
  readonly collocations: readonly string[];
  readonly false_friend_ru: string;
  /** Leitner box 1..6. */
  readonly box: number;
  readonly due_on: string;
  readonly introduced_on: string;
  readonly lapses: number;
}
export type EnglishErrorType = 'tense' | 'article' | 'preposition' | 'collocation' | 'word_choice' | 'word_order' | 'spelling' | 'grammar' | 'punctuation' | 'other';
export interface EnglishCorrection {
  readonly corrected_text: string;
  readonly cefr_estimate: { readonly level: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2'; readonly rationale: string };
  readonly target_words: readonly { readonly word: string; readonly used_correctly: boolean; readonly note: string }[];
  readonly errors: readonly { readonly original: string; readonly correction: string; readonly type: EnglishErrorType; readonly explanation_ru: string; readonly severity: 'minor' | 'major' }[];
  readonly strengths: readonly string[];
  readonly summary_ru: string;
  readonly tomorrow_tasks: readonly { readonly title: string; readonly time: string | null }[];
  readonly topics: readonly string[];
  /** Course writing: "journal" evening report (default) or IELTS "task2" essay. */
  readonly kind?: 'journal' | 'task2';
  /** Task 2 only. Approximate bands such as "≈6.0". */
  readonly criteria?: { readonly task_response: string; readonly coherence: string; readonly lexical: string; readonly grammar: string };
}
export interface EnglishSettings {
  readonly reminder_enabled: boolean;
  /** Local HH:MM. */
  readonly reminder_time: string;
  /** IANA timezone, e.g. Asia/Almaty. */
  readonly timezone: string;
}
export interface EnglishReport {
  readonly id: Id;
  readonly day: string;
  readonly text: string;
  readonly cefr: string;
  readonly result: EnglishCorrection;
  readonly created_at: IsoDateTime;
  readonly updated_at: IsoDateTime;
}
export interface EnglishToday {
  readonly day: string;
  readonly new_words: readonly EnglishWord[];
  readonly due_words: readonly EnglishWord[];
  readonly report: EnglishReport | null;
  readonly stats: { readonly total: number; readonly mastered: number; readonly streak: number };
}

/** English IELTS course. Bands are strings such as "6.5"; AI estimates are prefixed "≈". */
export type EnglishSkill = 'listening' | 'reading' | 'writing' | 'speaking';
export type EnglishGoal = 'ielts_academic' | 'ielts_general' | 'conversation';
export type EnglishLevel = 'b1' | 'b1b2' | 'b2' | 'test';
export type EnglishBlockKey = 'warmup' | 'vocab' | 'grammar' | 'reading' | 'listening' | 'speaking' | 'writing';
export interface EnglishProfile {
  readonly goal: EnglishGoal;
  readonly target_band: string;
  readonly level: EnglishLevel;
  readonly weak_skills: readonly EnglishSkill[];
  readonly minutes_per_day: 60 | 120 | 180;
  readonly exam_date: string | null;
  readonly course_started_on?: string | null;
}
export interface EnglishCourse {
  readonly profile: EnglishProfile;
  readonly week: number;
  readonly lesson_no: number;
  readonly days_to_exam: number | null;
  readonly hours_done: number;
  readonly hours_target: number;
  readonly plan: readonly { readonly week: number; readonly theme: string; readonly grammar: string; readonly status: 'done' | 'now' | 'next' }[];
  readonly skills: readonly { readonly skill: EnglishSkill; readonly band: string | null; readonly trend: string | null }[];
  readonly adaptations: readonly { readonly skill: string; readonly icon: string; readonly title: string; readonly detail: string }[];
  readonly week_stats: { readonly speaking_rounds: number; readonly new_words: number; readonly listening_pct: number | null; readonly streak: number };
  readonly mock_due: boolean;
  readonly today: { readonly id: Id | null; readonly blocks: readonly { readonly key: EnglishBlockKey; readonly title: string; readonly minutes: number; readonly done: boolean }[] };
}
export interface EnglishLessonContent {
  readonly theme: string;
  readonly grammar_focus: string;
  readonly blocks: readonly { readonly key: EnglishBlockKey; readonly title: string; readonly minutes: number }[];
  /** Mini gap-fill practice for the learner's recurring writing mistake type; null when there is none. */
  readonly drill?: { readonly type: EnglishErrorType; readonly items: readonly { readonly before: string; readonly after: string; readonly answer: string }[] } | null;
  /** Hand-written blocks; absent on lessons made before they existed. Answers come only from the check. */
  readonly grammar?: EnglishGrammarLesson;
  readonly reading?: EnglishReadingPassage;
  readonly warmup: readonly { readonly word_id: Id; readonly before: string; readonly answer: string; readonly after: string; readonly hint_ru: string }[];
  /** vocab, listening, speaking and writing are AI-generated and absent when no AI provider is connected. */
  readonly vocab?: readonly { readonly word_id: Id; readonly lemma: string; readonly ipa: string; readonly part_of_speech: string; readonly translation_ru: string; readonly definition_en: string; readonly example: string; readonly collocations: readonly string[] }[];
  readonly listening?: {
    readonly title: string;
    /** Whether the learner was already graded; the script is only meaningful then. */
    readonly script_visible: boolean;
    /** Speech synthesis rate chosen server-side (0.9 for learners who miss many answers). */
    readonly tts_rate: number;
    readonly live: { readonly source: string; readonly url: string; readonly hint_ru: string };
    readonly script: readonly { readonly speaker: 'A' | 'B'; readonly text: string }[];
    /** `answer` is absent until the block is checked. */
    readonly questions: readonly { readonly n: number; readonly before: string; readonly after: string; readonly answer?: string }[];
    readonly connected_speech: readonly { readonly phrase: string; readonly sounds_like: string; readonly note_ru: string }[];
  };
  readonly speaking?: { readonly part2: { readonly topic: string; readonly bullets: readonly string[] }; readonly part3: readonly string[]; readonly phrases: readonly string[] };
  readonly writing?: { readonly kind: 'journal' | 'task2'; readonly prompt: string | null };
}
export interface EnglishTask { readonly type: 'gap' | 'choice' | 'fix' | 'tfng' | 'mcq' | 'heading'; readonly prompt: string; readonly options: readonly string[] | null; readonly skill?: string | null; readonly about_figure?: boolean }
export type EnglishTone = 'blue' | 'orange' | 'purple' | 'green';
export interface EnglishFormula { readonly title: string; readonly when_ru: string; readonly tone: EnglishTone; readonly rows: readonly (readonly { readonly t: string; readonly role: 'subject' | 'verb' | 'aux' | 'ending' | 'word' }[])[]; readonly example_en: string; readonly example_ru: string; readonly markers: readonly string[] }
/** Axis from -1 (past) through 0 (now) to 1 (future). */
export interface EnglishTimelineItem { readonly label: string; readonly kind: 'repeat' | 'point' | 'span'; readonly at?: number | null; readonly start?: number | null; readonly end?: number | null; readonly caption_en: string }
export interface EnglishGrammarLesson {
  readonly id: string; readonly title: string; readonly rule_ru: readonly string[]; readonly examples: readonly { readonly en: string; readonly ru: string }[]; readonly exercises: readonly EnglishTask[];
  /** Visual explanation; empty on lessons written before it existed. */
  readonly formulas?: readonly EnglishFormula[];
  readonly timeline?: { readonly title_ru: string; readonly items: readonly EnglishTimelineItem[] } | null;
  readonly table?: { readonly title_ru: string; readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] } | null;
  readonly traps?: readonly { readonly wrong: string; readonly right: string; readonly note_ru: string }[];
  readonly chips?: { readonly title_ru: string; readonly items: readonly { readonly en: string; readonly example: string; readonly ru: string }[] } | null;
}
export interface EnglishFigure { readonly kind: 'bar' | 'line'; readonly title: string; readonly unit: string; readonly labels: readonly string[]; readonly series: readonly { readonly name: string; readonly values: readonly number[] }[] }
export interface EnglishReadingPassage {
  readonly id: string; readonly title: string; readonly paragraphs: readonly { readonly label: string; readonly text: string }[]; readonly questions: readonly EnglishTask[];
  readonly figure?: EnglishFigure | null;
  readonly glossary?: readonly { readonly word: string; readonly ru: string }[];
}
export interface EnglishTaskResult { readonly n: number; readonly given: string; readonly answer: string; readonly ok: boolean; readonly explain_ru: string; readonly evidence?: string | null }
/** Items are graded once each; `done` once every item is answered. */
export interface EnglishTasksResult { readonly score: number; readonly total: number; readonly results: readonly EnglishTaskResult[]; readonly done: boolean }
export interface EnglishSpeakingRound {
  readonly round: 4 | 3 | 2;
  readonly criteria: { readonly fluency: string; readonly lexical: string; readonly grammar: string };
  readonly corrected_html_safe: readonly { readonly type: 'same' | 'del' | 'ins'; readonly text: string }[];
  readonly tips: readonly { readonly kind: 'timing' | 'vocab' | 'good'; readonly title_ru: string; readonly detail_ru: string }[];
  readonly pauses: number;
  readonly linkers_used: number;
}
/** A round as stored in progress: older rows lack the corrected text, tips and duration. */
export type EnglishStoredSpeakingRound = Pick<EnglishSpeakingRound, 'round' | 'criteria' | 'pauses' | 'linkers_used'>
  & Partial<Pick<EnglishSpeakingRound, 'corrected_html_safe' | 'tips'>> & { readonly duration_sec?: number };
export interface EnglishBlockProgress {
  readonly done?: boolean;
  readonly minutes?: number;
  readonly score?: number;
  readonly total?: number;
  /** Speaking: stored round results, keyed by round length in minutes. */
  readonly rounds?: Readonly<Record<string, EnglishStoredSpeakingRound>>;
  /** Listening: graded answers, kept so a reloaded lesson shows what was typed. */
  readonly results?: EnglishListeningResult['results'] | EnglishTasksResult['results'];
  readonly feedback_ru?: string;
}
export interface EnglishLesson {
  readonly id: Id;
  readonly day: string;
  readonly lesson_no: number;
  readonly week: number;
  readonly theme: string;
  readonly content: EnglishLessonContent;
  readonly progress: Partial<Record<EnglishBlockKey, EnglishBlockProgress>>;
}
export interface EnglishSentenceResult { readonly word_id: Id; readonly ok: boolean; readonly title_ru: string; readonly detail_ru: string; readonly corrected: string | null }
export interface EnglishListeningResult {
  readonly score: number;
  readonly total: number;
  readonly results: readonly { readonly n: number; readonly given: string; readonly answer: string; readonly ok: boolean }[];
  readonly feedback_ru: string;
}
export interface EnglishSpeakingIn { readonly round: 4 | 3 | 2; readonly transcript: string; readonly duration_sec: number; readonly pause_count?: number }
export interface EnglishTranscription { readonly text: string; readonly duration_sec: number | null }
export interface EnglishMockIn {
  readonly day: string;
  readonly listening?: string | null; readonly reading?: string | null; readonly writing?: string | null; readonly speaking?: string | null;
  readonly note?: string;
}
export interface EnglishMock { readonly id: Id; readonly day: string; readonly listening: string | null; readonly reading: string | null; readonly writing: string | null; readonly speaking: string | null; readonly note: string }
