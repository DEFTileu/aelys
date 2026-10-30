import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, NetworkError, OfflineQueuedError, OfflineWriteUnavailableError } from "../src/api-client";
import type { EntityStore, LocalEntity, OfflineStore, OutboxEntry, OutboxRequest } from "../src/offline";

class MemoryStore implements OfflineStore {
  public readonly outbox: OutboxEntry[] = [];
  public readonly cache = new Map<string, unknown>();
  public async enqueue(request: OutboxRequest): Promise<OutboxEntry> {
    const entry: OutboxEntry = { id: "queued-1", request, createdAt: 1, attempts: 0, nextAttemptAt: 1 };
    this.outbox.push(entry);
    return entry;
  }
  public async listOutbox(): Promise<readonly OutboxEntry[]> { return this.outbox.filter((entry) => entry.nextAttemptAt <= Date.now()); }
  public async updateOutbox(id: string, patch: Pick<OutboxEntry, "attempts" | "nextAttemptAt">): Promise<void> {
    const entry = this.outbox.find((item) => item.id === id);
    if (entry) Object.assign(entry, patch);
  }
  public async removeOutbox(id: string): Promise<void> { const index = this.outbox.findIndex((entry) => entry.id === id); if (index >= 0) this.outbox.splice(index, 1); }
  public async getCache<T>(key: string): Promise<T | undefined> { return this.cache.get(key) as T | undefined; }
  public async setCache<T>(key: string, value: T): Promise<void> { this.cache.set(key, value); }
  public async removeCache(key: string): Promise<void> { this.cache.delete(key); }
  public async invalidateCache(root: string): Promise<void> {
    for (const key of this.cache.keys()) if (key === root || key.startsWith(`${root}?`)) this.cache.delete(key);
  }
}

class EntityMemoryStore extends MemoryStore implements EntityStore {
  public readonly entities = new Map<string, LocalEntity>();
  public async getEntity<T>(key: string): Promise<LocalEntity<T> | undefined> { return this.entities.get(key) as LocalEntity<T> | undefined; }
  public async setEntity<T>(key: string, value: T, updatedAt = Date.now()): Promise<LocalEntity<T>> {
    const entity = { key, value, updatedAt };
    this.entities.set(key, entity);
    return entity;
  }
  public async removeEntity(key: string): Promise<void> { this.entities.delete(key); }
  public async setEntityAndEnqueue<T>(key: string, value: T, request: OutboxRequest): Promise<{ entity: LocalEntity<T>; outbox: OutboxEntry }> {
    const entity = await this.setEntity(key, value);
    const outbox = await this.enqueue(request);
    return { entity, outbox };
  }
}

