# `@aelys/shared`

Shared frontend foundation for Aelys Web, macOS and Android clients.

The public types mirror the mounted FastAPI application under `/api/v1` and the checked-in `docs/openapi.json`. Wire dates remain ISO-8601 strings. Finance amounts are `DecimalString` values so frontend code cannot accidentally introduce binary floating point rounding.

`ApiClient` is a small fetch-based transport. It adds bearer authentication, generates or forwards an `Idempotency-Key` for mutations, exposes the backend error envelope as `ApiError`, can read/write GET responses through an injected cache, and can enqueue failed mutations in an injected `OfflineStore`. It never puts the bearer token into the outbox. `replayOutbox()` retries queued requests with the current token.

`IndexedDbOfflineStore` provides durable `outbox`, `cache`, and `entities` object stores. Database version 2 creates the `entities` store while preserving version-1 data. `getEntity`, `setEntity`, and `removeEntity` use typed `EntityKey`/`LocalEntity` values. `setEntityAndEnqueue` writes an entity and its sync request in one IndexedDB `readwrite` transaction, matching the local command transaction in `SYNC_PROTOCOL.md`.

`EntityStore` is an optional capability separate from `OfflineStore`, so existing cache/outbox adapters remain source-compatible. Durable writes reject sensitive fields and headers such as authorization, cookies, passwords, provider keys, and bearer tokens. Credentials and BYOK material must use the platform secure store; they are never placed in IndexedDB entities or the outbox. Runtimes without IndexedDB must inject another `OfflineStore` implementation.

The API client only exposes the existing AI and agent control endpoints. It does not execute vendor tools or coding agents.

Run local checks from this directory:

```sh
npm test
npm run typecheck
```
