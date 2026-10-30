import type {
  ActivityEvent, AgentDevice, AgentRun, AgentRunIn, AIConversation, AIMessage, AIMessageIn, AIProvider, AIProviderSecretResponse,
  AIRun, AIRunIn, AutomationDispatchResponse, AutomationDryRunResponse, AutomationEventIn, AutomationExecution, AutomationRule,
  AutomationRuleIn, CredentialLeaseIn, CredentialLeaseResponse, ConversationIn, DeleteResponse, DeviceEnroll, DeviceEnrollmentResponse,
  DeviceResponse, DraftIn, EventIn, EventOut, FinanceAccount, FinanceAccountIn, FinanceBudget, FinanceBudgetIn, FinanceCategory,
  FinanceCategoryIn, FinanceSummary, FinanceTransaction, FinanceTransfer, FinanceTransferIn, FocusIn, FocusOut, HistoryEntry, JsonObject, LoginRequest, MailAccount,
  MailAccountIn, MailDraft, MailMessage, MeResponse, MessageIn, NoteIn, NoteOut, NoteRevision, Notification, NotificationCreate,
  ProjectCreate, ProjectGrantCreate, ProjectGrantResponse, ProjectPatch, ProjectResponse, ProviderIn, RefreshRequest, ReminderIn,
  ResourceCreate, ResourceLinkCreate, ResourceLinkResponse, ResourceResponse, RevokeResponse, SearchResponse, SessionSearch, SessionSearchResponse, AgentSession,
  SyncAckRequest, SyncAckResponse, SyncBootstrapResponse, SyncPullResponse, SyncPushRequest, SyncPushResponse, SyncStatusResponse,
  TaskIn, TaskOut, TaskReminder, CalendarReminder, CalendarReminderIn, TokenResponse, TransactionIn, Id,
} from "./types";
import type { EntityKey, EntityStore, OfflineStore, OutboxRequest } from "./offline";
import type { DraftPatch, EventPatch, EventOccurrence, TaskPatch, ProviderPatch, ProviderProbe } from "./types";

import type { TelegramBusinessMessage, TelegramSettingsPatch, TelegramStatus } from "./telegram";

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
  /** Disable cached GET fallback while still caching successful responses. */
  readonly allowCacheFallback?: boolean;
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

