# Companion device channel contract (v1)

Status: DECIDED (owner, 2026-11-13). Governed by ADR-029 in `docs/DECISIONS.md`.
Firmware (plan 3) is built against this document. Any change to a field,
name, code or close code requires a new version of this file.
See "Plan 3 additions (v1.1)" at the end for the additive fields, messages,
commands and routes added for the app pages and firmware.

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
- WebSocket pings: the server (uvicorn/websockets) pings every 20 s. The board
  must answer pings (pongs), or the connection is closed with `1011`.
- Maximum server to board frame: 4096 bytes (UTF-8). The server keeps a
  `snapshot` under it by cutting every title to 80 characters (the last one
  becomes `…` when cut). Worst case (five 80-character Cyrillic notices with
  long kinds, plus task, event and focus) is about 2.9 KB.
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
| `4401` | Auth: token or session invalid or expired | Re-login by device signature, then reconnect. Expected roughly every 15 min (the access-token lifetime), so it is normal, not an error. |
| `4403` | Device revoked, missing, or not a companion | Call `/auth/device/challenge`. Wipe pairing ONLY if it answers `401 UNAUTHORIZED`. A `429`, a `5xx` or a network error never wipes pairing: back off and retry. |
| `1011` | Server error or failed send (for example the first snapshot could not be built or sent) | Back off and reconnect with the same token; a fresh snapshot follows. |
| `4000` | Replaced by a newer connection of the same device | This socket is closed and must not reconnect; the newer connection is live. |
| any other code (for example `1000`, `1009`, `1012` during a server deploy) or a network drop | The connection is gone | Back off 1 to 60 s with jitter and reconnect. |

Lost mode survives a pairing wipe: after a wipe the board keeps showing the
lost screen until the owner turns lost mode off through the app. The board
never clears lost mode locally.

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
That `error` carries no `id`, so the board cannot match it to the action: if no
`action_result` arrives within 10 s, the board resends the action with a NEW
`id`. While the board is in lost mode every action, whatever its `kind`, gets
`action_result` with `ok: false` and `error_code: "POLICY_DENIED"`.
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

Lost mode: while the owner's lost mode is on for this board, every snapshot
sent to it (the first one after `ready`, pushes, and `GET
/api/v1/companion/snapshot`) has `next_task`, `next_event` and `focus` null,
`notices` empty and `overdue_count` 0. Only `generated_at` and `unread_count`
keep their values. When lost mode is turned off a normal snapshot is pushed
right away.

Time: the server does not push when a task or event time passes (v1). The board
hides `next_task` and `next_event` locally once their time has passed.

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

- Every `title` is at most 80 characters (cut with a trailing `…`).
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
- `POLICY_DENIED`: the Policy Engine denied the action, or the board is in lost mode.
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

## Plan 3 additions (v1.1)

Everything here is additive: a v1 board or app keeps working unchanged. Unknown
fields are ignored by the server on board frames, and every new request field
has a default.

### Board to server

`hello` gains optional `contacts`. Both parts default to `""`; a `hello`
without `contacts` keeps what is stored. The server stores it for the owner's
app and never logs it.
```json
{"type": "hello", "fw_version": "0.5.0", "board": "esp32-s3-n16r8", "features": [], "contacts": {"phone": "+7 700 123 45 67", "telegram": "@owner"}}
```
`phone` is at most 23 characters, `telegram` at most 32.

`metrics` gains optional `battery_pct` (int 0 to 100), `charging` (bool) and
`heap_at_connect_min` (int bytes). Absent fields are not stored.
```json
{"type": "metrics", "heap_min_internal": 84312, "largest_block": 61440, "psram_free": 7864320, "wifi_reconnects": 2, "uptime_s": 3600, "battery_pct": 81, "charging": true, "heap_at_connect_min": 90112}
```

New message `wifi_state`: the board's saved networks (at most 5, each SSID at
most 32 characters) and the one it is on now (`null` if none). Send it after
every change to the saved list and after joining a network. Invalid content
gets `error` `VALIDATION_ERROR`.
```json
{"type": "wifi_state", "saved": ["Home", "Work"], "current": "Home"}
```

`command_ack` is now recorded for **every** command id the server sent in the
last 24 hours, not only queued ones: `wifi_add`, `wifi_remove`, `wifi_order`,
`restart` and `unpair` are never queued, but an ack that arrives after a
reconnect still reaches the owner's command log. `wifi_scan_result` counts as
the ack of its `wifi_scan` (`ok: true`). An ack for an unknown or older id is
ignored.

### Server to board

`snapshot` gains three integers:

| Field | Type | Notes |
|---|---|---|
| `today_done` | int | Tasks due today in the owner's day that are completed. |
| `today_total` | int | Completed plus still open tasks due today. Cancelled and deleted tasks count in neither. |
| `other_unread_count` | int | Unread notifications of kinds outside `task.`, `calendar.`, `focus.`. `unread_count` is still the total. |

"Today" is cut like the Telegram `/today` agenda: the owner's local day in the
Telegram integration's time zone, UTC if there is none. Like every time-based
value it is not pushed at midnight; it refreshes on the next snapshot. In lost
mode `today_done` and `today_total` are 0; `other_unread_count` keeps its value,
like `unread_count`.
```json
{"today_done": 2, "today_total": 5, "other_unread_count": 3}
```

