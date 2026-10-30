# Native AI event streaming

2026-10-30. Scope: implementation-plan Phase 4 task 5, cancellation, including AI run event delivery
through the existing macOS native boundary. No new product module or decision.

## Before and after

Before, Rust collected the complete SSE response before returning an event array
to JavaScript. The WebView reconstructed a stream only after backend EOF, so the
first token could not appear while generation was still running. Frontend abort
did not close the native event subscription.

The fetch adapter now uses an ordered Tauri Channel. Rust decodes and publishes
complete frames as network chunks arrive. The decoder handles UTF-8 and CRLF
split across chunks, scans bytes once and shifts the incomplete tail once per
chunk. Allowed event names and recursive credential-field redaction are retained.
The old batch operation remains compatible but is not used by the fetch adapter.

The subscription is registered before an `opened` acknowledgement. An early JS
abort waits for that acknowledgement before issuing a close, avoiding a
close-before-registration race. ReadableStream cancellation/AbortSignal closes
the exact request, including the wait for backend headers. Only the ordered
Channel end/error terminates the reader; invoke completion can arrive earlier.
Stopping the AI run itself remains an explicit backend cancellation operation.

Session changes and subscription registration share one lock order. Login and
resume cancel old subscriptions; logout cancels those for its origin. Each event
checks the session and is published synchronously under the state lock. Network
waits do not hold that lock. Existing main-window/origin/TLS/CSP policies remain.
Bounds: four concurrent native subscriptions, 8 MiB per response, 300 seconds.
No general URL/header proxy, retry or secret-bearing JS API was added.

## Verification

- `cargo fmt`: passed.
- `cargo clippy --locked --all-targets -- -D warnings`: passed. A previous HTTP
  test's unchecked read amount was corrected during this run.
- `cargo test --locked`: 21 passed, zero failures. New HTTP tests keep the server
  connection open until the first event callback and cancellation occur; the
  callback and close must each finish within one second. Another test never
  sends headers and verifies cancellation closes the connection. These are
  functional timing bounds on synthetic loopback traffic, not provider latency
  benchmarks. Decoder tests split Cyrillic/emoji frames byte by byte; HTTP tests
  reject wrong MIME and truncated frames, and the decoder rejects over 8 MiB.
- `pnpm --filter @aelys/web test`: 165 passed, zero failures. Six new Channel tests
  verify first-chunk delivery before invoke completion, independent ordered end,
  abort before/after registration, pre-abort, reader cancellation and error.
- `pnpm --filter @aelys/web typecheck`: passed.
- `pnpm --filter @aelys/desktop exec tauri build --ci --no-sign --bundles app --config '{"bundle":{"active":true,"targets":["app"]}}'`:
  passed, including the production web build. Unsigned arm64 `.app`: 26.86 MiB.
  Release and packaged executable SHA-256 match:
  `0eeb6b4ff359dca72dac39583a0e1762b0e48f44a94cde514b8dd08ff80d4325`.

The tests use synthetic HTTP responses and injected IPC callbacks. They establish
the Rust HTTP decoder and JavaScript adapter behavior separately; they are not a
credentialed packaged-WebView/provider integration run. Real Keychain restart,
sleep/wake and Android SDK/device gates remain open. Current artifact identity is
recorded in `docs/MACOS_OPTIMIZATION_STATUS.md` after the release build.
