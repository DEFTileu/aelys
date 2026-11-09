import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, CacheMissError, NetworkError, OfflineQueuedError, OfflineWriteUnavailableError } from "../src/api-client";
import type { EntityStore, LocalEntity, OfflineStore, OutboxEntry, OutboxRequest } from "../src/offline";

const json = (value: unknown) => new Response(JSON.stringify(value));
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

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

class TaggedMemoryStore extends MemoryStore {
  readonly tags = new Map<string, string>();
  public override async setCache<T>(key: string, value: T, _ttl?: number, etag?: string) {
    await super.setCache(key, value);
    if (etag) this.tags.set(key, etag); else this.tags.delete(key);
  }
  public async getCacheSnapshot<T>(key: string) {
    const value = await this.getCache<T>(key);
    return value === undefined ? undefined : { value, etag: this.tags.get(key) };
  }
}

describe("conditional device revalidation", () => {
  it("previews saved data before a slow response and reuses a 304 after recreating the client", async () => {
    const store = new TaggedMemoryStore();
    const value = { items: [], next_cursor: null, etag: 'W/"v1"', not_modified: false };
    const first = new ApiClient({ baseUrl: "", offlineStore: store, fetch: vi.fn(async () => new Response(JSON.stringify(value), { headers: { ETag: 'W/"v1"' } })) });
    await first.notesPage();
    const pending = deferredResponse();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    const preview = vi.fn();
    const next = new ApiClient({ baseUrl: "", offlineStore: store, fetch: fetchImpl });
    const result = next.notesPage(undefined, { onCached: preview, allowCacheFallback: false });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(preview).toHaveBeenCalledWith(value);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: { "If-None-Match": 'W/"v1"' } });
    pending.resolve(new Response(null, { status: 304, headers: { ETag: 'W/"v1"' } }));
    await expect(result).resolves.toEqual(value);
  });

  it("retries once without the validator if a 304 arrives after the disk entry disappeared", async () => {
    const store = new TaggedMemoryStore();
    await store.setCache("notes-pages", { items: [], next_cursor: null }, undefined, 'W/"v1"');
    const fetchImpl = vi.fn().mockImplementationOnce(async () => { store.cache.clear(); return new Response(null, { status: 304 }); }).mockResolvedValueOnce(json({ items: [{ id: "current" }], next_cursor: null }));
    const client = new ApiClient({ baseUrl: "", offlineStore: store, fetch: fetchImpl });
    await expect(client.notesPage()).resolves.toMatchObject({ items: [{ id: "current" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[1].headers["If-None-Match"]).toBeUndefined();
  });

  it("does not replace a successful server response with an IndexedDB quota failure", async () => {
    const store = new MemoryStore();
    vi.spyOn(store, "setCache").mockRejectedValue(new Error("Quota exceeded"));
    const client = new ApiClient({ baseUrl: "", offlineStore: store, fetch: vi.fn(async () => json([{ id: "live" }])) });
    await expect(client.notes()).resolves.toEqual([{ id: "live" }]);
  });
});

describe("device cache reads", () => {
  it("serves saved collections after recreating the client with zero offline fetches", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async () => json([{ id: "saved-task" }]));
    await new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store }).tasks();
    fetchImpl.mockClear();
    const reopened = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store, isOnline: () => false });
    await expect(reopened.tasks()).resolves.toEqual([{ id: "saved-task" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("provides explicit cache-only reads online with canonical filter keys", async () => {
    const store = new MemoryStore();
    store.cache.set("tasks?limit=10&project_id=a", [{ id: "a" }]);
    const fetchImpl = vi.fn();
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store });
    await expect(client.tasks({ project_id: "a", limit: 10 }, { cacheOnly: true })).resolves.toEqual([{ id: "a" }]);
    await expect(client.tasks({ project_id: "b" }, { cacheOnly: true })).rejects.toBeInstanceOf(CacheMissError);
    await expect(client.me({ cacheOnly: true })).rejects.toMatchObject({ code: "CACHE_MISS" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails immediately on a cold offline read, including when live validation is required", async () => {
    const store = new MemoryStore();
    store.cache.set("tasks", [{ id: "old" }]);
    const fetchImpl = vi.fn();
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store, isOnline: () => false });
    await expect(client.notes()).rejects.toBeInstanceOf(CacheMissError);
    await expect(client.tasks(undefined, { allowCacheFallback: false })).rejects.toBeInstanceOf(CacheMissError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403])("does not reveal durable snapshots after an observed HTTP %s", async (status) => {
    const store = new MemoryStore();
    store.cache.set("tasks", [{ id: "private" }]);
    let online = true;
    const fetchImpl = vi.fn(async () => new Response("Denied", { status }));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store, isOnline: () => online });
    await expect(client.tasks()).rejects.toMatchObject({ status });
    online = false;
    await expect(client.tasks()).rejects.toBeInstanceOf(CacheMissError);
    await expect(client.tasks(undefined, { cacheOnly: true })).rejects.toBeInstanceOf(CacheMissError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("blocks memory, disk and network-error fallback when the owner/backend partition changes", async () => {
    const store = new MemoryStore();
    let allowed = true;
    const fetchImpl = vi.fn().mockResolvedValueOnce(json([{ id: "private" }])).mockRejectedValue(new Error("offline"));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store, canUseCache: () => allowed, readFreshnessMs: 60_000 });
    await client.tasks();
    allowed = false;
    await expect(client.tasks(undefined, { cacheOnly: true })).rejects.toBeInstanceOf(CacheMissError);
    await expect(client.tasks()).rejects.toBeInstanceOf(NetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("discards a delayed disk snapshot invalidated by a confirmed mutation", async () => {
    const store = new MemoryStore();
    let resolve!: (value: unknown) => void;
    const read = vi.spyOn(store, "getCache").mockImplementation(() => new Promise(done => { resolve = done; }));
    const fetchImpl = vi.fn(async () => json({ id: "new" }));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store });
    const pending = client.tasks(undefined, { cacheOnly: true });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    await client.createTask({ title: "new" });
    resolve([{ id: "stale" }]);
    await expect(pending).rejects.toBeInstanceOf(CacheMissError);
  });

  it("discards a pending disk read when its owner/backend scope closes", async () => {
    const store = new MemoryStore();
    let allowed = true;
    let resolve!: (value: unknown) => void;
    vi.spyOn(store, "getCache").mockImplementation(() => new Promise(done => { resolve = done; }));
    const client = new ApiClient({ baseUrl: "", fetch: vi.fn(), offlineStore: store, canUseCache: () => allowed });
    const pending = client.tasks(undefined, { cacheOnly: true });
    await Promise.resolve();
    allowed = false;
    resolve([{ id: "private" }]);
    await expect(pending).rejects.toBeInstanceOf(CacheMissError);
  });

  it("allows device reads again after a new successful server validation", async () => {
    const store = new MemoryStore();
    let online = true;
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("Denied", { status: 401 })).mockResolvedValueOnce(json([{ id: "confirmed" }]));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store, isOnline: () => online });
    await expect(client.tasks()).rejects.toMatchObject({ status: 401 });
    await client.tasks();
    online = false;
    await expect(client.tasks()).resolves.toEqual([{ id: "confirmed" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("queues offline-capable writes durably without attempting fetch", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn();
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store, isOnline: () => false });
    await expect(client.createNote({ title: "Offline" })).rejects.toBeInstanceOf(OfflineQueuedError);
    expect(store.outbox).toHaveLength(1);
    await expect(client.createTask({ title: "Online only" }, { queueOnOffline: false })).rejects.toBeInstanceOf(OfflineWriteUnavailableError);
    expect(store.outbox).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains offline outbox entries without increasing retry attempts or backoff", async () => {
    const store = new MemoryStore();
    const entry = await store.enqueue({ method: "POST", path: "/api/v1/notes", body: { title: "Pending" }, idempotencyKey: "pending" });
    const fetchImpl = vi.fn();
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store, isOnline: () => false });
    await expect(client.replayOutbox()).resolves.toEqual({ applied: 0, retained: 1 });
    expect(entry.attempts).toBe(0);
    expect(entry.nextAttemptAt).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects cache-only mutations without fetching or creating an outbox entry", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn();
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store });
    await expect(client.createNote({ title: "Invalid" }, { cacheOnly: true })).rejects.toThrow("only for GET");
    expect(store.outbox).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps storage failures from replacing a real server error", async () => {
    const store = new MemoryStore();
    vi.spyOn(store, "getCache").mockRejectedValue(new Error("IndexedDB unavailable"));
    const fetchImpl = vi.fn(async () => new Response("Unavailable", { status: 503 }));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store });
    await expect(client.tasks()).rejects.toMatchObject({ status: 503 });
    await expect(client.tasks(undefined, { cacheOnly: true })).rejects.toBeInstanceOf(CacheMissError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("navigation read freshness", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("reuses a recent response across visits, expires it and supports explicit refresh", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => json([{ id: "task", version: fetchImpl.mock.calls.length }]));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    await expect(client.tasks()).resolves.toEqual([{ id: "task", version: 1 }]);
    await vi.advanceTimersByTimeAsync(59_999);
    await expect(client.tasks()).resolves.toEqual([{ id: "task", version: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(client.tasks()).resolves.toEqual([{ id: "task", version: 2 }]);
    await expect(client.tasks(undefined, { forceRefresh: true })).resolves.toEqual([{ id: "task", version: 3 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent reads with equivalent filters without sharing mutable results", async () => {
    const response = deferredResponse();
    const fetchImpl = vi.fn(() => response.promise);
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    const first = client.tasks({ project_id: "a", limit: 10 });
    const second = client.tasks({ limit: 10, ignored: null, project_id: "a" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    response.resolve(json([{ id: "original" }]));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    Object.assign(a[0]!, { id: "edited" });
    await expect(client.tasks({ project_id: "a", limit: 10 })).resolves.toEqual([{ id: "original" }]);
  });

  it("keeps filters, headers and cache policies separate", async () => {
    const response = deferredResponse();
    const fetchImpl = vi.fn(() => response.promise.then((value) => value.clone()));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    const requests = [client.tasks({ project_id: "a" }), client.tasks({ project_id: "b" }),
      client.tasks({ project_id: "a" }, { allowCacheFallback: false }), client.tasks({ project_id: "a" }, { headers: { "X-Test": "different" } })];
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    response.resolve(json([]));
    await Promise.all(requests);
  });

  it("invalidates affected snapshots after writes even without a durable store", async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    await client.tasks({ project_id: "a" });
    await client.tasks({ project_id: "b" });
    await client.notes();
    await client.createTask({ title: "new" });
    await client.tasks({ project_id: "a" });
    await client.tasks({ project_id: "b" });
    await client.notes();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("does not join or cache a pre-write response after a confirmed mutation", async () => {
    const old = deferredResponse();
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json({ id: "new" }))
      .mockResolvedValueOnce(json([{ id: "new" }]));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    const oldRead = client.tasks();
    await client.createTask({ title: "new" });
    await expect(client.tasks()).resolves.toEqual([{ id: "new" }]);
    old.resolve(json([{ id: "old" }]));
    await oldRead;
    await expect(client.tasks()).resolves.toEqual([{ id: "new" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])("clears fresh snapshots after HTTP %s, including on uncached identity reads", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json([{ id: "private" }]))
      .mockResolvedValueOnce(new Response("Denied", { status }))
      .mockResolvedValueOnce(new Response("Denied", { status }));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    await client.tasks();
    await expect(client.me()).rejects.toMatchObject({ status });
    await expect(client.tasks()).rejects.toMatchObject({ status });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not promote an offline fallback to a fresh server-confirmed snapshot", async () => {
    const store = new MemoryStore();
    store.cache.set("tasks", [{ id: "offline" }]);
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, offlineStore: store, readFreshnessMs: 60_000 });
    await expect(client.tasks()).resolves.toEqual([{ id: "offline" }]);
    await expect(client.tasks(undefined, { allowCacheFallback: false })).rejects.toBeInstanceOf(NetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("drops a fresh snapshot when forced revalidation fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json([{ id: "old" }])).mockRejectedValue(new Error("offline"));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    await client.tasks();
    await expect(client.tasks(undefined, { forceRefresh: true })).rejects.toBeInstanceOf(NetworkError);
    await expect(client.tasks()).rejects.toBeInstanceOf(NetworkError);
  });

  it("isolates credential changes and invalidates pending snapshots on session reset", async () => {
    const old = deferredResponse();
    let token: string | undefined = "owner-one";
    const fetchImpl = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(json([{ id: "owner-two" }])).mockResolvedValueOnce(json([]));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, getToken: () => token, readFreshnessMs: 60_000 });
    const oldRead = client.tasks();
    await Promise.resolve();
    token = "owner-two";
    await expect(client.tasks()).resolves.toEqual([{ id: "owner-two" }]);
    old.resolve(json([{ id: "owner-one" }]));
    await oldRead;
    await expect(client.tasks()).resolves.toEqual([{ id: "owner-two" }]);
    client.clearReadCache();
    token = undefined;
    await expect(client.tasks()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects already aborted reads and keeps caller cancellation independent", async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    await client.tasks();
    const aborted = new AbortController(); aborted.abort();
    await expect(client.tasks(undefined, { signal: aborted.signal })).rejects.toBeInstanceOf(NetworkError);
    await client.tasks(undefined, { signal: new AbortController().signal });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("leaves notification polling, identity, sync and Telegram status live", async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    for (let i = 0; i < 2; i += 1) await Promise.all([client.me(), client.notifications(), client.syncStatus(), client.telegramStatus()]);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });

  it("bounds memory retained for filtered navigation queries", async () => {
    const fetchImpl = vi.fn(async () => json([]));
    const client = new ApiClient({ baseUrl: "", fetch: fetchImpl, readFreshnessMs: 60_000 });
    for (let i = 0; i <= 100; i += 1) await client.tasks({ project_id: String(i) });
    await client.tasks({ project_id: "100" });
    expect(fetchImpl).toHaveBeenCalledTimes(101);
    await client.tasks({ project_id: "0" });
    expect(fetchImpl).toHaveBeenCalledTimes(102);
  });
});

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

  it("sends English requests and refreshes the cached day after a write", async () => {
    const fetchImpl = vi.fn(async () => json({ day: "2026-11-09" }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, readFreshnessMs: 60_000 });
    await client.englishToday("2026-11-09");
    await client.englishToday("2026-11-09");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await client.englishGenerate("2026-11-09", 5);
    await client.englishToday("2026-11-09");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("https://api.example.test/api/v1/english/today?day=2026-11-09");
    expect(calls[1]![0]).toBe("https://api.example.test/api/v1/english/today/words");
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ day: "2026-11-09", count: 5 });
    await client.englishReview("w 1", "2026-11-09", false);
    expect(calls[3]![0]).toBe("https://api.example.test/api/v1/english/words/w%201/review");
    await client.englishSettings();
    await client.englishSaveSettings({ reminder_enabled: true, reminder_time: "21:00", timezone: "Asia/Almaty" });
    expect(calls[4]![0]).toBe("https://api.example.test/api/v1/english/settings");
    expect(calls[5]![0]).toBe("https://api.example.test/api/v1/english/settings");
    expect(calls[5]![1].method).toBe("PUT");
    expect(JSON.parse(calls[5]![1].body as string)).toEqual({ reminder_enabled: true, reminder_time: "21:00", timezone: "Asia/Almaty" });
  });

  it("sends English course requests, raw audio bodies, and refreshes the cached course after a write", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "l1", content_json: { theme: "Work" }, progress_json: { warmup: { done: true } } }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, readFreshnessMs: 60_000 });
    await client.englishCourse("2026-11-09");
    await client.englishCourse("2026-11-09");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const profile = { goal: "ielts_academic", target_band: "6.5", level: "b1b2", weak_skills: ["speaking"], minutes_per_day: 120, exam_date: null } as const;
    await client.englishSaveProfile(profile);
    const lesson = await client.englishLessonToday("2026-11-09");
    expect(lesson.content.theme).toBe("Work");
    expect(lesson.progress.warmup?.done).toBe(true);
    await client.englishBlockDone("l 1", "vocab", 15);
    await client.englishSentences("l1", [{ word_id: "w1", sentence: "I like it." }]);
    await client.englishListening("l1", { "1": "work experience" });
    await client.englishSpeaking("l1", { round: 4, transcript: "hello there", duration_sec: 61 });
    await client.englishSubmitReport("2026-11-09", "text", "task2");
    await client.englishCreateMock({ day: "2026-11-09", listening: "6.0" });
    await client.englishMocks();
    await client.englishCourse("2026-11-09");
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("https://api.example.test/api/v1/english/course?day=2026-11-09");
    expect(calls[1]![0]).toBe("https://api.example.test/api/v1/english/course/profile");
    expect(calls[1]![1].method).toBe("PUT");
    expect(calls[2]![0]).toBe("https://api.example.test/api/v1/english/lessons/today");
    expect(calls[3]![0]).toBe("https://api.example.test/api/v1/english/lessons/l%201/blocks/vocab/done");
    expect(JSON.parse(calls[3]![1].body as string)).toEqual({ minutes: 15 });
    expect(calls[4]![0]).toBe("https://api.example.test/api/v1/english/lessons/l1/sentences");
    expect(calls[5]![0]).toBe("https://api.example.test/api/v1/english/lessons/l1/listening");
    expect(JSON.parse(calls[6]![1].body as string)).toEqual({ round: 4, transcript: "hello there", duration_sec: 61 });
    expect(JSON.parse(calls[7]![1].body as string)).toEqual({ day: "2026-11-09", text: "text", kind: "task2" });
    expect(calls[8]![0]).toBe("https://api.example.test/api/v1/english/mocks");
    expect(calls).toHaveLength(11); // the course read after the writes was refetched
  });

  it("sends a Blob body raw with its audio media type", async () => {
    const fetchImpl = vi.fn(async () => json({ text: "hi", duration_sec: 2 }));
    const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, token: "tok" });
    const audio = new Blob(["abc"], { type: "audio/webm" });
    await expect(client.englishTranscribe(audio)).resolves.toEqual({ text: "hi", duration_sec: 2 });
    const [url, init] = (fetchImpl.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(url).toBe("https://api.example.test/api/v1/english/speech/transcribe");
    expect(init.headers).toMatchObject({ "Content-Type": "audio/webm", Authorization: "Bearer tok" });
    expect(init.body).toBe(audio);
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

it("does not cache owner memory or replay an unconfirmed forget", async () => {
  const store = new MemoryStore();
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "fact", text: "private remembered fact" }]), { status: 200 }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("offline"));
  const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl, offlineStore: store });
  await expect(client.ownerMemory()).resolves.toHaveLength(1);
  await expect(client.ownerMemory()).rejects.toBeInstanceOf(NetworkError);
  await expect(client.forgetMemoryFact("fact", 3)).rejects.toBeInstanceOf(NetworkError);
  expect(store.cache.size).toBe(0); expect(store.outbox).toHaveLength(0);
  expect(fetchImpl.mock.calls[2]?.[0]).toContain("/ai/memory/fact?version=3");
});

