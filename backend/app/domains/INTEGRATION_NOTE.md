# Domain API integration note

The domain layer is self-contained under `backend/app/domains/`. Import
`all_routers` from `backend.app.domains` and include every router in the
application with the `/api/v1` prefix already present in each router.

The application core must override `common.db_dependency` with the configured
SQLAlchemy `Session` dependency and populate `request.state.owner_id` from
authenticated identity. There is no header fallback: a client-supplied
owner header is never trusted. Domain services accept an
explicit `owner_id`, so core authorization can be tested without FastAPI.

`Base.metadata` includes the domain tables. Alembic migrations must import all
domain model modules before autogeneration. The migration owner is responsible
for adding PostgreSQL-specific FK/check constraints and indexes described in
`docs/DATA_MODEL.md`; this task intentionally did not edit migration paths.

Mail is local/import-only (`local_import`); no Gmail/IMAP sender is claimed.
AI provider `secret_ref` is an opaque reference to a core-managed encrypted
secret store and is never returned by the provider response schema. The AI
router exposes typed provider/conversation/message/run contracts and a replayable
SSE event stream, but the concrete Claude/OpenRouter transport remains an
adapter owned by the AI runtime.

The sync helper rejects private agent transcript/message/embedding resource
kinds, stores only typed patches, and is idempotent by `operation_id`. Full
Mac agent sessions must stay in the local runtime; only the allowlisted index
metadata belongs in a future agent domain module.

Open questions left unresolved by design: live Gmail scope, provider secret
location (the abstraction is ready), and the final SQL migration strategy for
PostgreSQL commit-order cursors. No proposed decision was promoted to
`DECIDED` here.
