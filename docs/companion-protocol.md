# Companion device channel contract (v1)

Status: DECIDED (owner, 2026-11-13). Governed by ADR-029 in `docs/DECISIONS.md`.
Firmware (plan 3) is built against this document. Any change to a field,
name, code or close code requires a new version of this file.

## Transport and framing

- WebSocket endpoint: `/api/v1/devices/channel`.
- Auth: `Authorization: Bearer <access token>` header only. Token/session
  problems close the socket with `4401`; a missing or revoked device, or a
  device whose platform is not `companion`, closes it with `4403`.
- Text frames only. Each frame is one UTF-8 JSON object with a string field
  `type` that selects the message.
- Maximum frame size: 4 KB (4096 bytes). Larger frames, or invalid JSON, get
  `error` with `code: "VALIDATION_ERROR"`.
- Unknown `type` gets `error` with `code: "UNKNOWN_MESSAGE"`.
- All datetimes are UTC ISO-8601 strings, e.g. `2026-11-13T09:30:00Z`. The
  board converts to its own time zone.
- Heartbeat: the board sends `heartbeat` every 30 s; the server answers
  `heartbeat_ack`. The server re-checks the device and session every 60 s and
  closes the socket if they are no longer valid.
- Ids: `id` fields are opaque strings. The receiver echoes them back unchanged
  and compares them only for equality. Examples use UUIDs. The server requires
  an action `id` to be a UUID v4 chosen by the board.

## Connection lifecycle

1. Board opens the socket with a valid token.
2. Server sends `ready`, then `snapshot`.
3. Board sends `hello`. The server then sends any pending `command` messages.
4. Board sends `heartbeat`, `metrics`, `action`, `command_ack`, and
   `wifi_scan_result` as needed. Every server change (new task, focus change,
   notification) is sent as a full `snapshot`.

## Close codes

| Code | Meaning | Board behaviour |
|---|---|---|
| `4401` | Auth: token or session invalid or expired | Re-login by device signature, then reconnect. |
| `4403` | Device revoked, missing, or not a companion | Re-check with `/auth/device/challenge`. Wipe pairing only if that response says the device is unknown or revoked. |
| `4000` | Replaced by a newer connection of the same device | This socket is closed and must not reconnect; the newer connection is live. |

## Board to server

### `hello`
```json
{"type": "hello", "fw_version": "0.4.1", "board": "esp32-s3-n16r8", "features": ["display", "buzzer", "wifi_scan"]}
```

### `heartbeat`
```json
{"type": "heartbeat"}
```

### `metrics`
`heap_min_internal` and `largest_block` are bytes; `psram_free` is bytes;
`wifi_reconnects` is a count; `uptime_s` is seconds.
```json
{"type": "metrics", "heap_min_internal": 84312, "largest_block": 61440, "psram_free": 7864320, "wifi_reconnects": 2, "uptime_s": 3600}
```

### `action`
`kind` is one of the action kinds listed below. Repeating an `id` returns the
stored `action_result` without a second effect. A non-UUID `id` or a non-object
`payload` gets `error` with `code: "VALIDATION_ERROR"`, not `action_result`.
```json
{"type": "action", "id": "5f0c2a7e-3b1d-4c8e-9a6f-2d7b1e4c9a10", "kind": "focus.start", "payload": {"mode": "pomodoro"}}
```

### `command_ack`
Acknowledges a `command` (every name except `wifi_scan`); the server drops the
matching pending command (except after a `BUSY` failure, below). `error_code` is present only when `ok` is false:

| `error_code` | Meaning |
|---|---|
| `BAD_ARGS` | `args` are invalid. |
| `UNSUPPORTED` | `name` is unknown to this firmware. |
| `BUSY` | The command cannot run now. |
| `DECRYPT_FAILED` | The `wifi_add` blob did not decrypt. |
| `WIFI_FAILED` | The blob decrypted but the board could not join the network. |

