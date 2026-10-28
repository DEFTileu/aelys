import type {
  ActivityEvent, AgentDevice, AgentRun, AgentRunIn, AIConversation, AIMessage, AIMessageIn, AIProvider, AIProviderSecretResponse,
  AIRun, AIRunIn, AutomationDispatchResponse, AutomationDryRunResponse, AutomationEventIn, AutomationExecution, AutomationRule,
  AutomationRuleIn, CredentialLeaseIn, CredentialLeaseResponse, ConversationIn, DeleteResponse, DeviceEnroll, DeviceEnrollmentResponse,
  DeviceResponse, DraftIn, EventIn, EventOut, FinanceAccount, FinanceAccountIn, FinanceBudget, FinanceBudgetIn, FinanceCategory,
  FinanceCategoryIn, FinanceSummary, FinanceTransaction, FocusIn, FocusOut, HistoryEntry, JsonObject, LoginRequest, MailAccount,
  MailAccountIn, MailDraft, MailMessage, MeResponse, MessageIn, NoteIn, NoteOut, NoteRevision, Notification, NotificationCreate,
  ProjectCreate, ProjectGrantCreate, ProjectGrantResponse, ProjectPatch, ProjectResponse, ProviderIn, RefreshRequest, ReminderIn,
  ResourceCreate, ResourceLinkCreate, ResourceLinkResponse, ResourceResponse, RevokeResponse, SearchResponse, SessionSearch, SessionSearchResponse, AgentSession,
  SyncAckRequest, SyncAckResponse, SyncBootstrapResponse, SyncPullResponse, SyncPushRequest, SyncPushResponse, SyncStatusResponse,
  TaskIn, TaskOut, TaskReminder, TokenResponse, TransactionIn, Id,
} from "./types";
import type { EntityKey, EntityStore, OfflineStore, OutboxRequest } from "./offline";

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Readonly<Record<string, QueryValue>>;
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
  readonly method?: HttpMethod;
  readonly query?: Query;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  readonly cacheKey?: string;
  readonly cacheTtlMs?: number;
  readonly queueOnOffline?: boolean;
  /** Persist this optimistic entity together with the offline outbox entry. */
  readonly offlineEntityKey?: EntityKey;
  readonly offlineEntityValue?: unknown;
  readonly signal?: AbortSignal;
}
export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly getToken?: () => string | undefined | Promise<string | undefined>;
  readonly fetch?: typeof fetch;
  readonly offlineStore?: OfflineStore;
  readonly timeoutMs?: number;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: JsonObject;
  public readonly requestId: string | undefined;

  public constructor(status: number, code: string, message: string, details: JsonObject = {}, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export class NetworkError extends Error {
  public constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

export class OfflineQueuedError extends NetworkError {
  public constructor(public readonly entryId: string, public readonly request: OutboxRequest) {
    super(`Request queued for offline replay: ${entryId}`);
    this.name = "OfflineQueuedError";
  }
}

function makeIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `aelys-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isEntityStore(store: OfflineStore | undefined): store is OfflineStore & EntityStore {
  return typeof store !== "undefined" && typeof (store as Partial<EntityStore>).setEntityAndEnqueue === "function";
}

function encodeQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value));
  const result = params.toString();
  return result ? `?${result}` : "";
}

function responseBody(value: unknown): { code: string; message: string; details: JsonObject; requestId?: string } {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const envelope = record.error;
    if (typeof envelope === "object" && envelope !== null) {
      const error = envelope as Record<string, unknown>;
      return {
        code: typeof error.code === "string" ? error.code : "HTTP_ERROR",
        message: typeof error.message === "string" ? error.message : "Request failed",
        details: typeof error.details === "object" && error.details !== null ? error.details as JsonObject : {},
        requestId: typeof record.request_id === "string" ? record.request_id : undefined,
      };
    }
    const detail = record.detail;
    if (typeof detail === "object" && detail !== null) {
      const item = detail as Record<string, unknown>;
      return { code: typeof item.code === "string" ? item.code : "HTTP_ERROR", message: typeof item.message === "string" ? item.message : "Request failed", details: typeof item.details === "object" && item.details !== null ? item.details as JsonObject : {} };
    }
  }
  return { code: "HTTP_ERROR", message: "Request failed", details: {} };
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly offlineStore: OfflineStore | undefined;
  private readonly getTokenValue: (() => string | undefined | Promise<string | undefined>) | undefined;
  private readonly timeoutMs: number;
  private tokenValue: string | undefined;

  public constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("fetch is not available in this runtime");
    this.offlineStore = options.offlineStore;
    this.getTokenValue = options.getToken;
    this.tokenValue = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  public setToken(token: string | undefined): void { this.tokenValue = token; }
  public getToken(): string | undefined { return this.tokenValue; }

  public async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) throw new Error("API path must start with '/'");
    const method = options.method ?? "GET";
    const queryString = encodeQuery(options.query);
    const url = `${this.baseUrl}${path}${queryString}`;
    const token = this.getTokenValue ? await this.getTokenValue() : this.tokenValue;
    const safeHeaders: Record<string, string> = { ...options.headers };
    delete safeHeaders.Authorization;
    delete safeHeaders.authorization;
    const headers: Record<string, string> = { Accept: "application/json", ...safeHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const idempotencyKey = method === "GET" ? options.idempotencyKey : options.idempotencyKey ?? makeIdempotencyKey();
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options.signal;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImpl(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: controller.signal });
      return await this.parseResponse<T>(response, options.cacheKey, options.cacheTtlMs);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const networkError = error instanceof NetworkError ? error : new NetworkError("Network request failed", error);
      if (method === "GET" && options.cacheKey && this.offlineStore) {
        const cached = await this.offlineStore.getCache<T>(options.cacheKey);
        if (cached !== undefined) return cached;
      }
      if (method !== "GET" && options.queueOnOffline !== false && this.offlineStore) {
        const request: OutboxRequest = { method, path, query: options.query, headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined, body: options.body, idempotencyKey: idempotencyKey ?? makeIdempotencyKey() };
        const entry = options.offlineEntityKey && isEntityStore(this.offlineStore)
          ? (await this.offlineStore.setEntityAndEnqueue(options.offlineEntityKey, options.offlineEntityValue ?? options.body, request)).outbox
          : await this.offlineStore.enqueue(request);
        throw new OfflineQueuedError(entry.id, entry.request);
      }
      throw networkError;
    } finally {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async parseResponse<T>(response: Response, cacheKey?: string, cacheTtlMs?: number): Promise<T> {
    const requestId = response.headers.get("X-Request-ID") ?? undefined;
    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try { body = JSON.parse(text) as unknown; } catch { body = undefined; }
    }
    if (!response.ok) {
      const parsed = responseBody(body);
      throw new ApiError(response.status, parsed.code, parsed.message, parsed.details, parsed.requestId ?? requestId);
    }
    const value = (body === undefined ? undefined : body) as T;
    if (cacheKey && this.offlineStore && response.ok) await this.offlineStore.setCache(cacheKey, value, cacheTtlMs);
    return value;
  }

  public async replayOutbox(): Promise<{ readonly applied: number; readonly retained: number }> {
    if (!this.offlineStore) return { applied: 0, retained: 0 };
    const entries = await this.offlineStore.listOutbox();
    let applied = 0;
    let retained = 0;
    for (const entry of entries) {
      try {
        await this.request<unknown>(entry.request.path, { method: entry.request.method as HttpMethod, query: entry.request.query, body: entry.request.body, headers: entry.request.headers, idempotencyKey: entry.request.idempotencyKey, queueOnOffline: false });
        await this.offlineStore.removeOutbox(entry.id);
        applied += 1;
      } catch (error) {
        if (error instanceof NetworkError) {
          retained += 1;
          await this.offlineStore.updateOutbox(entry.id, { attempts: entry.attempts + 1, nextAttemptAt: Date.now() + Math.min(300_000, 2 ** Math.min(entry.attempts, 8) * 1_000) });
          break;
        }
        await this.offlineStore.removeOutbox(entry.id);
      }
    }
    return { applied, retained };
  }

  public login(body: LoginRequest, options?: RequestOptions) { return this.request<TokenResponse>("/api/v1/auth/login", this.write(body, { ...options, queueOnOffline: false })); }
  public refresh(body: RefreshRequest, options?: RequestOptions) { return this.request<TokenResponse>("/api/v1/auth/refresh", this.write(body, { ...options, queueOnOffline: false })); }
  public logout(options?: RequestOptions) { return this.request<{ readonly logged_out: boolean }>("/api/v1/auth/logout", this.write(undefined, { ...options, queueOnOffline: false })); }
  public me(options?: RequestOptions) { return this.request<MeResponse>("/api/v1/me", this.read(options)); }
  public devices(options?: RequestOptions) { return this.request<readonly DeviceResponse[]>("/api/v1/devices", this.read(options)); }
  public enrollDevice(body: DeviceEnroll, options?: RequestOptions) { return this.request<DeviceEnrollmentResponse>("/api/v1/devices/enroll", this.write(body, options)); }
  public revokeDevice(deviceId: Id, options?: RequestOptions) { return this.request<RevokeResponse>(`/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`, this.write(undefined, options)); }

  public projects(options?: RequestOptions) { return this.request<readonly ProjectResponse[]>("/api/v1/projects", this.read(options, "projects")); }
  public createProject(body: ProjectCreate, options?: RequestOptions) { return this.request<ProjectResponse>("/api/v1/projects", this.write(body, options)); }
  public project(projectId: Id, options?: RequestOptions) { return this.request<ProjectResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}`, this.read(options)); }
  public updateProject(projectId: Id, body: ProjectPatch, options?: RequestOptions) { return this.request<ProjectResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}`, this.write(body, options, "PATCH")); }
  public deleteProject(projectId: Id, query?: Query, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}`, this.write(undefined, { ...options, query }, "DELETE")); }
  public createProjectGrant(projectId: Id, body: ProjectGrantCreate, options?: RequestOptions) { return this.request<ProjectGrantResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}/grants`, this.write(body, options)); }
  public revokeProjectGrant(projectId: Id, grantId: Id, options?: RequestOptions) { return this.request<RevokeResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}/grants/${encodeURIComponent(grantId)}/revoke`, this.write(undefined, options)); }
  public projectResources(projectId: Id, options?: RequestOptions) { return this.request<readonly ResourceResponse[]>(`/api/v1/projects/${encodeURIComponent(projectId)}/resources`, this.read(options)); }
  public createResource(body: ResourceCreate, options?: RequestOptions) { return this.request<ResourceResponse>("/api/v1/resources", this.write(body, options)); }
  public createResourceLink(body: ResourceLinkCreate, options?: RequestOptions) { return this.request<ResourceLinkResponse>("/api/v1/resource-links", this.write(body, options)); }
  public deleteResourceLink(linkId: Id, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/resource-links/${encodeURIComponent(linkId)}`, this.write(undefined, options, "DELETE")); }

  public notes(options?: RequestOptions) { return this.request<readonly NoteOut[]>("/api/v1/notes", this.read(options, "notes")); }
  public createNote(body: NoteIn, options?: RequestOptions) { return this.request<NoteOut>("/api/v1/notes", this.write(body, options)); }
  public note(itemId: Id, options?: RequestOptions) { return this.request<NoteOut>(`/api/v1/notes/${encodeURIComponent(itemId)}`, this.read(options)); }
  public updateNote(itemId: Id, body: NoteIn, options?: RequestOptions) { return this.request<NoteOut>(`/api/v1/notes/${encodeURIComponent(itemId)}`, this.write(body, options, "PATCH")); }
  public deleteNote(itemId: Id, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/notes/${encodeURIComponent(itemId)}`, this.write(undefined, options, "DELETE")); }
  public noteRevisions(itemId: Id, options?: RequestOptions) { return this.request<readonly NoteRevision[]>(`/api/v1/notes/${encodeURIComponent(itemId)}/revisions`, this.read(options)); }
  public restoreNote(itemId: Id, options?: RequestOptions) { return this.request<NoteOut>(`/api/v1/notes/${encodeURIComponent(itemId)}/restore`, this.write(undefined, options)); }

  public tasks(query?: Query, options?: RequestOptions) { return this.request<readonly TaskOut[]>("/api/v1/tasks", this.read({ ...options, query }, "tasks")); }
  public createTask(body: TaskIn, options?: RequestOptions) { return this.request<TaskOut>("/api/v1/tasks", this.write(body, options)); }
  public task(itemId: Id, options?: RequestOptions) { return this.request<TaskOut>(`/api/v1/tasks/${encodeURIComponent(itemId)}`, this.read(options)); }
  public updateTask(itemId: Id, body: TaskIn, options?: RequestOptions) { return this.request<TaskOut>(`/api/v1/tasks/${encodeURIComponent(itemId)}`, this.write(body, options, "PATCH")); }
  public deleteTask(itemId: Id, query?: Query, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/tasks/${encodeURIComponent(itemId)}`, this.write(undefined, { ...options, query }, "DELETE")); }
  public taskReminders(taskId: Id, options?: RequestOptions) { return this.request<readonly TaskReminder[]>(`/api/v1/tasks/${encodeURIComponent(taskId)}/reminders`, this.read(options)); }
  public createTaskReminder(taskId: Id, body: ReminderIn, options?: RequestOptions) { return this.request<TaskReminder>(`/api/v1/tasks/${encodeURIComponent(taskId)}/reminders`, this.write(body, options)); }
  public calendarEvents(query?: Query, options?: RequestOptions) { return this.request<readonly EventOut[]>("/api/v1/calendar/events", this.read({ ...options, query }, "calendar-events")); }
  public createCalendarEvent(body: EventIn, options?: RequestOptions) { return this.request<EventOut>("/api/v1/calendar/events", this.write(body, options)); }
  public calendarEvent(itemId: Id, options?: RequestOptions) { return this.request<EventOut>(`/api/v1/calendar/events/${encodeURIComponent(itemId)}`, this.read(options)); }
  public updateCalendarEvent(itemId: Id, body: EventIn, options?: RequestOptions) { return this.request<EventOut>(`/api/v1/calendar/events/${encodeURIComponent(itemId)}`, this.write(body, options, "PATCH")); }
  public deleteCalendarEvent(itemId: Id, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/calendar/events/${encodeURIComponent(itemId)}`, this.write(undefined, options, "DELETE")); }
  public focusSessions(options?: RequestOptions) { return this.request<readonly FocusOut[]>("/api/v1/focus/sessions", this.read(options, "focus-sessions")); }
  public startFocusSession(body: FocusIn, options?: RequestOptions) { return this.request<FocusOut>("/api/v1/focus/sessions", this.write(body, options)); }
  public stopFocusSession(itemId: Id, options?: RequestOptions) { return this.request<FocusOut>(`/api/v1/focus/sessions/${encodeURIComponent(itemId)}/stop`, this.write(undefined, options)); }

  public financeAccounts(options?: RequestOptions) { return this.request<readonly FinanceAccount[]>("/api/v1/finance/accounts", this.read(options, "finance-accounts")); }
  public createFinanceAccount(body: FinanceAccountIn, options?: RequestOptions) { return this.request<FinanceAccount>("/api/v1/finance/accounts", this.write(body, options)); }
  public financeCategories(options?: RequestOptions) { return this.request<readonly FinanceCategory[]>("/api/v1/finance/categories", this.read(options, "finance-categories")); }
  public createFinanceCategory(body: FinanceCategoryIn, options?: RequestOptions) { return this.request<FinanceCategory>("/api/v1/finance/categories", this.write(body, options)); }
  public financeBudgets(options?: RequestOptions) { return this.request<readonly FinanceBudget[]>("/api/v1/finance/budgets", this.read(options, "finance-budgets")); }
  public createFinanceBudget(body: FinanceBudgetIn, options?: RequestOptions) { return this.request<FinanceBudget>("/api/v1/finance/budgets", this.write(body, options)); }
  public financeTransactions(options?: RequestOptions) { return this.request<readonly FinanceTransaction[]>("/api/v1/finance/transactions", this.read(options, "finance-transactions")); }
  public createFinanceTransaction(body: TransactionIn, options?: RequestOptions) { return this.request<FinanceTransaction>("/api/v1/finance/transactions", this.write(body, options)); }
  public financeSummary(options?: RequestOptions) { return this.request<FinanceSummary>("/api/v1/finance/summary", this.read(options, "finance-summary")); }

  public mailAccounts(options?: RequestOptions) { return this.request<readonly MailAccount[]>("/api/v1/mail/accounts", this.read(options, "mail-accounts")); }
  public createMailAccount(body: MailAccountIn, options?: RequestOptions) { return this.request<MailAccount>("/api/v1/mail/accounts", this.write(body, options)); }
  public mailMessages(query?: Query, options?: RequestOptions) { return this.request<readonly MailMessage[]>("/api/v1/mail/messages", this.read({ ...options, query }, "mail-messages")); }
  public importMailMessage(body: MessageIn, options?: RequestOptions) { return this.request<MailMessage>("/api/v1/mail/messages", this.write(body, options)); }
  public mailDrafts(options?: RequestOptions) { return this.request<readonly MailDraft[]>("/api/v1/mail/drafts", this.read(options, "mail-drafts")); }
  public createMailDraft(body: DraftIn, options?: RequestOptions) { return this.request<MailDraft>("/api/v1/mail/drafts", this.write(body, options)); }
  public search(q: string, scope?: string, options?: RequestOptions) { return this.request<SearchResponse>("/api/v1/search", this.read({ ...options, query: { ...options?.query, q, scope } })); }
  public activity(options?: RequestOptions) { return this.request<readonly ActivityEvent[]>("/api/v1/activity", this.read(options, "activity")); }
  public history(options?: RequestOptions) { return this.request<readonly HistoryEntry[]>("/api/v1/history", this.read(options, "history")); }
  public notifications(options?: RequestOptions) { return this.request<readonly Notification[]>("/api/v1/notifications", this.read(options, "notifications")); }
  public createNotification(body: NotificationCreate, options?: RequestOptions) { return this.request<Notification>("/api/v1/notifications", this.write(body, options)); }
  public markNotificationRead(itemId: Id, options?: RequestOptions) { return this.request<Notification>(`/api/v1/notifications/${encodeURIComponent(itemId)}/read`, this.write(undefined, options)); }

  public syncPush(body: SyncPushRequest, options?: RequestOptions) { return this.request<SyncPushResponse>("/api/v1/sync/push", this.write(body, options)); }
  public syncPull(query?: Query, options?: RequestOptions) { return this.request<SyncPullResponse>("/api/v1/sync/pull", this.read({ ...options, query })); }
  public syncStatus(options?: RequestOptions) { return this.request<SyncStatusResponse>("/api/v1/sync/status", this.read(options, "sync-status")); }
  public syncAck(body: SyncAckRequest, options?: RequestOptions) { return this.request<SyncAckResponse>("/api/v1/sync/ack", this.write(body, options)); }
  public syncBootstrap(query?: Query, options?: RequestOptions) { return this.request<SyncBootstrapResponse>("/api/v1/sync/bootstrap", this.read({ ...options, query })); }

  public aiProviders(options?: RequestOptions) { return this.request<readonly AIProvider[]>("/api/v1/ai/providers", this.read(options, "ai-providers")); }
  public createAIProvider(body: ProviderIn, options?: RequestOptions) { return this.request<AIProvider>("/api/v1/ai/providers", this.write(body, options)); }
  public setAIProviderSecret(providerId: Id, body: { readonly api_key: string }, options?: RequestOptions) { return this.request<AIProviderSecretResponse>(`/api/v1/ai/providers/${encodeURIComponent(providerId)}/secret`, this.write(body, { ...options, queueOnOffline: false }, "PUT")); }
  public deleteAIProviderSecret(providerId: Id, options?: RequestOptions) { return this.request<{ readonly deleted: boolean; readonly provider_id: Id }>(`/api/v1/ai/providers/${encodeURIComponent(providerId)}/secret`, this.write(undefined, { ...options, queueOnOffline: false }, "DELETE")); }
  public createAIConversation(body: ConversationIn, options?: RequestOptions) { return this.request<AIConversation>("/api/v1/ai/conversations", this.write(body, options)); }
  public aiMessages(conversationId: Id, options?: RequestOptions) { return this.request<readonly AIMessage[]>(`/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/messages`, this.read(options)); }
  public addAIMessage(conversationId: Id, body: AIMessageIn, options?: RequestOptions) { return this.request<AIMessage>(`/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/messages`, this.write(body, options)); }
  public createAIRun(body: AIRunIn, options?: RequestOptions) { return this.request<AIRun>("/api/v1/ai/runs", this.write(body, options)); }
  public aiRun(runId: Id, options?: RequestOptions) { return this.request<AIRun>(`/api/v1/ai/runs/${encodeURIComponent(runId)}`, this.read(options)); }
  public cancelAIRun(runId: Id, options?: RequestOptions) { return this.request<AIRun>(`/api/v1/ai/runs/${encodeURIComponent(runId)}/cancel`, this.write(undefined, options)); }
  public aiRunEvents(runId: Id, options?: RequestOptions) { return this.eventStream(`/api/v1/ai/runs/${encodeURIComponent(runId)}/events`, options); }

  public agentDevices(options?: RequestOptions) { return this.request<readonly AgentDevice[]>("/api/v1/agents/devices", this.read(options, "agent-devices")); }
  public agentSessions(query?: Query, options?: RequestOptions) { return this.request<readonly AgentSession[]>("/api/v1/agents/sessions", this.read({ ...options, query }, "agent-sessions")); }
  public searchAgentSessions(body: SessionSearch, options?: RequestOptions) { return this.request<SessionSearchResponse>("/api/v1/agents/sessions/search", this.write(body, options)); }
  public createAgentRun(body: AgentRunIn, options?: RequestOptions) { return this.request<AgentRun>("/api/v1/agents/runs", this.write(body, options)); }
  public issueCredentialLease(runId: Id, body: CredentialLeaseIn, options?: RequestOptions) { return this.request<CredentialLeaseResponse>(`/api/v1/agents/runs/${encodeURIComponent(runId)}/credential-lease`, this.write(body, options)); }
  public agentRun(runId: Id, options?: RequestOptions) { return this.request<AgentRun>(`/api/v1/agents/runs/${encodeURIComponent(runId)}`, this.read(options)); }
  public agentRunEvents(runId: Id, options?: RequestOptions) { return this.eventStream(`/api/v1/agents/runs/${encodeURIComponent(runId)}/events`, options); }
  public cancelAgentRun(runId: Id, options?: RequestOptions) { return this.request<AgentRun>(`/api/v1/agents/runs/${encodeURIComponent(runId)}/cancel`, this.write(undefined, options)); }

  public automations(options?: RequestOptions) { return this.request<readonly AutomationRule[]>("/api/v1/automations", this.read(options, "automations")); }
  public createAutomation(body: AutomationRuleIn, options?: RequestOptions) { return this.request<AutomationRule>("/api/v1/automations", this.write(body, options)); }
  public updateAutomation(ruleId: Id, body: JsonObject, options?: RequestOptions) { return this.request<AutomationRule>(`/api/v1/automations/${encodeURIComponent(ruleId)}`, this.write(body, options, "PATCH")); }
  public deleteAutomation(ruleId: Id, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/automations/${encodeURIComponent(ruleId)}`, this.write(undefined, options, "DELETE")); }
  public automationExecutions(ruleId: Id, options?: RequestOptions) { return this.request<readonly AutomationExecution[]>(`/api/v1/automations/${encodeURIComponent(ruleId)}/executions`, this.read(options)); }
  public automationDryRun(ruleId: Id, body: AutomationEventIn, options?: RequestOptions) { return this.request<AutomationDryRunResponse>(`/api/v1/automations/${encodeURIComponent(ruleId)}/dry-run`, this.write(body, options)); }
  public dispatchAutomation(body: AutomationEventIn, options?: RequestOptions) { return this.request<AutomationDispatchResponse>("/api/v1/automations/dispatch", this.write(body, options)); }

  public async eventStream(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? "GET";
    const queryString = encodeQuery(options.query);
    const token = this.getTokenValue ? await this.getTokenValue() : this.tokenValue;
    const headers: Record<string, string> = { Accept: "text/event-stream", ...options.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}${queryString}`, { method, headers, signal: options.signal });
    if (!response.ok) {
      const text = await response.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) as unknown : undefined; } catch { parsed = undefined; }
      const error = responseBody(parsed);
      throw new ApiError(response.status, error.code, error.message, error.details, error.requestId ?? response.headers.get("X-Request-ID") ?? undefined);
    }
    return response;
  }

  private read(options?: RequestOptions, cacheKey?: string): RequestOptions { return { ...options, method: "GET", cacheKey: options?.cacheKey ?? cacheKey }; }
  private write(body: unknown, options?: RequestOptions, method: HttpMethod = "POST"): RequestOptions { return { ...options, method, body }; }
}
