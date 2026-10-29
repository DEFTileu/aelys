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
  readonly title: string;
  readonly markdown_body?: string;
  readonly parent_id?: Id | null;
  readonly project_id?: Id | null;
}
export interface NoteOut {
  readonly title: string;
  readonly markdown_body: string;
  readonly parent_id: Id | null;
  readonly project_id: Id | null;
  readonly id: Id;
  readonly version: number;
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
}
export interface EventOut {
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
  readonly status: string;
  readonly version: number;
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
  readonly total: DecimalString;
  readonly count: number;
}

export interface MailAccountIn {
  readonly provider?: string;
  readonly external_id?: string | null;
}
export interface MailAccount {
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
  readonly received_at: IsoDateTime;
  readonly sync_origin: string;
  readonly id: Id;
  readonly owner_id: Id;
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

export type AIProviderKind = "claude" | "openrouter";
export interface ProviderIn {
  readonly kind: AIProviderKind;
  readonly base_url?: string | null;
  readonly enabled?: boolean;
  readonly model_policy?: JsonObject;
  readonly secret_ref?: string | null;
}
export interface AIProvider extends ProviderIn {
  readonly id: Id;
  readonly enabled: boolean;
  readonly model_policy?: JsonObject;
}
export interface SecretIn { readonly api_key: string; }
export interface ConversationIn {
  readonly project_id?: Id | null;
  readonly title?: string;
}
export interface AIConversation extends ConversationIn {
  readonly id: Id;
  readonly owner_id: Id;
  readonly version: number;
}
export type AIMessageRole = "user" | "assistant" | "system" | "tool";
export interface AIMessageIn {
  readonly role: AIMessageRole;
  readonly content: string;
  readonly source_refs?: readonly JsonObject[];
}
export interface AIMessage extends AIMessageIn {
  readonly id: Id;
  readonly conversation_id: Id;
  readonly created_at: IsoDateTime;
}
export interface AIRunIn {
  readonly conversation_id: Id;
  readonly message: string;
  readonly routing?: JsonObject;
  readonly tool_scope?: JsonObject;
  readonly idempotency_key: string;
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
