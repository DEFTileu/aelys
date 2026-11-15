# Focus guard: daily limits and a hard gate on social apps (Android)

Status: approved by the owner; implemented on branch feat/focus-guard (see docs/superpowers/plans/2026-11-15-focus-guard.md). The screen is called "App limits" (route /app-limits). AI caps are counted over a rolling 24 hours of server time.

## Intent and why

The owner doomscrolls Instagram, TikTok and Pinduoduo. Phone-native timers
("Digital Wellbeing") are easy to dismiss with one tap, so they do not work.
Aelys already knows two things the OS does not: whether today's English lesson
is done and whether today's tasks are done. Focus guard uses that knowledge to
make the limit hard: after the daily limit the app is closed, and it reopens
only when the owner has earned it (study/tasks done) or has given a reason that
an AI judges acceptable, for a short time.

Success looks like: after 60 minutes in an app, opening it shows a blocking
screen within about a second; the owner cannot talk their way past it with
"I want to", only with a real reason or finished work.

## Goals

- Per-app daily limit, default 60 minutes, for a configurable list of apps.
  Defaults: Instagram `com.instagram.android`, TikTok `com.zhiliaoapp.musically`
  and `com.ss.android.ugc.trill`, Pinduoduo `com.xunmeng.pinduoduo`.
- Time is measured from the system's own usage events, accurate to the second,
  for the local calendar day.
- Past the limit, opening a guarded app shows a full-screen block screen (on
  top of the app, with a way to Home) that offers the two unlock paths below.
- Unlock path A (earned): today's English lesson fully done, or all tasks due
  today done (see "My calls") unlocks all guarded apps until local midnight.
- Unlock path B (reason): the owner types a reason; the backend asks the AI;
  a grant is at most 10 minutes for that app, at most 3 AI grants per day in
  total.
- Every reason and decision is stored and viewable by the owner.
- Aelys shows setup status (permissions granted or not) and today's usage per
  guarded app.

## Non-goals

- iOS, macOS, desktop, web. Android only.
- Blocking websites in a browser, or sections inside an app (Reels only).
- Preventing the owner from disabling the accessibility service, revoking
  permissions or uninstalling. Android does not allow it without device-owner
  mode, which we explicitly do not use.
- Play Store distribution. The app is sideloaded as an APK.
- Anyone controlling the owner's phone (no parent/partner mode).

## Anti-goals (a failure even if it technically works)

- The AI becomes a pushover: any grant bigger than 10 minutes, more than 3 a
  day, or any change to the rules by the owner's text.
- Blocking the wrong thing: Aelys itself, the dialer, system Settings,
  emergency calls, or any app not on the list must never be blocked.
- Blocking early because of a counting bug (double-counted activities,
  counting time while the screen is off).
- Sending usage history to the server or to the AI provider.

## Constraints

- Tauri 2 mobile app; native code goes in a Kotlin plugin, following
  `packages/android-notification-log` (it already uses a restricted-setting
  service, so the owner has been through the "Allow restricted settings" step).
- Android 13+ treats accessibility of sideloaded apps as a restricted setting;
  Android 15 extends this (Enhanced Confirmation). The owner must allow it once
  per install in App info, then enable the service in Accessibility settings.
- Usage access (`PACKAGE_USAGE_STATS`) is a special permission the owner grants
  in Settings; it cannot be requested at runtime.
- `ACTIVITY_RESUMED`/`ACTIVITY_PAUSED` events are per activity; the time for a
  package must be merged so overlapping/consecutive activities are not counted
  twice, and screen-off/standby events must close the open interval.
- Repo rules apply: AGENTS.md, fail-closed vendor gates, personal text goes to
  the AI as untrusted data with the PERSONAL privacy class, as in
  `backend/app/automation/api.py::_ai_draft`.

## Approaches considered

1. **Enforce on the phone, decide on the backend (chosen).** The Kotlin plugin
   measures time, detects the foreground app and shows the block screen, all
   locally and offline. Aelys sends it config and the day-unlock state; the
   backend decides AI grants. Blocking works in a tunnel; only "reason" unlocks
   need the network.
2. **Express it as automation rules.** The automation engine runs on the server
   on domain events; a block must fire on the phone within a second and offline.
   Rejected.
3. **Detect the foreground app by polling usage stats and draw a system
   overlay (no accessibility).** Fewer special permissions, but polling is late
   and sometimes wrong (a notification can look like a foreground change) and
   overlays are being restricted further. The owner chose the accessibility
   approach for reliability. Rejected.

