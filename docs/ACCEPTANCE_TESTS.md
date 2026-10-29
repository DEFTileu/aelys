# Aelys — End-to-End Acceptance Criteria v0.2

Aelys is delivered by working vertical slices; docs or generated views alone are not sufficient. These tests describe the expected outcomes, not already-implemented behavior.

## A. Core, Notes, Tasks, Calendar

- [ ] Owner can enroll Mac and Android, revoke Android and prove revoked credential fails.
- [ ] Create project and link task + note + calendar event; backlinks resolve correctly.
- [ ] Notes Markdown persists across relaunch, revisions restorable.
- [ ] Task with subtasks, priority, recurrence and due date appears correctly in project/calendar filters.
- [ ] Local offline changes survive kill/restart and appear on other device after reconnection.
- [ ] Cross-user/resource ID tampering is denied, even if server normally has one user.

## B. Sync

- [ ] Identical operation batch submitted repeatedly applies exactly once.
- [ ] Concurrent Markdown edits preserve both branches and surface conflict.
- [ ] Commit-order pagination and bootstrap never skip a write under concurrency.
- [ ] Tombstone and stale-device reset behavior documented and tested.
- [ ] Offline create/delete/update stress test completes with no lost or duplicated entities.
- [ ] Private Mac agent session contents are excluded from sync payload and cloud DB.

## C. Finance, Focus, Mail, Telegram

- [ ] Finance sums use exact decimal arithmetic; transfer debit/credit integrity checked.
- [ ] Duplicate offline transaction idempotently resolves as one posting.
- [ ] Focus timer remains accurate across pause/restart/sleep and avoids conflicting active timers.
- [ ] Imported `.eml` messages searchable and draftable; mark Gmail **not connected** unless OAuth has been integrated/tested.
- [ ] Telegram linking requires verification; unknown chat IDs rejected.
- [ ] Redelivered Telegram webhook event does not create duplicate task.

## D. AI

- [ ] BYOK provider key encrypted at rest, never returned in API read or logs.
- [ ] Automatic model selection respects model capabilities, budget and privacy setting; manual override works.
- [ ] AI can find project note, propose/write a task via typed tool with correct permission.
- [ ] Prompt injection inside email body cannot trigger unauthorized `send_mail` or shell action.
- [ ] Streaming run can cancel/timeout cleanly with stable final state.

## E. Mac Agent Reader

- [ ] Claude Code and Codex CLI adapter compatibility detectable on current installed versions.
- [ ] Selected project history indexed locally only; unselected directories not scanned.
- [ ] Remote mobile query yields citations to local session spans if Mac online.
- [ ] Mac offline gives explicit `MAC_OFFLINE`, metadata only.
- [ ] PostgreSQL, backend logs, outbound telemetry and sync store no agent transcripts/snippets or embeddings.
- [ ] Provider egress disabled => Mac excerpts do not reach external LLM API.

## F. Remote Agent Runner

- [ ] Authenticated owner requests Codex run for an approved project and sees queued/running/completed statuses.
- [ ] Replayed job cannot launch duplicate CLI processes.
- [ ] Within authorized sandbox, agent can modify file and run tests without per-command approvals.
- [ ] Attempt to access outside-project sensitive file is blocked and logged, including via symlink/subprocess.
- [ ] Network/git push/deploy unavailable absent separate policy grant.
- [ ] Cancel kills process tree; no orphan agent after helper restart.
- [ ] Revoking project grant prevents new runs.

## G. Automation

- [ ] `task.created` event triggers one configured rule once, even on duplicate delivery.
- [ ] Out-of-scope tool attempt denied regardless of model content.
- [ ] Rule has dry run/audit/rate limit, disabling rule prevents further execution.

## H. Open Source / deployment

- [ ] New developer can start local dependencies using documented commands and sample config with no private secrets.
- [ ] CI runs unit/integration/type/lint + relevant security checks.
- [ ] Apache-2.0 (or alternative final license) explicitly confirmed prior to public release.
- [ ] Installer/uninstaller handles Mac helper opt-in and removal.
- [ ] Android APK produced with working offline storage/notification tests before selecting final wrapper.

## Quality gate per milestone

No milestone complete without: working code, automated tests where feasible, migration/backward compatibility check, reproducible dev setup, updated documentation, and a short test report. Experimental/incomplete features must be labeled rather than claimed shipped.
