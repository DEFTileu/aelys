# Native AI cancellation and session concurrency

Historical batch-stage evidence. The shared fetch adapter now streams events;
see [native AI streaming](native-ai-streaming.md) for current behavior and build.

Task: IMPLEMENTATION_PLAN Phase 4, task 5 (cancellation), under the active
cross-platform optimization goal. Date: 2026-10-30.

## Reproduced defect

`native_operation` held the shared session mutex across HTTP requests, including
the bounded 300-second AI event response. A second command, including AI cancel
or logout, could not acquire that mutex while the response remained open.

The regression test `ai_cancel_reaches_backend_while_event_response_is_open`
uses a real loopback HTTP listener with a synthetic event response. It sends
the stream headers and an initial event, then completes the stream only when
the cancellation endpoint is reached. Before the fix, cancellation timed out
after one second with `cancel waited for the still-open AI event response`.
After the fix, the cancellation endpoint is reached before stream completion.

## Change

Domain operations snapshot the access credential inside Rust under a short
lock, then release the lock before network I/O. Login/resume/logout retain
their existing serialized credential transitions. No token enters IPC output,
WebView storage, test logs or process arguments.

Before publishing a successful response, the operation checks that the same
session and origin are still active. A response arriving after logout or
session replacement returns `SIGN_IN_REQUIRED` for reads. A mutation returns
`MUTATION_OUTCOME_UNKNOWN` because the backend may already have committed it.
There is no automatic retry. Server ownership and policy checks still apply.

`late_operation_results_do_not_cross_logout_or_session_replacement` delays a
real loopback HTTP response until the in-memory session is cleared or replaced.
It covers both read scenarios and a committed note-create response after
logout, and confirms that no previous-session data is returned.

## Validation and limits

- `cargo test --locked native::tests:: -- --nocapture`: 13 passed.
- `cargo fmt --check`: passed.
- `cargo clippy --locked -- -D warnings`: passed.
- `pnpm --filter @aelys/desktop exec tauri build --ci --no-sign --bundles app`:
  passed, including the production web build; unsigned arm64 bundle 26.71 MiB.

The change does not alter the public API, frontend, DB schema, retry policy,
origin allowlist or Keychain format. Tests use synthetic session credentials
and local HTTP fixtures, not a live model provider or real Keychain session.
Events still reach the WebView as a buffered batch after the backend response
finishes; incremental IPC streaming and aborting a pending IPC call on view
unmount are not established by these tests. Authenticated packaged-app
cancellation, Keychain restart, sleep/wake and Android APK acceptance remain
open. No OPEN/PROPOSED decision is changed.