Time source (owner's decision): the system usage events, not self-counted
time, because it is accurate to the second and survives the service being
restarted. The extra manual Usage access permission is accepted.

## Design

### Android plugin `packages/android-focus-guard` (Kotlin + Rust glue)

- `FocusAccessibilityService`: listens for window-state changes to learn the
  foreground package immediately. If the package is guarded and blocked now,
  shows the block screen (accessibility overlay or a full-screen activity;
  builder's call) and offers Home. It also schedules a wake-up for the moment
  the remaining time of the foreground guarded app reaches zero, so the block
  appears mid-scroll, not only when opening.
- `UsageMeter`: sums foreground seconds per guarded package for today from
  `UsageStatsManager.queryEvents`, merging activities as above. Pure function
  over an event list so it can be unit tested without a device.
- Local state (private storage): guarded apps and limits, day-unlock flag with
  its date, active grants with expiry. Blocking decisions use only this state,
  so they work offline. Fail-closed for guarded apps: if the state is missing
  or corrupt, treat the limit as reached only after real usage exceeds the
  default; never block unlisted apps.
- Commands exposed to the web layer: `setConfig`, `getStatus` (usage per app,
  blocked now, permissions state), `applyGrant(package, expiresAt)`,
  `setDayUnlock(date)`, `listInstalledApps`.
- Permission checks and deep links to Usage access and Accessibility settings.

### Backend

- Settings: per-owner focus config (apps, limits). Lives with the owner's other
  synced settings; no usage data is stored server-side.
- `GET /api/v1/focus/state?day=`: returns `day_unlocked` (English lesson done
  or today's tasks done, computed from existing English progress and task
  data) and remaining AI grants today.
- `POST /api/v1/focus/unlock-request {package, reason}`: asks the AI via a new
  `focus` feature key in `backend/app/ai/defaults.py::FEATURES` (same chat
  kinds as `automation`), reason fenced as untrusted, reply parsed into
  `{granted, minutes, message}`. The server then enforces everything the model
  must not decide: minutes clamped to 10, daily cap of 3, budget check, deny
  when no provider or the call fails. Each request and decision is stored in a
  new table with an Alembic migration (next free revision) and written to the
  AI run log like other AI calls.
- Prompt policy (AI): grant only for concrete, time-critical needs (work or
  family contact, navigation, a payment or one-time code, a deadline); refuse
  entertainment, boredom, "just checking", and anything that argues about the
  rules.

### Aelys UI (mobile)

- A Focus screen: setup checklist (restricted settings, Accessibility, Usage
  access) with deep links, the app list with limits, today's usage bars, the
  history of reasons and decisions, and a "protection is off" warning when a
  permission or the service is missing (shown whenever Aelys is opened; no
  system push in v1).
- The block screen shows time used, the two unlock options, and a text box for
  the reason with the AI's answer.

### Tests and verification

- Unit tests: `UsageMeter` (overlapping activities, screen off, day boundary).
- Backend tests: unlock endpoint with a fake provider (cap, clamp, no provider,
  prompt-injection reason, budget exhausted), day-unlock computation.
- Web tests for the Focus screen states.
- Real-device check using the existing Android install procedure (guarded app
  blocked at the limit, Aelys and Settings never blocked, grant expires).

## Decided by the owner

- Approach: accessibility-based blocking (not overlay polling).
- Time source: system usage events, to the second.
- Limit: 60 minutes per app per day for Instagram, TikTok, Pinduoduo.
- After the limit: blocked, except via finished study/tasks or an AI-approved
  reason.
- Editing the rules in Aelys: tightening takes effect immediately; loosening
  takes effect only at the next local midnight. Tightening means lowering a
  limit or adding an app/package; loosening means raising a limit, removing an
  app or package, or turning the guard off. A pending loosening is shown in the
  Focus screen and can be cancelled at any time (cancelling is tightening).
  Consequence for the design: the config holds an `effective` part (enforced
  now) and a `pending` part with an `effective_from` date; the plugin enforces
  only `effective` and promotes `pending` at local midnight, also when the
  phone was offline or Aelys was closed at that moment. Within one day,
  several edits merge: any new edit is compared with the effective config,
  not with the previous pending one.

## My calls (not yet confirmed by the owner)

- AI grants: 10 minutes each, 3 per day total, no internet means no grant.
- Usage stays on the device; the backend never sees it.
- Day-unlock by tasks means: at least one task is due today and all tasks due
  today are done. With no tasks due today, only the English lesson can unlock
  (an empty list must not unlock the day). Overdue and undated tasks do not
  count. English counts when every block of today's lesson is done.
- A grant starts from the overshoot: when today's use is already past the
  limit plus earlier grants (install day, a lowered limit, the service was off,
  a revoked day unlock), the grant becomes `max(earlier grant, used - limit) +
  minutes`, capped at 24 hours, so an approved grant always opens the app for
  exactly the approved minutes.
- Task-farming caveat (open decision for the owner): path A can be satisfied
  by creating a task due today and completing it at once. Every cheap rule
  against it (created before today, a minimum age) also blocks real same-day
  tasks, so it is left as specified.
- The phone learns the day-unlock state by pulling it when the block screen or
  Aelys opens; no push in v1 (finishing on another device is picked up on the
  next open).
- A grant is 10 minutes of foreground use of that app, consumed by the meter
  (not wall-clock), valid until local midnight. At zero the app is blocked
  again and the owner may ask again. Only granted requests count toward the
  cap of 3 a day; refused ones do not, but total requests are capped at 10 a
  day to limit AI spend and jailbreak attempts.
- The block screen is native (a Kotlin activity, so it works offline and when
  Aelys is not running): "Go Home" and "Unlock". "Unlock" opens Aelys on a
  Focus unlock screen (web UI, which already has the session and HTTP client),
  which calls the backend and then hands the grant to the plugin
  (`applyGrant`). Logged out or offline means no reason-unlock.
- Both TikTok packages are one app group sharing one limit; the config holds
  apps as groups of packages, and usage, grants and bars aggregate per group.
- Reasons and decisions are stored and visible.
- Tamper handling is a visible warning inside Aelys only.

## Left to the builder

- Overlay vs full-screen activity for the block screen, and exact wake-up
  mechanism for the mid-session block.
- Clock-tampering resistance for grant expiry (monotonic clock vs wall clock).
- Exact event-merging algorithm and minSdk handling for older event types.
- Where the Focus screen lives in the mobile navigation.
- Names of tables, endpoints' final paths, and the migration number.