it("never caches chat permissions or queues manual Telegram sends",async()=>{
  const store=new MemoryStore();const fetchImpl=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify([]),{status:200}))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(JSON.stringify({id:'outgoing'}),{status:200}));
  const client=new ApiClient({baseUrl:'https://api.example.test',fetch:fetchImpl,offlineStore:store});
  await client.telegramChats({cacheKey:'forged-cache'});
  await expect(client.sendTelegramChatMessage({business_connection_id:'c',chat_id:1,text:'One message'},{idempotencyKey:'stable-key',queueOnOffline:true})).rejects.toBeInstanceOf(NetworkError);
  await client.sendTelegramChatMessage({business_connection_id:'c',chat_id:1,text:'One message'},{idempotencyKey:'stable-key'});
  expect(store.cache.size).toBe(0);expect(store.outbox).toHaveLength(0);
  expect(new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get('Idempotency-Key')).toBe('stable-key');
});

it('downloads private media in memory with auth only in headers and no cache',async()=>{
 const store=new MemoryStore();const fetchImpl=vi.fn().mockResolvedValue(new Response(new Uint8Array([0x89,0x50,0x4e,0x47]),{headers:{'Content-Type':'image/png'}}));
 const client=new ApiClient({baseUrl:'https://api.example.test',token:'synthetic-access',fetch:fetchImpl,offlineStore:store});
 const blob=await client.telegramMessageMedia('photo/id');expect(blob.type).toBe('image/png');expect(blob.size).toBe(4);
 expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.test/api/v1/integrations/telegram/messages/photo%2Fid/media');
 expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer synthetic-access');
 expect(fetchImpl.mock.calls[0]?.[1]?.cache).toBe('no-store');expect(store.cache.size).toBe(0);expect(store.outbox).toHaveLength(0);
});

