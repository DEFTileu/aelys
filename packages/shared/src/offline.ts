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

export type EntityKey = string;

export interface LocalEntity<T = unknown> {
  readonly key: EntityKey;
  readonly value: T;
  readonly updatedAt: number;
}

export interface AtomicEntityWrite<T = unknown> {
  readonly entity: LocalEntity<T>;
  readonly outbox: OutboxEntry;
}

export interface OfflineStore {
  enqueue(request: OutboxRequest): Promise<OutboxEntry>;
  listOutbox(now?: number): Promise<readonly OutboxEntry[]>;
  updateOutbox(id: string, patch: Pick<OutboxEntry, "attempts" | "nextAttemptAt">): Promise<void>;
  removeOutbox(id: string): Promise<void>;
  getCache<T>(key: string): Promise<T | undefined>;
  setCache<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  removeCache(key: string): Promise<void>;
  /** Remove the built-in collection key and its query variants, without touching entities or outbox. */
  invalidateCache?(root: string): Promise<void>;
}

/** Optional durable entity capability. Kept separate so existing adapters remain compatible. */
export interface EntityStore {
  getEntity<T>(key: EntityKey): Promise<LocalEntity<T> | undefined>;
  setEntity<T>(key: EntityKey, value: T, updatedAt?: number): Promise<LocalEntity<T>>;
  removeEntity(key: EntityKey): Promise<void>;
  setEntityAndEnqueue<T>(key: EntityKey, value: T, request: OutboxRequest): Promise<AtomicEntityWrite<T>>;
}

export type DurableOfflineStore = OfflineStore & EntityStore;

interface OutboxRecord extends OutboxEntry { readonly kind: "outbox"; }
interface CacheRecord { readonly key: string; readonly value: unknown; readonly expiresAt: number | null; }
interface EntityRecord<T = unknown> extends LocalEntity<T> { readonly kind: "entity"; }

const CURRENT_DATABASE_VERSION = 2;
const SENSITIVE_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
  "xapikey",
]);

function normalizedFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function assertPersistable(value: unknown, location: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPersistable(item, `${location}[${index}]`, seen));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_NAMES.has(normalizedFieldName(key))) {
      throw new Error(`Sensitive data cannot be persisted in offline storage: ${location}.${key}`);
    }
    assertPersistable(child, `${location}.${key}`, seen);
  }
}

function assertValidEntityKey(key: EntityKey): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw new Error("Entity key must be a non-empty string of at most 512 characters");
  }
}

function assertPersistableRequest(request: OutboxRequest): void {
  for (const key of Object.keys(request.headers ?? {})) {
    if (SENSITIVE_FIELD_NAMES.has(normalizedFieldName(key))) {
      throw new Error(`Sensitive header cannot be persisted in offline storage: ${key}`);
    }
  }
  assertPersistable(request.query, "request.query");
  assertPersistable(request.body, "request.body");
}

function id(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `outbox-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function openDatabase(factory: IDBFactory, name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Version 2 adds entities. Opening an older requested version still upgrades
    // safely so callers that used the version-1 default receive the migration.
    const request = factory.open(name, Math.max(version, CURRENT_DATABASE_VERSION));
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "id" });
      if (!database.objectStoreNames.contains("cache")) database.createObjectStore("cache", { keyPath: "key" });
      if (!database.objectStoreNames.contains("entities")) database.createObjectStore("entities", { keyPath: "key" });
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
export class IndexedDbOfflineStore implements OfflineStore, EntityStore {
  private readonly database: Promise<IDBDatabase>;

  public constructor(
    name = "aelys-shared",
    version = CURRENT_DATABASE_VERSION,
    factory: IDBFactory = globalThis.indexedDB,
  ) {
    if (!factory) throw new Error("IndexedDB is not available in this runtime");
    this.database = openDatabase(factory, name, version);
  }

  public async enqueue(request: OutboxRequest): Promise<OutboxEntry> {
    assertPersistableRequest(request);
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
    assertPersistable(value, `cache.${key}`);
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

  public async invalidateCache(root: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction("cache", "readwrite");
    const store = transaction.objectStore("cache");
    const request = store.getAllKeys();
    request.onsuccess = () => {
      for (const key of request.result) {
        if (typeof key === "string" && (key === root || key.startsWith(`${root}?`))) store.delete(key);
      }
    };
    await transactionDone(transaction);
  }

  public async getEntity<T>(key: EntityKey): Promise<LocalEntity<T> | undefined> {
    assertValidEntityKey(key);
    const database = await this.database;
    const transaction = database.transaction("entities", "readonly");
    const request = transaction.objectStore("entities").get(key);
    const value = await new Promise<EntityRecord<T> | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as EntityRecord<T> | undefined);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
    });
    await transactionDone(transaction);
    if (!value) return undefined;
    return { key: value.key, value: value.value, updatedAt: value.updatedAt };
  }

  public async setEntity<T>(key: EntityKey, value: T, updatedAt = Date.now()): Promise<LocalEntity<T>> {
    assertValidEntityKey(key);
    assertPersistable(value, `entity.${key}`);
    const entity: EntityRecord<T> = { kind: "entity", key, value, updatedAt };
    const database = await this.database;
    const transaction = database.transaction("entities", "readwrite");
    transaction.objectStore("entities").put(entity);
    await transactionDone(transaction);
    return { key: entity.key, value: entity.value, updatedAt: entity.updatedAt };
  }

  public async removeEntity(key: EntityKey): Promise<void> {
    assertValidEntityKey(key);
    const database = await this.database;
    const transaction = database.transaction("entities", "readwrite");
    transaction.objectStore("entities").delete(key);
    await transactionDone(transaction);
  }

  public async setEntityAndEnqueue<T>(key: EntityKey, value: T, request: OutboxRequest): Promise<AtomicEntityWrite<T>> {
    assertValidEntityKey(key);
    assertPersistable(value, `entity.${key}`);
    assertPersistableRequest(request);
    const now = Date.now();
    const entity: EntityRecord<T> = { kind: "entity", key, value, updatedAt: now };
    const outbox: OutboxRecord = { kind: "outbox", id: id(), request, createdAt: now, attempts: 0, nextAttemptAt: now };
    const database = await this.database;
    const transaction = database.transaction(["entities", "outbox"], "readwrite");
    transaction.objectStore("entities").put(entity);
    transaction.objectStore("outbox").put(outbox);
    await transactionDone(transaction);
    return {
      entity: { key: entity.key, value: entity.value, updatedAt: entity.updatedAt },
      outbox,
    };
  }
}

export type OfflineJson = JsonValue;
