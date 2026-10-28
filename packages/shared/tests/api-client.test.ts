import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, NetworkError, OfflineQueuedError } from "../src/api-client";
import type { OfflineStore, OutboxEntry, OutboxRequest } from "../src/offline";

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
}

describe("ApiClient", () => {
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

  it("durably queues a mutation on network failure and never stores Authorization", async () => {
    const store = new MemoryStore();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const client = new ApiClient({ baseUrl: "https://api.example.test", token: "secret", fetch: fetchImpl, offlineStore: store });
    const result = client.createNote({ title: "Offline note" }, { headers: { Authorization: "caller-secret" } });
    await expect(result).rejects.toBeInstanceOf(OfflineQueuedError);
    expect(store.outbox[0]?.request).toMatchObject({ method: "POST", path: "/api/v1/notes", body: { title: "Offline note" } });
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
});