it.each([
 [200,{'Content-Type':'image/svg+xml'},'<svg>secret</svg>','TELEGRAM_MEDIA_UNSUPPORTED'],
 [200,{'Content-Type':'image/png','Content-Length':'20971521'},'too big','TELEGRAM_MEDIA_TOO_LARGE'],
 [403,{'Content-Type':'application/json'},JSON.stringify({detail:{code:'POLICY_DENIED',message:'Denied'}}),'POLICY_DENIED'],
] as const)('rejects unsafe media response %s without caching',async(status,headers,body,code)=>{
 const store=new MemoryStore();const fetchImpl=vi.fn().mockResolvedValue(new Response(body,{status,headers}));
 const client=new ApiClient({baseUrl:'https://api.example.test',fetch:fetchImpl,offlineStore:store});
 await expect(client.telegramMessageMedia('media')).rejects.toMatchObject({code});expect(store.cache.size).toBe(0);
});

it('binds optional reply target in the manual send request',async()=>{
 const fetchImpl=vi.fn().mockResolvedValue(new Response(JSON.stringify({id:'quoted'}),{status:200}));
 const client=new ApiClient({baseUrl:'https://api.example.test',fetch:fetchImpl});
 await client.sendTelegramChatMessage({business_connection_id:'c',chat_id:1,text:'Reply',reply_to_message_id:7},{idempotencyKey:'quoted-key'});
 expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({business_connection_id:'c',chat_id:1,text:'Reply',reply_to_message_id:7});
});