```json
{"type": "command_ack", "id": "c1d2e3f4-0a1b-4c2d-8e3f-4a5b6c7d8e9f", "ok": true}
```
```json
{"type": "command_ack", "id": "e5f6a7b8-2c3d-4e4f-8a9b-0c1d2e3f4a5b", "ok": false, "error_code": "WIFI_FAILED"}
```

### `wifi_scan_result`
`id` is the id of the `wifi_scan` command it answers, and this message is that
command's ack. No separate `command_ack` is sent for `wifi_scan`.
`rssi` is dBm (negative integer); `secure` is a boolean.
```json
{"type": "wifi_scan_result", "id": "d4e5f6a7-1b2c-4d3e-9f8a-7b6c5d4e3f2a", "networks": [{"ssid": "HomeNet", "rssi": -48, "secure": true}, {"ssid": "Guest", "rssi": -71, "secure": false}]}
```

## Server to board

### `ready`
```json
{"type": "ready", "device_id": "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"}
```

### `heartbeat_ack`
```json
{"type": "heartbeat_ack"}
```

### `snapshot`
Full replacement of the board's state. No partial patches in v1.
```json
{"type": "snapshot", "snapshot": {"generated_at": "2026-11-13T09:30:00Z", "next_task": {"id": "t-101", "title": "Submit report", "due_at": "2026-11-13T12:00:00Z"}, "overdue_count": 1, "next_event": {"id": "e-22", "title": "Standup", "starts_at": "2026-11-13T10:00:00Z", "ends_at": "2026-11-13T10:15:00Z", "all_day": false}, "unread_count": 5, "notices": [{"id": "n-9", "kind": "task.reminder", "title": "Submit report soon", "created_at": "2026-11-13T09:00:00Z"}], "focus": {"id": "f-3", "status": "active", "mode": "pomodoro", "started_at": "2026-11-13T09:10:00Z", "elapsed_seconds": 1200}}}
```

Snapshot schema (`CompanionSnapshot`):

| Field | Type | Notes |
|---|---|---|
| `generated_at` | datetime | UTC |
| `next_task` | `SnapTask \| null` | Earliest open task due after now. Overdue tasks are not returned here. |
| `overdue_count` | int | |
| `next_event` | `SnapEvent \| null` | Includes an event that started earlier and is still ongoing; recurring events use their next occurrence; window 7 days. |
| `unread_count` | int | Counts unread notifications of every kind. |
| `notices` | `SnapNotice[]` | Max 5, newest first. Only kinds `task.*`, `calendar.*`, `focus.*`. |
| `focus` | `SnapFocus \| null` | Only when status is `active` or `paused`. |

- `SnapTask`: `id` str, `title` str, `due_at` datetime.
- `SnapEvent`: `id` str, `title` str, `starts_at` datetime, `ends_at` datetime or null, `all_day` bool.
- `SnapNotice`: `id` str, `kind` str, `title` str, `created_at` datetime. No body and no data.
- `SnapFocus`: `id` str, `status` `"active"` or `"paused"`, `mode` str, `started_at` datetime, `elapsed_seconds` int.

### `action_result`
`error_code` is present only when `ok` is false. Action failures are reported
here, not as an `error` message.
```json
{"type": "action_result", "id": "5f0c2a7e-3b1d-4c8e-9a6f-2d7b1e4c9a10", "ok": true}
```
```json
{"type": "action_result", "id": "5f0c2a7e-3b1d-4c8e-9a6f-2d7b1e4c9a10", "ok": false, "error_code": "NO_ACTIVE_FOCUS"}
```

### `command`
`name` is one of `lost_mode`, `play_sound`, `ice_update`, `wifi_add`,
`wifi_scan`. The board answers with `command_ack`, except `wifi_scan`, which is
answered by `wifi_scan_result`.

