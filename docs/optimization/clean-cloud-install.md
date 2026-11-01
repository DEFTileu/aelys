# Clean cloud and native installation — 2026-11-01

Task: Phase 8 / operator installation. Owner explicitly requested a fresh Railway
instance, deletion of Aelys app data on Mac/phone, and reinstalling both clients.
The owner confirmed that local notes/tasks/settings/keys should also be deleted.
Unrelated applications, RDS databases and Git working-copy edits are excluded.

Deployment config is ported from the previously approved temporary deployment:
Railway PORT, migration-before-exec startup, locked two-stage source installation,
normalized PostgreSQL driver URL, secret/agent-data exclusions and public RDS CA.
Existing main config/auth settings are preserved. Backend upload uses an explicit
Python/config/public-CA allowlist, never the working tree, env files, app databases,
CLI transcripts, embeddings or native artifacts. TLS verification remains enabled.

Target: existing Railway aelys/api production, project ff017b2c-0d89-4f77-92e0-1db4f7656fd7.
Its application database is aelys on the already configured RDS instance, role
aelys_app. The target was matched against saved deployment credentials and checked
with verified TLS 1.3. Only public schema in that database is reset; other RDS
resources are unchanged. DB role password, JWT signing and provider encryption
keys are regenerated. Owner is initialized privately before publishing; password
bootstrap remains disabled, existing native password login stays enabled.

Both native artifacts embed the public Railway HTTPS API default through the
build environment. No key is embedded. Mac is a local unsigned arm64 app; Android
is an arm64 release build signed with the existing local debug identity for direct
USB installation. This is not Developer ID/notarized or Play Store signing.

Reset progress and final validation are recorded below when installation completes.