it("calls the AI chat endpoints: pin, scopes, actions, attachments, feedback and attachment_ids", async () => {
  const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: "x" })));
  const client = new ApiClient({ baseUrl: "https://api.example.test", fetch: fetchImpl });
  await client.updateAIConversation("c 1", { pinned: true, scopes: ["tasks.read"] });
  await client.aiConversationActions("c1");
  await client.approveAIAction("a1");
  await client.rejectAIAction("a2");
  await client.uploadAIAttachment({ name: "n.txt", content_base64: "aGk=" });
  await client.deleteAIAttachment("f1");
  await client.setAIMessageFeedback("m1", "up");
  await client.createAIRun({ conversation_id: "c1", message: "hi", attachment_ids: ["f1"], idempotency_key: "k" });
  const calls = fetchImpl.mock.calls.map(([url, init]) => [String(url).replace("https://api.example.test", ""), init?.method, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);
  expect(calls).toEqual([
    ["/api/v1/ai/conversations/c%201", "PATCH", { pinned: true, scopes: ["tasks.read"] }],
    ["/api/v1/ai/conversations/c1/actions", "GET", undefined],
    ["/api/v1/ai/actions/a1/approve", "POST", undefined],
    ["/api/v1/ai/actions/a2/reject", "POST", undefined],
    ["/api/v1/ai/attachments", "POST", { name: "n.txt", content_base64: "aGk=" }],
    ["/api/v1/ai/attachments/f1", "DELETE", undefined],
    ["/api/v1/ai/messages/m1", "PATCH", { feedback: "up" }],
    ["/api/v1/ai/runs", "POST", { conversation_id: "c1", message: "hi", attachment_ids: ["f1"], idempotency_key: "k" }],
  ]);
});


