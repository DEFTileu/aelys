import { describe, expect, it } from "vitest";
import type { EntityKey, OutboxRequest } from "../src/offline";
import { IndexedDbOfflineStore } from "../src/offline";

type StoredRecord = Record<string, unknown>;

interface FakeDatabaseState {
  version: number;
  stores: Map<string, Map<string, StoredRecord>>;
}

class FakeRequest<T> {
  public result: T | undefined;
  public error: DOMException | null = null;
  public onsuccess: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null = null;

  public succeed(result: T | undefined): void {
    this.result = result;
    this.onsuccess?.(new Event("success"));
  }
}

class FakeTransaction {
  public readonly storeNames: readonly string[];
  public readonly mode: IDBTransactionMode;
  public oncomplete: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;
  private readonly pending: Array<() => void> = [];
  private completionScheduled = false;

  public constructor(private readonly state: FakeDatabaseState, names: string | readonly string[], mode: IDBTransactionMode) {
    this.storeNames = typeof names === "string" ? [names] : [...names];
    this.mode = mode;
  }

  public objectStore(name: string): FakeObjectStore {
    if (!this.storeNames.includes(name)) throw new Error(`Store not in transaction: ${name}`);
    const store = this.state.stores.get(name);
    if (!store) throw new Error(`Unknown store: ${name}`);
    return new FakeObjectStore(this, store);
  }

  public add(operation: () => void): void {
    this.pending.push(operation);
    this.scheduleCompletion();
  }

  private scheduleCompletion(): void {
    if (this.completionScheduled) return;
    this.completionScheduled = true;
    queueMicrotask(() => {
      for (const operation of this.pending) operation();
      queueMicrotask(() => this.oncomplete?.());
    });
  }
}

class FakeObjectStore {
  public constructor(private readonly transaction: FakeTransaction, private readonly records: Map<string, StoredRecord>) {}

  public put(value: StoredRecord): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.transaction.add(() => {
      const key = String(value.key ?? value.id);
      this.records.set(key, structuredClone(value));
      request.succeed(undefined);
    });
    return request;
  }

  public delete(key: string): FakeRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.transaction.add(() => {
      this.records.delete(key);
      request.succeed(undefined);
    });
    return request;
  }

  public get(key: string): FakeRequest<StoredRecord | undefined> {
    const request = new FakeRequest<StoredRecord | undefined>();
    this.transaction.add(() => request.succeed(this.records.has(key) ? structuredClone(this.records.get(key)) : undefined));
    return request;
  }

  public getAll(): FakeRequest<StoredRecord[]> {
    const request = new FakeRequest<StoredRecord[]>();
    this.transaction.add(() => request.succeed([...this.records.values()].map((record) => structuredClone(record))));
    return request;
  }

  public getAllKeys(): FakeRequest<IDBValidKey[]> {
    const request = new FakeRequest<IDBValidKey[]>();
    this.transaction.add(() => request.succeed([...this.records.keys()]));
    return request;
  }
}

class FakeDatabase {
  public readonly objectStoreNames = { contains: (name: string) => this.state.stores.has(name) } as unknown as DOMStringList;

  public constructor(private readonly state: FakeDatabaseState, private readonly factory: FakeIndexedDb) {}

  public createObjectStore(name: string): FakeObjectStore {
    if (this.state.stores.has(name)) throw new Error(`Store already exists: ${name}`);
    this.state.stores.set(name, new Map());
    return new FakeObjectStore(new FakeTransaction(this.state, [name], "versionchange"), this.state.stores.get(name) as Map<string, StoredRecord>);
  }

  public transaction(names: string | readonly string[], mode: IDBTransactionMode): FakeTransaction {
    const transaction = new FakeTransaction(this.state, names, mode);
    this.factory.transactions.push(transaction);
    return transaction;
  }

  public close(): void {}
}

class FakeIndexedDb {
  public readonly transactions: FakeTransaction[] = [];
  private readonly databases = new Map<string, FakeDatabaseState>();

  public seedVersionOne(name: string): void {
    this.databases.set(name, { version: 1, stores: new Map([["outbox", new Map()], ["cache", new Map()]]) });
  }

  public open(name: string, version: number): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    queueMicrotask(() => {
      let state = this.databases.get(name);
      const oldVersion = state?.version ?? 0;
      if (!state) {
        state = { version: 0, stores: new Map() };
        this.databases.set(name, state);
      }
      const database = new FakeDatabase(state, this);
      request.result = database;
      if (version > oldVersion) {
        request.onupgradeneeded?.({ oldVersion, newVersion: version } as IDBVersionChangeEvent);
        state.version = version;
      }
      request.succeed(database);
    });
    return request;
  }
}

function request(key: EntityKey): OutboxRequest {
  return { method: "PUT", path: `/api/v1/tasks/${key}`, body: { title: "Offline task" }, idempotencyKey: `operation-${key}` };
}

