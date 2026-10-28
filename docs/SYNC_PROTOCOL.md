# Aelys — Offline-first Sync Protocol v0.2

## 1. Mission / scope

Synchronize owner-approved user domain objects (Projects, Notes, Tasks, Events, Finance, Focus, selected Mail metadata, AI chat history by retention policy) across Web/macOS/Android. **Never synchronize raw local Claude Code/Codex CLI transcripts, command logs, local session embeddings or secret material.** Only sanitized cloud session index is eligible.

## 2. Stores / consistency

- PostgreSQL server is authoritative for **synced** domain objects and ordered commit log.
- macOS/Android SQLite and Web IndexedDB allow durable local writes and reads, including while offline.
- Eventual consistency across devices; strong validation and per-resource optimistic concurrency on server.
- Locally saved changes are marked pending/acked/conflict; no silent loss or rollback without explanation.

## 3. Data flow

```text
local command -> local transaction(entity update + outbox op)
   -> push batch (idempotent client operation UUID)
   -> server: auth + policy + version check + domain transaction + change_log
   -> operation receipt / version / cursor
   -> pull on other devices (ordered, resumable)
   -> apply to local store / ack cursor
```

For web, use IndexedDB transaction semantics where possible; ensure crash-safe operation queue. Do not rely on a volatile React store as the source of truth.

## 4. Operation envelope

```json
{
  "operation_id":"uuid",
  "device_id":"uuid",
  "resource_kind":"task",
  "resource_id":"uuid",
  "action":"update",
  "base_version":3,
  "client_timestamp":"2026-10-28T00:00:00Z",
  "patch":{"status":"done"}
}
```

The server timestamp/order wins for authoritative log position, but not for choosing content when there is a conflict. `client_timestamp` is advisory only (clock skew tolerance).

## 5. Cursor / snapshots

- Use an **opaque owner-bound sync cursor**, not client-controllable unfiltered DB offset. Internally it refers to an ordered committed sequence/snapshot watermark.
- `/sync/bootstrap` provides consistent initial snapshot plus cursor; pagination must not mix states across a snapshot without a stable boundary.
- `pull` returns stable ordered changes `seq > cursor` up to limit; returning the cursor safely guarantees no missing concurrent committed changes (commit-order design required; simple `BIGSERIAL` allocation order is **not sufficient** if transactions commit out of order).
- Tombstones retained until relevant devices have acked or exceeded retention policy; old devices must full-bootstrap if cursor compacted.
- Resumption after interruption and replay of applied changes must be safe.

## 6. Conflict handling

| Entity | v1 conflict strategy |
|---|---|
| Task title/status/meta | base_version check; conflict return current server record; explicit chosen merge/retry |
| Notes Markdown | create conflict branch/revision with both complete bodies; no silent overwrite |
| Calendar time/recurrence | reject divergent updates and request resolution; protect exceptions |
| Finance transaction | immutable posting identifier, audited correction; never duplicate or change monetary values silently |
| Focus timer | single active owner-timer policy, lease/optimistic transition; elapsed from instants, not page heartbeat |
| Delete vs edit | tombstone with conflict record/recovery mechanism |

Optionally develop CRDT only after spike proves it beneficial; no need for multiplayer collaboration in MVP.

## 7. Attachments

- Local blob digest SHA-256 and local attachment record; queued upload retries.
- Server storage backend not fixed. Metadata write and blob upload states separate; references not considered available until upload verification.
- Set max size, MIME/type scanning policy, encryption/privacy boundaries before allowing general arbitrary files.
- Local agent transcript files are not normal attachments and cannot be uploaded by default.

## 8. Network / battery constraints

- Pull after push, on app resume, foreground changes, manual refresh and permitted periodic background jobs.
- SSE/push events may hint clients to pull but are not the only source of truth.
- Android background execution can be delayed by OS; no guarantee of instant sync when app suspended.
- Retry with exponential backoff and jitter; bound batch size; auth revocation stops further sync.

## 9. Data deletion and reset

- Logout or revoke device: invalidate credentials, offer erase of local synchronized private data.
- Delete project: avoid cascades that silently erase unrelated linked resources; explicitly distinguish unlink/archive/permanent delete.
- User export: canonical JSON + notes and files where authorized; import must avoid duplicate UUIDs.
- Backups and retention policies in SECURITY.md/OPEN_QUESTIONS.md.

## 10. Failure tests (release gate)

1. Offline create/edit 100 records → connection restored → exactly one server entity per UUID, no duplicates.
2. Push same batch five times → same result and versions.
3. Concurrent edit same Markdown on two offline devices → both revisions recoverable.
4. Delete on A, edit same resource on B offline → explicit recoverable conflict.
5. Kill app during local save/push/pull → durable outbox and monotonic cursor.
6. Revoke Android and attempt push → rejected with no writes.
7. Malicious `resource_kind=agent_session` body containing transcript → server rejects by schema/policy.
8. Sync page boundary with concurrent commits → no missed changes and repeat-safe apply.
9. Backlogged offline device after log compaction → correct bootstrap reset.
