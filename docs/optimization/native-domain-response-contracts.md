# Native domain mutation response contracts

Task: IMPLEMENTATION_PLAN Phase 8, performance/contract regression checks.
Date: 2026-10-30. Scope: existing Projects, Notes and Focus native operations.

## Reproduction

Backend create/PATCH endpoints return one domain object. Focus start/stop also
return one object, while the corresponding list endpoints return arrays.
Native response selection already used `project` and `note` for mutations, but
the sanitizer had no matching handlers. Focus used the array handler for every
route, including POST start and stop. Successful backend writes therefore
surfaced as `MUTATION_OUTCOME_UNKNOWN` in the packaged client.

Three new loopback HTTP regression tests exercised the full Rust operation
dispatch, HTTP response and sanitizer path. Before the fix, all three failed:
each expected a successful object but received `MUTATION_OUTCOME_UNKNOWN`.

## Fix and evidence

The sanitizer now converts singular `Project`, `Note` and `Focus` responses
through their existing explicit structs. Focus uses the list handler for GET
and the singular handler for its existing POST operations. No new API route,
permission, retry, credential handling or schema is introduced.

The three tests cover nine round trips: Projects create/PATCH/list; Notes
create/PATCH/list; Focus start/stop/list. Fixtures follow the active backend
`ProjectResponse`, `NoteOut` and `FocusOut` shapes. They assert typed output,
list/object separation, versioned route paths and removal of extra server-only
fields. They use synthetic local sessions, not the owner's database or keys.

Validation:

- `cargo test --locked`: 16 passed, no failures (including the previous AI
  cancellation and late-session-response regressions).
- `cargo fmt --check`: passed.
- `cargo clippy --locked -- -D warnings`: passed.
- `pnpm --filter @aelys/desktop exec tauri build --ci --no-sign --bundles app`:
  passed, including production web build. Unsigned arm64 bundle: 26.71 MiB.
  Release and bundled executable SHA-256 match:
  `9b40acabfd17399f24314325ccc6098c2c9f338d6240b6af3bd0949a3b64163c`.

These tests prove Rust HTTP adapter behavior with fixtures; authenticated GUI
CRUD, Keychain restart and Android device acceptance remain separate gates.
Frontend and backend code are unchanged in this slice.