it("does not persist a late response after its owner partition was replaced", async () => {
  const store = new MemoryStore();
  const response = deferredResponse();
  let allowed = true;
  const client = new ApiClient({ baseUrl: "", offlineStore: store, fetch: vi.fn(() => response.promise), canUseCache: () => allowed });
  const reading = client.tasks();
  allowed = false;
  client.clearReadCache();
  response.resolve(json([{ id: "previous-owner" }]));
  await reading;
  expect(store.cache.size).toBe(0);
});


it("caches HTML details per message and invalidates them after Gmail sync", async () => {
  const store = new MemoryStore();
  const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
    if (url.endsWith('/sync')) return json({ imported: 0 });
    return json({ id: url.split('/').pop(), body: 'Plain', body_html: '<b>Rich</b>' });
  });
  let online = true;
  const client = new ApiClient({ baseUrl: 'https://api.example.test', token: 'owner', fetch: fetchImpl, offlineStore: store, readFreshnessMs: 60_000, isOnline: () => online });
  await client.mailMessage('one'); await client.mailMessage('one');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await client.mailMessage('two');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  online = false;
  await expect(client.mailMessage('one')).resolves.toMatchObject({ id: 'one', body_html: '<b>Rich</b>' });
  online = true;
  await client.syncGmail('account');
  expect(store.cache.has('mail-details?id=one')).toBe(false);
  await client.mailMessage('one');
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});