| `name` | `args` |
|---|---|
| `lost_mode` | `{"on": bool, "message": str (max 64), "show_phone": bool, "show_telegram": bool, "rev": int}` |
| `play_sound` | `{}` |
| `ice_update` | `{"contacts": [{"name": str (max 32), "phone": str (max 23)}] (max 2), "med_note": str (max 96), "show_name": bool, "rev": int}` |
| `wifi_add` | `{"blob": str}`: base64url, at most 512 bytes decoded. Opaque to the server. The app encrypts it to the board's public key (ECIES); the board decrypts it. Never logged or stored by the server. |
| `wifi_scan` | `{}` |

```json
{"type": "command", "id": "c1d2e3f4-0a1b-4c2d-8e3f-4a5b6c7d8e9f", "name": "lost_mode", "args": {"on": true, "message": "If found, call the owner", "show_phone": true, "show_telegram": false, "rev": 3}}
```
```json
{"type": "command", "id": "e5f6a7b8-2c3d-4e4f-8a9b-0c1d2e3f4a5b", "name": "wifi_add", "args": {"blob": "q2V5ZGF0YS1lbmNyeXB0ZWQ"}}
```

Pending commands are kept until acknowledged.

Ordering and delivery of `lost_mode` and `ice_update`:
- `rev` is an integer, monotonic per device and command name; every send of a
  given state carries its `rev`.
- Delivery is at-least-once. Both commands are queued even while the board is
  online and kept until acked, so the same `id` can arrive again after a
  reconnect, and a newer command can arrive before an older one.
- The board applies a command only if its `rev` is greater than the last `rev`
  it applied for that name, and always acks it (a stale one too), so the server
  can drop it.
- An ack with `ok: false` and `error_code` `BUSY` keeps the command pending; it
  is sent again after the next `hello`. Any other ack removes it.

Queueing while the board is offline:
- Only `lost_mode` and `ice_update` are queued, delivered after `hello`. Pending
  commands are deduplicated by name; the newest replaces the older.
- `play_sound`, `wifi_add` and `wifi_scan` are never queued. The server answers
  the app with `409 DEVICE_OFFLINE`.

### `error`
```json
{"type": "error", "code": "VALIDATION_ERROR", "message": "frame exceeds 4 KB"}
```

## Action kinds

| `kind` | `payload` | Scope | Result |
|---|---|---|---|
| `notification.read` | `{"notification_id": str}` | `companion.notifications` | Marks the notification read. |
| `focus.start` | `{"mode": "pomodoro" \| "stopwatch"}` (`mode` optional, default `"pomodoro"`) | `companion.focus` | Starts a focus session; server time is `started_at`. |
| `focus.pause` | `{}` | `companion.focus` | Pauses the active session. |
| `focus.resume` | `{}` | `companion.focus` | Resumes the paused session. |
| `focus.stop` | `{}` | `companion.focus` | Stops the active session. |
| `task.complete` | `{"task_id": str}` | `companion.tasks` | Completes the task. Idempotent. |

Result error codes (`action_result.error_code`):

- `ACTION_UNKNOWN`: `kind` is not in the table above.
- `NO_ACTIVE_FOCUS`: a `focus.pause`, `focus.resume` or `focus.stop` found no active session.
- `NOT_FOUND`: the notification or task does not exist or belongs to another owner.
- `VALIDATION_ERROR`: the payload is invalid (for example a `focus.start` `mode` other than `pomodoro` or `stopwatch`).
- `POLICY_DENIED`: the Policy Engine denied the action.
- `ACTION_FAILED`: the action failed for a reason the board cannot act on.

Errors from the shared services pass through as-is only for `TIMER_ACTIVE`
(`focus.start` while a session is running), `VERSION_CONFLICT`,
`IDEMPOTENCY_CONFLICT` and `INVALID_STATE`. Any other server failure is
reported as `ACTION_FAILED`; the real cause is logged on the server only.

## Notes

- Notification titles are sent only for kinds with prefix `task.`, `calendar.`
  or `focus.`. Other kinds are counted in `unread_count` but never sent with
  their title or body.
- The board never receives a refresh token, a notification body, or `data_json`.
- `reauth` is HTTP-only and never forwarded to the board.
- Firmware OTA is not part of v1 (plan 4).
