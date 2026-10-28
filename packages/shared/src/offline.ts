import type { JsonValue } from "./types";

export interface OutboxRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly idempotencyKey: string;
}

export interface OutboxEntry {
  readonly id: string;
  readonly request: OutboxRequest;
  readonly createdAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
}

export interface OfflineStore {
  enqueue(request: OutboxRequest): Promise<OutboxEntry>;
  listOutbox(now?: number): Promise<readonly OutboxEntry[]>;
  updateOutbox(id: string, patch: Pick<OutboxEntry, "attempts" | "nextAttemptAt">): Promise<void>;
  removeOutbox(id: string): Promise<void>;
  getCache<T>(key: string): Promise<T | undefined>;
  setCache<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  removeCache(key: string): Promise<void>;
}

interface OutboxRecord extends OutboxEntry { readonly kind: "outbox"; }
interface CacheRecord { readonly key: string; readonly value: unknown; readonly expiresAt: number | null; }

function id(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `outbox-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "id" });
      if (!database.objectStoreNames.contains("cache")) database.createObjectStore("cache", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Durable browser outbox/cache. It stores request bodies, never auth tokens. */
export class IndexedDbOfflineStore implements OfflineStore {
  private readonly database: Promise<IDBDatabase>;

  public constructor(
    name = "aelys-shared",
    version = 1,
    factory: IDBFactory = globalThis.indexedDB,
  ) {
    if (!factory) throw new Error("IndexedDB is not available in this runtime");
    this.database = openDatabase(factory, name, version);
  }

  public async enqueue(request: OutboxRequest): Promise<OutboxEntry> {
    const entry: OutboxRecord = { kind: "outbox", id: id(), request, createdAt: Date.now(), attempts: 0, nextAttemptAt: Date.now() };
    const database = await this.database;
    const transaction = database.transaction("outbox", "readwrite");
    transaction.objectStore("outbox").put(entry);
    await transactionDone(transaction);
    return entry;
  }

  public async listOutbox(now = Date.now()): Promise<readonly OutboxEntry[]> {
    const database = await this.database;
    const transaction = database.transaction("outbox", "readonly");
    const request = transaction.objectStore("outbox").getAll();
    const result = await new Promise<readonly OutboxEntry[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as readonly OutboxRecord[]).filter((entry) => entry.nextAttemptAt <= now));
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
    await transactionDone(transaction);
    return [...result].sort((left, right) => left.createdAt - right.createdAt);
  }

  public async updateOutbox(idValue: string, patch: Pick<OutboxEntry, "attempts" | "nextAttemptAt">): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction("outbox", "readwrite");
    const store = transaction.objectStore("outbox");
    const request = store.get(idValue);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        if (!request.result) { reject(new Error(`Outbox entry not found: ${idValue}`)); return; }
        store.put({ ...(request.result as OutboxRecord), ...patch });
        resolve();
      };
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
    await transactionDone(transaction);
  }

  public async removeOutbox(idValue: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction("outbox", "readwrite");
    transaction.objectStore("outbox").delete(idValue);
    await transactionDone(transaction);
  }

  public async getCache<T>(key: string): Promise<T | undefined> {
    const database = await this.database;
    const transaction = database.transaction("cache", "readonly");
    const request = transaction.objectStore("cache").get(key);
    const value = await new Promise<CacheRecord | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as CacheRecord | undefined);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
    await transactionDone(transaction);
    if (!value || (value.expiresAt !== null && value.expiresAt <= Date.now())) {
      if (value) await this.removeCache(key);
      return undefined;
    }
    return value.value as T;
  }

  public async setCache<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction("cache", "readwrite");
    const record: CacheRecord = { key, value, expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs };
    transaction.objectStore("cache").put(record);
    await transactionDone(transaction);
  }

  public async removeCache(key: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction("cache", "readwrite");
    transaction.objectStore("cache").delete(key);
    await transactionDone(transaction);
  }
}

export type OfflineJson = JsonValue;