export class OfflineWriteUnavailableError extends NetworkError {
  public readonly code = "OFFLINE_WRITE_UNAVAILABLE";
  public constructor(cause?: unknown) {
    super("This operation requires a connection. Its result is unconfirmed; reload before retrying.", cause);
    this.name = "OfflineWriteUnavailableError";
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

function queryCacheSuffix(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) params.set(key, String(value));
  params.sort();
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

const mutationFamilies: readonly [string, readonly string[]][] = [
  ["/api/v1/projects", ["projects"]], ["/api/v1/notes", ["notes"]], ["/api/v1/tasks", ["tasks"]],
  ["/api/v1/calendar", ["calendar-events", "calendar-occurrences"]], ["/api/v1/focus", ["focus-sessions"]],
  ["/api/v1/finance", ["finance-accounts", "finance-categories", "finance-budgets", "finance-transactions", "finance-summary"]],
  ["/api/v1/mail", ["mail-accounts", "mail-messages", "mail-drafts"]],
  ["/api/v1/notifications", ["notifications"]], ["/api/v1/ai/providers", ["ai-providers"]],
  ["/api/v1/agents", ["agent-devices", "agent-sessions"]], ["/api/v1/automations", ["automations"]],
  ["/api/v1/sync/push", ["projects", "notes", "tasks", "calendar-events", "calendar-occurrences", "focus-sessions", "finance-accounts", "finance-categories", "finance-budgets", "finance-transactions", "finance-summary", "mail-accounts", "mail-messages", "mail-drafts"]],
];

function affectedCacheFamilies(path: string): readonly string[] {
  const families = mutationFamilies.filter(([prefix]) => path === prefix || path.startsWith(`${prefix}/`)).flatMap(([, roots]) => roots);
  return families.length ? [...new Set([...families, "activity", "history", "sync-status"])] : [];
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
  private cacheWork: Promise<void> = Promise.resolve();
  private readonly cacheGenerations = new Map<string, number>();
  private readonly blockedCacheFamilies = new Set<string>();

  public constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("fetch is not available in this runtime");
    // Native browser fetch requires the global receiver, not this ApiClient.
    this.fetchImpl = fetchImpl.bind(globalThis);
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
    const cacheFamily = method === "GET" && options.cacheKey ? this.cacheFamily(options.cacheKey) : undefined;
    const generation = cacheFamily ? this.cacheGenerations.get(cacheFamily) ?? 0 : 0;
    const queryString = encodeQuery(options.query);
    const url = `${this.baseUrl}${path}${queryString}`;
    const token = this.getTokenValue ? await this.getTokenValue() : this.tokenValue;
    const safeHeaders: Record<string, string> = { ...options.headers };
    for (const key of Object.keys(safeHeaders)) if (key.toLowerCase() === "authorization") delete safeHeaders[key];
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
      const value = await this.parseResponse<T>(response);
      if (method === "GET" && options.cacheKey && this.offlineStore) {
        await this.withCacheWork(async () => {
          if (!cacheFamily || (this.cacheGenerations.get(cacheFamily) ?? 0) === generation) {
            await this.offlineStore?.setCache(options.cacheKey as string, value, options.cacheTtlMs);
          }
        });
      } else if (method !== "GET") {
        await this.invalidateAfterWrite(path);
      }
      return value;
    } catch (error) {
      if (error instanceof ApiError) {
        // An offline reverse proxy may return 502/503 rather than throw fetch.
        // Authorization/validation failures must never reveal cached data.
        if (method === "GET" && error.status >= 500 && options.allowCacheFallback !== false && options.cacheKey && this.offlineStore && (!cacheFamily || !this.blockedCacheFamilies.has(cacheFamily))) {
          const cached = await this.offlineStore.getCache<T>(options.cacheKey);
          if (cached !== undefined) return cached;
        }
        throw error;
      }
      const networkError = error instanceof NetworkError ? error : new NetworkError("Network request failed", error);
      if (method === "GET" && options.allowCacheFallback !== false && options.cacheKey && this.offlineStore && (!cacheFamily || !this.blockedCacheFamilies.has(cacheFamily))) {
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
      if (method !== "GET" && options.queueOnOffline === false) throw new OfflineWriteUnavailableError(networkError);
      throw networkError;
    } finally {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private cacheFamily(key: string): string | undefined {
    return mutationFamilies.flatMap(([, roots]) => roots).concat(["activity", "history", "sync-status"])
      .find((root) => key === root || key.startsWith(`${root}?`));
  }

  private async withCacheWork(work: () => Promise<void>): Promise<void> {
    const next = this.cacheWork.then(work);
    this.cacheWork = next.catch(() => {});
    await next;
  }

  private async invalidateAfterWrite(path: string): Promise<void> {
    if (!this.offlineStore) return;
    const roots = affectedCacheFamilies(path);
    for (const root of roots) {
      this.cacheGenerations.set(root, (this.cacheGenerations.get(root) ?? 0) + 1);
      this.blockedCacheFamilies.add(root);
    }
    const generations = roots.map((root) => this.cacheGenerations.get(root));
    try {
      await this.withCacheWork(async () => {
        for (const [index, root] of roots.entries()) {
          if (!this.offlineStore?.invalidateCache) continue;
          await this.offlineStore.invalidateCache(root);
          if (this.cacheGenerations.get(root) === generations[index]) this.blockedCacheFamilies.delete(root);
        }
      });
    } catch {
      // The server has committed. Keep affected fallbacks disabled in this client,
      // rather than reporting a failed write that could be retried as a duplicate.
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
        // Validation, auth and version conflicts need user resolution. Never
        // silently discard a durable command merely because the API rejected it.
        retained += 1;
        break;
      }
    }
    return { applied, retained };
  }

  public login(body: LoginRequest, options?: RequestOptions) { return this.request<TokenResponse>("/api/v1/auth/login", this.write(body, { ...options, queueOnOffline: false })); }
  public bootstrapOwner(body: LoginRequest, options?: RequestOptions) { return this.request<TokenResponse>("/api/v1/auth/bootstrap", this.write(body, { ...options, queueOnOffline: false })); }
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
  public updateTask(itemId: Id, body: TaskPatch, options?: RequestOptions) { return this.request<TaskOut>(`/api/v1/tasks/${encodeURIComponent(itemId)}`, this.write(body, options, "PATCH")); }
  public deleteTask(itemId: Id, query?: Query, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/tasks/${encodeURIComponent(itemId)}`, this.write(undefined, { ...options, query }, "DELETE")); }
  public taskReminders(taskId: Id, options?: RequestOptions) { return this.request<readonly TaskReminder[]>(`/api/v1/tasks/${encodeURIComponent(taskId)}/reminders`, this.read(options)); }
  public createTaskReminder(taskId: Id, body: ReminderIn, options?: RequestOptions) { return this.request<TaskReminder>(`/api/v1/tasks/${encodeURIComponent(taskId)}/reminders`, this.write(body, options)); }
  public calendarEvents(query?: Query, options?: RequestOptions) { return this.request<readonly EventOut[]>("/api/v1/calendar/events", this.read({ ...options, query }, "calendar-events")); }
  public calendarOccurrences(startsAt: string, endsAt: string, options?: RequestOptions) { return this.request<readonly EventOccurrence[]>("/api/v1/calendar/occurrences", this.read({ ...options, query: { starts_at: startsAt, ends_at: endsAt } }, "calendar-occurrences")); }
  public createCalendarEvent(body: EventIn, options?: RequestOptions) { return this.request<EventOut>("/api/v1/calendar/events", this.write(body, { queueOnOffline: false, ...options })); }
  public calendarEvent(itemId: Id, options?: RequestOptions) { return this.request<EventOut>(`/api/v1/calendar/events/${encodeURIComponent(itemId)}`, this.read(options)); }
  public updateCalendarEvent(itemId: Id, body: EventPatch, options?: RequestOptions) { return this.request<EventOut>(`/api/v1/calendar/events/${encodeURIComponent(itemId)}`, this.write(body, { queueOnOffline: false, ...options }, "PATCH")); }
  public deleteCalendarEvent(itemId: Id, version: number, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/calendar/events/${encodeURIComponent(itemId)}`, this.write(undefined, { queueOnOffline: false, ...options, query: { version } }, "DELETE")); }
  public calendarReminders(eventId: Id, options?: RequestOptions) { return this.request<readonly CalendarReminder[]>(`/api/v1/calendar/events/${encodeURIComponent(eventId)}/reminders`, this.read(options)); }
  public createCalendarReminder(eventId: Id, body: CalendarReminderIn, options?: RequestOptions) { return this.request<CalendarReminder>(`/api/v1/calendar/events/${encodeURIComponent(eventId)}/reminders`, this.write(body, { queueOnOffline: false, ...options })); }
  public cancelCalendarReminder(eventId: Id, reminderId: Id, version: number, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/calendar/events/${encodeURIComponent(eventId)}/reminders/${encodeURIComponent(reminderId)}`, this.write(undefined, { queueOnOffline: false, ...options, query: { version } }, "DELETE")); }
  public dispatchCalendarReminders(options?: RequestOptions) { return this.request<{ readonly delivered: number }>("/api/v1/calendar/reminders/dispatch", this.write(undefined, { ...options, queueOnOffline: false })); }
  public focusSessions(options?: RequestOptions) { return this.request<readonly FocusOut[]>("/api/v1/focus/sessions", this.read(options, "focus-sessions")); }
  public startFocusSession(body: FocusIn, options?: RequestOptions) { return this.request<FocusOut>("/api/v1/focus/sessions", this.write(body, { queueOnOffline: false, ...options })); }
  public stopFocusSession(itemId: Id, options?: RequestOptions) { return this.request<FocusOut>(`/api/v1/focus/sessions/${encodeURIComponent(itemId)}/stop`, this.write(undefined, { queueOnOffline: false, ...options })); }

  public financeAccounts(options?: RequestOptions) { return this.request<readonly FinanceAccount[]>("/api/v1/finance/accounts", this.read(options, "finance-accounts")); }
  public createFinanceAccount(body: FinanceAccountIn, options?: RequestOptions) { return this.request<FinanceAccount>("/api/v1/finance/accounts", this.write(body, { queueOnOffline: false, ...options })); }
  public financeCategories(options?: RequestOptions) { return this.request<readonly FinanceCategory[]>("/api/v1/finance/categories", this.read(options, "finance-categories")); }
  public createFinanceCategory(body: FinanceCategoryIn, options?: RequestOptions) { return this.request<FinanceCategory>("/api/v1/finance/categories", this.write(body, { queueOnOffline: false, ...options })); }
  public financeBudgets(options?: RequestOptions) { return this.request<readonly FinanceBudget[]>("/api/v1/finance/budgets", this.read(options, "finance-budgets")); }
  public createFinanceBudget(body: FinanceBudgetIn, options?: RequestOptions) { return this.request<FinanceBudget>("/api/v1/finance/budgets", this.write(body, { queueOnOffline: false, ...options })); }
  public financeTransactions(options?: RequestOptions) { return this.request<readonly FinanceTransaction[]>("/api/v1/finance/transactions", this.read(options, "finance-transactions")); }
  public createFinanceTransaction(body: TransactionIn, options?: RequestOptions) { return this.request<FinanceTransaction>("/api/v1/finance/transactions", this.write(body, { queueOnOffline: false, ...options })); }
  public createFinanceTransfer(body: FinanceTransferIn, options?: RequestOptions) { return this.request<FinanceTransfer>("/api/v1/finance/transfers", this.write(body, { queueOnOffline: false, ...options })); }
  public financeSummary(options?: RequestOptions) { return this.request<FinanceSummary>("/api/v1/finance/summary", this.read(options, "finance-summary")); }

  public mailAccounts(options?: RequestOptions) { return this.request<readonly MailAccount[]>("/api/v1/mail/accounts", this.read(options, "mail-accounts")); }
  public gmailStatus() { return this.request<{ readonly configured: boolean }>("/api/v1/mail/gmail/status"); }
  public connectGmail() { return this.request<{ readonly authorization_url: string }>("/api/v1/mail/gmail/connect", this.write(undefined, { queueOnOffline: false })); }
  public syncGmail(id: Id, pageToken?: string) { return this.request<{ readonly imported: number; readonly next_page_token: string | null }>(`/api/v1/mail/gmail/${encodeURIComponent(id)}/sync`, this.write(undefined, { queueOnOffline: false, query: { page_token: pageToken } })); }
  public importGmailDrafts(id: Id, pageToken?: string) { return this.request<{ readonly imported: number; readonly next_page_token: string | null }>(`/api/v1/mail/gmail/${encodeURIComponent(id)}/drafts/import`, this.write(undefined, { queueOnOffline: false, query: { page_token: pageToken } })); }
  public publishGmailDraft(accountId: Id, draftId: Id, version: number) { return this.request<{ readonly saved: boolean }>(`/api/v1/mail/gmail/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}`, this.write({ version }, { queueOnOffline: false })); }
  public disconnectGmail(id: Id) { return this.request<{ readonly disconnected: boolean; readonly provider_revoked: boolean }>(`/api/v1/mail/gmail/${encodeURIComponent(id)}/disconnect`, this.write(undefined, { queueOnOffline: false })); }
  public createMailAccount(body: MailAccountIn, options?: RequestOptions) { return this.request<MailAccount>("/api/v1/mail/accounts", this.write(body, options)); }
  public mailMessages(query?: Query, options?: RequestOptions) { return this.request<readonly MailMessage[]>("/api/v1/mail/messages", this.read({ ...options, query }, "mail-messages")); }
  public importMailMessage(body: MessageIn, options?: RequestOptions) { return this.request<MailMessage>("/api/v1/mail/messages", this.write(body, options)); }
  public mailDrafts(options?: RequestOptions) { return this.request<readonly MailDraft[]>("/api/v1/mail/drafts", this.read(options, "mail-drafts")); }
  public createMailDraft(body: DraftIn, options?: RequestOptions) { return this.request<MailDraft>("/api/v1/mail/drafts", this.write(body, options)); }
  public updateMailDraft(id: Id, body: DraftPatch, options?: RequestOptions) { return this.request<MailDraft>(`/api/v1/mail/drafts/${encodeURIComponent(id)}`, this.write(body, options, "PATCH")); }
  public deleteMailDraft(id: Id, version: number, options?: RequestOptions) { return this.request<DeleteResponse>(`/api/v1/mail/drafts/${encodeURIComponent(id)}`, this.write(undefined, { ...options, query: { version } }, "DELETE")); }
  public async importEml(file: File): Promise<MailMessage> {
    const body = new FormData(); body.append("file", file);
    const token = this.getTokenValue ? await this.getTokenValue() : this.tokenValue;
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/mail/import/eml`, { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body });
    const value = await this.parseResponse<MailMessage>(response);
    await this.invalidateAfterWrite("/api/v1/mail/import/eml");
    return value;
  }
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

  public telegramStatus(options?: RequestOptions) { return this.request<TelegramStatus>("/api/v1/integrations/telegram/status", this.read(options)); }
  public connectTelegram(body: { readonly bot_token: string }, options?: RequestOptions) { return this.request<TelegramStatus>("/api/v1/integrations/telegram/connect", this.write(body, { ...options, queueOnOffline: false })); }
  public telegramBinding(options?: RequestOptions) { return this.request<{ readonly url: string; readonly expires_at: string }>("/api/v1/integrations/telegram/binding", this.write({}, { ...options, queueOnOffline: false })); }
  public updateTelegramSettings(body: TelegramSettingsPatch, options?: RequestOptions) { return this.request<TelegramStatus>("/api/v1/integrations/telegram/settings", this.write(body, { ...options, queueOnOffline: false }, "PATCH")); }
  public disconnectTelegram(options?: RequestOptions) { return this.request<{ readonly disconnected: true }>("/api/v1/integrations/telegram/disconnect", this.write({}, { ...options, queueOnOffline: false })); }
  public syncTelegram(options?: RequestOptions) { return this.request<{ readonly processed: number }>("/api/v1/integrations/telegram/sync", this.write({}, { ...options, queueOnOffline: false })); }
  public telegramMessages(options?: RequestOptions) { return this.request<readonly TelegramBusinessMessage[]>("/api/v1/integrations/telegram/messages", this.read(options)); }
  public draftTelegramMessage(id: string, body: { readonly version: number }, options?: RequestOptions) { return this.request<TelegramBusinessMessage>(`/api/v1/integrations/telegram/messages/${encodeURIComponent(id)}/draft`, this.write(body, { ...options, queueOnOffline: false })); }
  public sendTelegramMessage(id: string, body: { readonly version: number; readonly text: string }, options?: RequestOptions) { return this.request<TelegramBusinessMessage>(`/api/v1/integrations/telegram/messages/${encodeURIComponent(id)}/send`, this.write(body, { ...options, queueOnOffline: false })); }

  public aiProviders(options?: RequestOptions) { return this.request<readonly AIProvider[]>("/api/v1/ai/providers", this.read(options, "ai-providers")); }
  public createAIProvider(body: ProviderIn, options?: RequestOptions) { return this.request<AIProvider>("/api/v1/ai/providers", this.write(body, options)); }
  public updateAIProvider(id: Id, body: ProviderPatch) { return this.request<AIProvider>(`/api/v1/ai/providers/${encodeURIComponent(id)}`, this.write(body, { queueOnOffline: false }, "PATCH")); }
  public probeAIProvider(id: Id) { return this.request<ProviderProbe>(`/api/v1/ai/providers/${encodeURIComponent(id)}/probe`, this.write(undefined, { queueOnOffline: false })); }
  public aiConversations(options?: RequestOptions) { return this.request<readonly AIConversation[]>("/api/v1/ai/conversations", this.read(options)); }
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

  private read(options?: RequestOptions, cacheKey?: string): RequestOptions {
    return { ...options, method: "GET", cacheKey: options?.cacheKey ?? (cacheKey === undefined ? undefined : `${cacheKey}${queryCacheSuffix(options?.query)}`) };
  }
  private write(body: unknown, options?: RequestOptions, method: HttpMethod = "POST"): RequestOptions { return { ...options, method, body }; }
}
