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

## Completed reset and installation

- Reset only the verified aelys/public RDS schema (previous revision 0024); applied
  all migrations through 0037_merge_telegram_knowledge. Application role password,
  signing and provider-encryption keys rotated; exactly one new owner initialized.
  The old Railway deployment was already REMOVED, so down correctly found none.
- Railway deployment f33ea73c-849e-43bb-a9b9-254ca862e79e is SUCCESS. HTTPS health
  returns 200, live /api/v1/openapi.json exactly matches main's checked-in contract,
  native status is initialized=true/password_setup=false, protected endpoints
  reject unauthenticated reads. A private authenticated login and Tasks/Notes/
  Projects reads return 200 with empty collections. No domain test records added.
  `alembic check` on the fresh RDS database reports no new upgrade operations.
- Stopped 14 old local Aelys backend/frontend/launcher processes, removed four
  workspace SQLite databases and old synthetic temporary databases. Removed the
  two Aelys PostgreSQL containers with their anonymous data volumes. Other project
  services/databases and code/index changes were preserved. Old local backend
  secret env removed; no owner local server was restarted.
- Removed the old installed Mac app, both known Aelys WebKit/cache identities,
  one native-session and one Touch ID Keychain item. Installed the fresh arm64
  app and opened it. Native AX shows Sign in to Aelys; Server Address is the
  Railway HTTPS API URL. No saved owner session was restored. Signing is local
  unsigned/ad-hoc, no Developer ID/notarization claim.
- Samsung SM-S721B was explicitly reconnected by the owner. Uninstalled the old
  com.aelys.mobile (including its app data/Keystore state), installed the new APK,
  and opened MainActivity. Foreground activity/process and inspected screenshot
  confirm the login screen. Force-stop/relaunch also passed. No actual native
  owner sign-in, sync or provider acceptance is claimed by this installation.
- Native artifacts contain the same HTTPS API default, no credentials. Android
  is arm64 release, cleartext=false, locally debug-signed for USB installation;
  apksigner v2/v3 and zipalign 16 KiB checks pass. APK is 67,595,456 bytes; hash
  236a2e831dad46b54c3ed565cb42408c82dda85e8cf685e5ba940572a95bb479.
  Installed Mac executable hash:
  80ed5a3867c006277541ec56ed8b7babf4e420bc2667f890f373073de92f396b.

Validation: 9 deployment-config tests, 5 Android preparation tests, Ruff, mypy
(95 app files), Bandit, frozen Linux/amd64 Docker build, both native release
builds, live API/auth/schema checks passed. Existing bundler/Gradle deprecation
advisories remain. An initial Android invocation could not find rustup; corrected
with process-local Rust PATH, then the release build passed. A smoke request first
used /openapi.json; corrected to the configured /api/v1/openapi.json and exact
runtime equality passed. Neither issue weakened any security policy.

Fresh owner login is stored only in the existing private operator login file
(mode 0600), outside Git. Temporary duplicate runtime-secret env was removed.
All integrations need reconnecting after the reset; their local secrets were not
uploaded. Existing unrelated 104 staged UI changes/prototype/deployment planning
notes are not silently committed by this task; only the reviewed deployment
configuration was ported into main. Git source is retained for review.