describe("IndexedDbOfflineStore entities", () => {
  it("invalidates only a collection and its query variants across reopen", async () => {
    const factory = new FakeIndexedDb();
    const first = new IndexedDbOfflineStore("invalidate-test", 2, factory as unknown as IDBFactory);
    for (const key of ["tasks", "tasks?project_id=a", "tasks?project_id=b", "tasks-extra", "notes?project_id=a"]) await first.setCache(key, key);
    const pending = await first.setEntityAndEnqueue("pending:tasks:1", { pending: true }, request("1"));
    await first.invalidateCache("tasks");
    expect(factory.transactions.at(-1)?.storeNames).toEqual(["cache"]);
    const reopened = new IndexedDbOfflineStore("invalidate-test", 2, factory as unknown as IDBFactory);
    for (const key of ["tasks", "tasks?project_id=a", "tasks?project_id=b"]) await expect(reopened.getCache(key)).resolves.toBeUndefined();
    for (const key of ["tasks-extra", "notes?project_id=a"]) await expect(reopened.getCache(key)).resolves.toBe(key);
    await expect(reopened.getEntity("pending:tasks:1")).resolves.toEqual(pending.entity);
    await expect(reopened.listOutbox()).resolves.toEqual([pending.outbox]);
  });
  it("migrates a version-1 database and keeps an entity across store instances", async () => {
    const factory = new FakeIndexedDb();
    factory.seedVersionOne("migration-test");
    const first = new IndexedDbOfflineStore("migration-test", 1, factory as unknown as IDBFactory);

    await first.setCache("legacy", { retained: true });
    await first.setEntity("task-1", { title: "Persisted" }, 123);

    const second = new IndexedDbOfflineStore("migration-test", 1, factory as unknown as IDBFactory);
    await expect(second.getCache<{ retained: boolean }>("legacy")).resolves.toEqual({ retained: true });
    await expect(second.getEntity<{ title: string }>("task-1")).resolves.toEqual({ key: "task-1", value: { title: "Persisted" }, updatedAt: 123 });
  });

  it("writes the entity and outbox request in one readwrite transaction", async () => {
    const factory = new FakeIndexedDb();
    const store = new IndexedDbOfflineStore("atomic-test", 1, factory as unknown as IDBFactory);

    const result = await store.setEntityAndEnqueue("task-2", { title: "Offline" }, request("task-2"));
    const transaction = factory.transactions.at(-1);
    expect(transaction?.mode).toBe("readwrite");
    expect(transaction?.storeNames).toEqual(["entities", "outbox"]);
    await expect(store.getEntity<{ title: string }>("task-2")).resolves.toEqual(result.entity);
    await expect(store.listOutbox()).resolves.toEqual([result.outbox]);
  });

  it("supports entity removal without affecting the outbox", async () => {
    const factory = new FakeIndexedDb();
    const store = new IndexedDbOfflineStore("remove-test", 2, factory as unknown as IDBFactory);
    await store.setEntity("task-3", { title: "To remove" });
    await store.removeEntity("task-3");

    await expect(store.getEntity("task-3")).resolves.toBeUndefined();
    await expect(store.listOutbox()).resolves.toEqual([]);
  });

  it("rejects sensitive fields before durable storage", async () => {
    const factory = new FakeIndexedDb();
    const store = new IndexedDbOfflineStore("secrets-test", 2, factory as unknown as IDBFactory);

    await expect(store.setEntity("bad-entity", { api_key: "provider-secret" })).rejects.toThrow("Sensitive data");
    await expect(store.setCache("bad-cache", { refresh_token: "refresh-secret" })).rejects.toThrow("Sensitive data");
    await expect(store.enqueue({ ...request("bad-request"), headers: { Authorization: "Bearer access" } })).rejects.toThrow("Sensitive header");
    await expect(store.listOutbox()).resolves.toEqual([]);
    await expect(store.getEntity("bad-entity")).resolves.toBeUndefined();
  });

  it("survives a 100-operation offline batch across a store reopen", async () => {
    const factory = new FakeIndexedDb();
    const first = new IndexedDbOfflineStore("stress-test", 2, factory as unknown as IDBFactory);

    for (let index = 0; index < 100; index += 1) {
      const key = `task-${index}`;
      await first.setEntityAndEnqueue(key, { title: `Offline ${index}`, pending: true }, request(key));
    }

    const second = new IndexedDbOfflineStore("stress-test", 2, factory as unknown as IDBFactory);
    const outbox = await second.listOutbox();
    expect(outbox).toHaveLength(100);
    await expect(second.getEntity<{ title: string; pending: boolean }>("task-0")).resolves.toMatchObject({ value: { title: "Offline 0", pending: true } });
    await expect(second.getEntity<{ title: string; pending: boolean }>("task-99")).resolves.toMatchObject({ value: { title: "Offline 99", pending: true } });
  });
});
