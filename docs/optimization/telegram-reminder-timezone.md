# Telegram task reminder timezone

Selected scope: IMPLEMENTATION_PLAN Phase 3, task 1 (timezone and reminders).

Task deadlines are UTC instants with separate `due_timezone` display metadata.
Telegram previously ignored that metadata and displayed every task in the bot's
timezone, which defaults to UTC independently of the task editor.

Reminder text now prefers the task's valid IANA timezone and includes its full
name. Missing or invalid legacy metadata falls back to the bot's configured
timezone. Delivery instants, deadline offsets, quiet hours, policy checks and
durable at-most-once claims remain unchanged. Quiet hours and Telegram commands
continue to use the bot's explicitly configured timezone.

No migration, API change or new product decision is required. Existing delivered
messages are not resent or edited. No changes to calendar display-zone semantics.

Regression coverage exercises the reported 18:59 UTC / 23:59 Asia/Almaty case,
date rollover, explicit UTC, invalid/missing metadata, configured fallback,
not-before delivery, persisted instants and replay prevention.