`command` args that grow (all new fields have defaults, so v1 requests work):

| `name` | New `args` |
|---|---|
| `lost_mode` | `show_email: bool = false`, `email: str (max 48) \| null`, `qr: "telegram" \| "phone" \| "none" = "telegram"`, `since: datetime` (set by the server when lost mode goes on and kept while it stays on; absent when `on` is false) |
| `ice_update` | `owner_name: str (max 32) = ""`, `contacts[].relation: str (max 16) = ""`, `show_contacts: bool = true`, `show_med: bool = true`. The full args are `{owner_name, contacts: [{name (max 32), relation, phone (max 23)}] (max 2), med_note (max 96), show_name, show_contacts, show_med, rev}`. |

`rev`, at-least-once delivery and BUSY handling are unchanged for `lost_mode`
and `ice_update`. New commands (`name`, `args`):

| `name` | `args` | Delivery |
|---|---|---|
| `settings` | `{"brightness": int 5..100, "rev": int}` | Queued like `lost_mode`, one pending per name, `rev` as above. |
| `wifi_remove` | `{"ssid": str (1..32)}` | Never queued. |
| `wifi_order` | `{"ssids": [str (1..32)] (max 5)}` | Never queued. |
| `restart` | `{}` | Never queued. |
| `unpair` | `{}` | Never queued. The board wipes its pairing and shows the pairing screen. The server revokes the board right after sending it, so the socket closes with `4403`. |

All are answered with `command_ack` (`BAD_ARGS` for invalid args). The board
sends a fresh `wifi_state` after `wifi_remove` and `wifi_order`.
```json
{"type": "command", "id": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "name": "settings", "args": {"brightness": 60, "rev": 2}}
```
```json
{"type": "command", "id": "0c1d2e3f-4a5b-4c6d-8e7f-8a9b0c1d2e3f", "name": "unpair", "args": {}}
```

### HTTP routes (owner devices only)

Same guard as the other `/api/v1/companion/devices/{id}` routes: a companion
principal gets `403 DEVICE_SCOPE_DENIED`; another owner's board is `404`.
Command routes answer `{"id": "<command id>", "delivered": bool}` as in v1.

| Route | Body | Result |
|---|---|---|
| `GET /api/v1/companion/devices` | none | The owner's live (not revoked) companions: `[{"device_id", "display_name", "online", "last_seen_at", "wifi_current", "battery_pct"}]` |
| `PUT .../devices/{id}/settings` | `{"brightness": 5..100}` | Queued `settings`; `delivered` is false while the board is offline. |
| `POST .../devices/{id}/wifi/remove` | `{"ssid": str}` | `wifi_remove`; `409 DEVICE_OFFLINE` if offline. |
| `PUT .../devices/{id}/wifi/order` | `{"ssids": [str]}` (max 5) | `wifi_order`; `409 DEVICE_OFFLINE` if offline. |
| `POST .../devices/{id}/restart` | none | `restart`; `409 DEVICE_OFFLINE` if offline. |
| `POST .../devices/{id}/unpair` | `{"reauth": {"challenge_id", "signature"}}` | Needs a fresh signature by the calling device over `aelys-companion-unpair-v1\n{board id}\n{nonce}` (a lost-mode-off signature is refused; wrong or missing is `403 REAUTH_REQUIRED`). If the board is online it gets `unpair` first; then it is revoked the same way as `POST /api/v1/devices/{id}/revoke`. An offline board is just revoked (`delivered: false`, no 409). |

`PUT .../lost-mode` accepts `show_email`, `email`, `qr`; `PUT .../ice` accepts
`owner_name`, `contacts[].relation`, `show_contacts`, `show_med` (all optional).
`POST .../wifi`, `.../wifi-scan` and `.../find` are unchanged apart from being
recorded in the command log.

`GET /api/v1/companion/devices/{id}` gains:

| Field | Type |
|---|---|
| `contacts` | `{"phone": str, "telegram": str} \| null` (from the last `hello` that sent them) |
| `wifi` | `{"saved": [str], "current": str \| null} \| null` (last `wifi_state`) |
| `battery` | `{"pct": int, "charging": bool} \| null` (from `metrics`) |
| `settings` | `{"brightness": int} \| null` (the last value the owner set) |
| `command_log` | The last 10 commands sent: `[{"id", "name", "sent_at", "ok": bool \| null, "error_code": str \| null}]`, oldest first. `ok` is `null` until acked. |
| `lost_mode.since` | datetime, present while lost mode is on |
| `last_metrics` | also carries `battery_pct`, `charging`, `heap_at_connect_min` when sent |
```json
{"device_id": "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", "wifi": {"saved": ["Home"], "current": "Home"}, "battery": {"pct": 81, "charging": true}, "settings": {"brightness": 60}, "command_log": [{"id": "c1d2e3f4-0a1b-4c2d-8e3f-4a5b6c7d8e9f", "name": "wifi_add", "sent_at": "2026-11-13T09:30:00+00:00", "ok": false, "error_code": "WIFI_FAILED"}]}
```