describe("ApiClient", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(["global", "injected"] as const)("preserves the browser fetch receiver for %s fetch in JSON and event-stream requests", async (source) => {
    const fetchImpl = vi.fn(async function (this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
      // Browser fetch can reject an ApiClient receiver before sending a request.
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      if ((init?.headers as Record<string, string>).Accept === "text/event-stream") {
        return new Response("data: ready\n\n", { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ access_token: "access", token_type: "bearer" }));
    });
    vi.stubGlobal("fetch", fetchImpl);
    const client = new ApiClient({ baseUrl: "https://api.example.test", ...(source === "injected" ? { fetch: fetchImpl } : {}) });

    await expect(client.login({ email: "owner@example.test", password: "test-password" })).resolves.toMatchObject({ access_token: "access" });
    const response = await client.eventStream("/api/v1/ai/runs/run-1/events");
    await expect(response.text()).resolves.toBe("data: ready\n\n");
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.example.test/api/v1/auth/login", expect.objectContaining({ method: "POST" }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://api.example.test/api/v1/ai/runs/run-1/events", expect.objectContaining({ method: "GET" }));
  });

  it("sends bearer and idempotency headers and decodes JSON", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer access", "Idempotency-Key": "operation-1" });
      return new Response(JSON.stringify({ id: "p1", name: "Aelys", description: "", status: "active", version: 1 }), { status: 201 });
    });
    const client = new ApiClient({ baseUrl: "https://api.example.test", token: "access", fetch: fetchImpl });
    await expect(client.createProject({ name: "Aelys" }, { idempotencyKey: "operation-1" })).resolves.toMatchObject({ id: "p1" });
  });

  it("turns the documented error envelope into ApiError", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "Concurrent update", details: { server_version: 2 } }, request_id: "r1" }), { status: 409 }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    await expect(client.project("p1")).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT", requestId: "r1", details: { server_version: 2 } } satisfies Partial<ApiError>);
  });

  it("serves a cached GET when the network is unavailable", async () => {
    const store = new MemoryStore();
    store.cache.set("projects", [{ id: "cached" }]);
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.projects()).resolves.toEqual([{ id: "cached" }]);
  });

  it.each(["tasks", "notes"] as const)("isolates %s caches by canonical query", async (collection) => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "project-a" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "project-b" }])))
      .mockRejectedValue(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    const read = (query: Record<string, string | number | null | undefined>, options = {}) => collection === "tasks"
      ? client.tasks(query, options) : client.notes({ ...options, query });

    await read({ project_id: "a", limit: 10 }, { allowCacheFallback: false });
    await read({ project_id: "b", limit: 10 });
    await expect(read({ limit: 10, project_id: "a", ignored: null })).resolves.toEqual([{ id: "project-a" }]);
    await expect(read({ limit: 10, project_id: "b" })).resolves.toEqual([{ id: "project-b" }]);
    await expect(read({ project_id: "c", limit: 10 })).rejects.toBeInstanceOf(NetworkError);
  });

  it("honors an explicit cache key for a query", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ id: "custom" }]))).mockRejectedValueOnce(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await client.tasks({ project_id: "a" }, { cacheKey: "custom" });
    expect(store.cache.get("custom")).toEqual([{ id: "custom" }]);
    await expect(client.tasks({ project_id: "b" }, { cacheKey: "custom" })).resolves.toEqual([{ id: "custom" }]);
  });

  it("keeps the unfiltered key for empty or omitted query values", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ id: "all" }]))).mockRejectedValueOnce(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await client.tasks({ missing: undefined, absent: null });
    expect(store.cache.get("tasks")).toEqual([{ id: "all" }]);
    await expect(client.tasks()).resolves.toEqual([{ id: "all" }]);
  });

  it.each([401, 403])("never falls back to a query cache on HTTP %s", async (status) => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([{ id: "cached" }]))).mockResolvedValueOnce(new Response("Denied", { status }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await client.tasks({ project_id: "a" });
    await expect(client.tasks({ project_id: "a" })).rejects.toMatchObject({ status });
  });

  it("rejects network failures when cached GET fallback is disabled", async () => {
    const store = new MemoryStore();
    store.cache.set("tasks", [{ id: "cached" }]);
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.tasks(undefined, { allowCacheFallback: false })).rejects.toBeInstanceOf(NetworkError);
  });

  it("rejects server errors when cached GET fallback is disabled", async () => {
    const store = new MemoryStore();
    store.cache.set("tasks", [{ id: "cached" }]);
    const fetchImpl = vi.fn(async () => new Response("Unavailable", { status: 503 }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.tasks(undefined, { allowCacheFallback: false })).rejects.toMatchObject({ name: "ApiError", status: 503 });
  });

  it("caches a successful GET with fallback disabled for later default reads", async () => {
    const store = new MemoryStore();
    store.cache.set("tasks", [{ id: "old" }]);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "new" }]), { status: 200 }))
      .mockRejectedValueOnce(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.tasks(undefined, { allowCacheFallback: false })).resolves.toEqual([{ id: "new" }]);
    expect(store.cache.get("tasks")).toEqual([{ id: "new" }]);
    await expect(client.tasks()).resolves.toEqual([{ id: "new" }]);
  });

  it("durably queues a mutation on network failure and never stores Authorization", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "https://api.example.test", token: "secret", fetch: fetchImpl, offlineStore: store });
    const result = client.createNote({ title: "Offline note" }, { headers: { AuThOrIzAtIoN: "caller-secret" } });
    await expect(result).rejects.toBeInstanceOf(OfflineQueuedError);
    expect(store.outbox[0]?.request).toMatchObject({ method: "POST", path: "/api/v1/notes", body: { title: "Offline note" } });
    expect(store.outbox[0]?.request.headers).toBeUndefined();
  });

  it("never caches authentication responses even with a caller cache key", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "secret" })));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await client.login({ email: "owner@example.test", password: "password" }, { cacheKey: "auth" });
    expect(store.cache.size).toBe(0);
  });

  it("invalidates filtered collections after a successful write", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "old" }])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new" }), { status: 201 }))
      .mockRejectedValueOnce(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await client.tasks({ project_id: "a" });
    store.cache.set("tasks?project_id=b", [{ id: "other" }]);
    store.cache.set("notes", [{ id: "unrelated" }]);
    await client.createTask({ title: "new" });
    expect(store.cache.has("tasks?project_id=b")).toBe(false);
    expect(store.cache.get("notes")).toEqual([{ id: "unrelated" }]);
    await expect(client.tasks({ project_id: "a" })).rejects.toBeInstanceOf(NetworkError);
  });

  it("returns the committed write and blocks stale fallback when invalidation fails", async () => {
    const store = new MemoryStore();
    store.cache.set("tasks?project_id=a", [{ id: "old" }]);
    vi.spyOn(store, "invalidateCache").mockRejectedValue(new Error("storage unavailable"));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "new" }), { status: 201 })).mockRejectedValueOnce(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.createTask({ title: "new" })).resolves.toEqual({ id: "new" });
    await expect(client.tasks({ project_id: "a" })).rejects.toBeInstanceOf(NetworkError);
    expect(store.outbox).toHaveLength(0);
  });

  it("keeps cache entries after a rejected write", async () => {
    const store = new MemoryStore();
    store.cache.set("notes?project_id=a", [{ id: "old" }]);
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("Conflict", { status: 409 })).mockRejectedValueOnce(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.createNote({ title: "new" })).rejects.toMatchObject({ status: 409 });
    await expect(client.notes({ query: { project_id: "a" } })).resolves.toEqual([{ id: "old" }]);
  });

  it("blocks stale fallback when a legacy store lacks invalidation", async () => {
    const store = new MemoryStore();
    store.cache.set("tasks", [{ id: "old" }]);
    const legacy: OfflineStore = {
      enqueue: store.enqueue.bind(store), listOutbox: store.listOutbox.bind(store), updateOutbox: store.updateOutbox.bind(store),
      removeOutbox: store.removeOutbox.bind(store), getCache: store.getCache.bind(store), setCache: store.setCache.bind(store), removeCache: store.removeCache.bind(store),
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "new" }), { status: 201 })).mockRejectedValueOnce(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: legacy });
    await expect(client.createTask({ title: "new" })).resolves.toEqual({ id: "new" });
    await expect(client.tasks()).rejects.toBeInstanceOf(NetworkError);
  });

  it("does not cache an old in-flight GET after a confirmed write", async () => {
    const store = new MemoryStore();
    let finishGet!: (response: Response) => void;
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finishGet = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "new" }), { status: 201 }))
      .mockRejectedValueOnce(new Error("offline"));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    const oldRead = client.tasks({ project_id: "a" });
    await client.createTask({ title: "new" });
    finishGet(new Response(JSON.stringify([{ id: "old" }])));
    await oldRead;
    await expect(client.tasks({ project_id: "a" })).rejects.toBeInstanceOf(NetworkError);
  });

  it("atomically stores an optimistic entity with its offline outbox entry", async () => {
    const store = new EntityMemoryStore();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.createTask({ title: "Offline task" }, {
      idempotencyKey: "operation-task-1",
      offlineEntityKey: "pending:tasks:operation-task-1",
      offlineEntityValue: { pending: true, title: "Offline task" },
    })).rejects.toMatchObject({ name: "OfflineQueuedError", entryId: "queued-1" });
    expect(store.entities.get("pending:tasks:operation-task-1")?.value).toEqual({ pending: true, title: "Offline task" });
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0]?.request.headers).toBeUndefined();
  });

  it("never queues login passwords or provider keys", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.login({ email: "owner@example.test", password: "correct-horse" })).rejects.toBeInstanceOf(NetworkError);
    await expect(client.setAIProviderSecret("provider-1", { api_key: "provider-secret" })).rejects.toBeInstanceOf(NetworkError);
    expect(store.outbox).toHaveLength(0);
  });

  it("does not queue when explicitly disabled", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.createNote({ title: "No queue" }, { queueOnOffline: false })).rejects.toBeInstanceOf(NetworkError);
    expect(store.outbox).toHaveLength(0);
  });

  it("replays queued mutations after connectivity returns", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "n1" }), { status: 201 }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.createNote({ title: "Queued note" })).rejects.toBeInstanceOf(OfflineQueuedError);
    await expect(client.replayOutbox()).resolves.toEqual({ applied: 1, retained: 0 });
    expect(store.outbox).toHaveLength(0);
  });

  it.each([401, 409, 422])("retains a queued command on HTTP %s until explicit resolution", async (status) => {
    const store = new MemoryStore();
    await store.enqueue({ method: "PATCH", path: "/api/v1/tasks/t1", body: { status: "done" }, idempotencyKey: "operation-1" });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ detail: { code: "CONFLICT", message: "Resolve" } }), { status }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.replayOutbox()).resolves.toEqual({ applied: 0, retained: 1 });
    expect(store.outbox).toHaveLength(1);
  });

  it("returns a typed unavailable-write error for online-only personal operations", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.startFocusSession({ started_at: "2026-10-29T09:00:00Z" })).rejects.toBeInstanceOf(OfflineWriteUnavailableError);
    await expect(client.createFinanceAccount({ name: "Cash", currency: "KZT" })).rejects.toMatchObject({ code: "OFFLINE_WRITE_UNAVAILABLE" });
    expect(store.outbox).toHaveLength(0);
  });

  it("reads the ledger cache through an unavailable reverse proxy but rejects revoked access", async () => {
    const store = new MemoryStore();
    store.cache.set("finance-transactions", [{ id: "cached-posting", amount: "1250.5001" }]);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("Proxy unavailable", { status: 502 }))
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
    await expect(client.financeTransactions()).resolves.toEqual([{ id: "cached-posting", amount: "1250.5001" }]);
    await expect(client.financeTransactions()).rejects.toMatchObject({ status: 401 });
  });
});
