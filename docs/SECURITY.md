# Aelys — Security & Privacy Model v0.2

## 1. Security goals

- Personal data and API keys remain private on an open-source, self-hostable platform.
- Mac-only CLI histories stay on Mac; cloud index reveals minimal non-content metadata.
- Remote agents run autonomously **only within explicitly allowed project sandboxes**.
- Automation and LLM requests cannot expand their own scopes.
- Data survive common failures without unauthorized disclosure or irreversible loss.

## 2. Trust boundaries

1. Public/untrusted clients ↔ authenticated backend.
2. Backend ↔ PostgreSQL/secrets manager.
3. Backend ↔ external LLM provider (data leaves Aelys trust boundary).
4. Backend ↔ Mac helper (private local filesystem and executable environment).
5. Aelys modules ↔ untrusted emails/documents/agent outputs.
6. Telegram ↔ Aelys bot endpoints.

Each boundary needs authentication, authorization, minimized payloads, rate limits and content redaction.

## 3. Identity, sessions, devices

- Secure user authentication; session lifetimes, refresh/revoke and optional MFA planned.
- Device enrollment and independent revocation with key rotation; helper cannot present itself as arbitrary device.
- TLS for communication; prevent replay (nonces/expiring leases), bind commands to authenticated owner/device/project.
- Strict origin/CORS/CSRF rules if cookies used; avoid wildcard origins with credentials.

## 4. Authorization model

- `PermissionContext(owner, actor_type, device_id, project_scope, tool_scope, expiry, policy_id)`.
- AI acts as the owner subject to narrower scopes; no automatic administrator power.
- Tool invocations require server-side and (for Mac) local policy enforcement.
- Rule execution identity separate from manually issued user commands.
- Autonomous permissions are **not** equivalent to disabling all sandbox/security prompts in CLI. Respect vendor CLI security boundaries unless security spike demonstrates equivalent isolation.

## 5. Mac code execution threat model

Threats: prompt injection in source code, symlink escapes, shells reading `$HOME`, leaking keys via env, network egress, git push, destructive commands, docker socket privilege, arbitrary repository hooks, process escape, malicious plugins.

Controls required before enabling unattended remote running:
- Real OS-level/process isolation evaluated on macOS, not only allowlisted `cwd` string.
- Distinct isolated worktree/copy with controlled mounts and permissions.
- Dedicated unprivileged identity where feasible; no privilege escalation.
- Sanitized environment, no inherited credentials/tokens, minimal PATH.
- Explicit network policy; default deny or allowlist if tool requires egress.
- Resource quotas, max runtime, subprocess supervision, kill tree on cancellation.
- Audit, human-visible project grant and revocation.
- Test with attempted escape and secret access; if tests fail, mode remains blocked.

Owner preference «не подтверждать каждую команду» applies to commands **inside already approved controls**, not arbitrary external irreversible actions.

## 6. Data classes / retention

| Class | Location | Cloud policy |
|---|---|---|
| Notes/tasks/events/finance | Device cache + owner DB | Synced as configured |
| Mail bodies | Only if account/import & user enables storage | Sensitive, encrypted at rest where practicable |
| LLM provider API keys/OAuth | Secret store | Encrypted; never returned |
| Mac raw agent transcripts | Mac local store only | **Never replicate** |
| Mac FTS/embedding of transcripts | Mac | **Never replicate** |
| Agent session index metadata | Mac + cloud | Only allowlist fields |
| Temporary AI excerpts | Runtime memory/transient stream | No cloud persistence/logs by default |
| Audit | Backend | Non-sensitive metadata with retention |

Sensitive finance/mail requires explicit tool scopes and no unrestricted prompt context.

## 7. Privacy-sensitive AI path

`Mac FTS → requested excerpts → backend transient relay → optional external LLM`.

Sending excerpts to external model constitutes disclosure to provider. Must be switchable per project/provider. If no consent, local answer or metadata-only result; no misleading assurance of total local processing.

## 8. Secrets handling

- `.env.example` only placeholders; `.env`, credentials, token databases and local session files gitignored.
- Encryption at rest and keys outside Git and DB; secure local OS keychain where feasible.
- No secrets in crash reports/exception traces/web request logs or SSE replays.
- Credentials rotated/revoked; provider response auditing should not store raw headers.
- Runtime isolation attestations are accepted only when runtime and probe digests match an operator-pinned Ed25519-signed release manifest; missing or invalid trust configuration fails closed.
- GitHub Actions / future CI secrets least privilege, separate production deployment grants.

## 9. Open-source release controls

- License to be finalized; proposed Apache-2.0.
- Document data-flow and permission prompts.
- Threat model and vulnerability disclosure policy (`SECURITY.md` for public repository can be adapted from this technical document).
- Dependency/license scanning, CI security tests, signed releases if feasible.
- No automatic upload of local histories even for debugging or telemetry.

## 10. Backup / deletion

- Backups of synced PostgreSQL data must be encrypted and restorable.
- **OPEN:** user has not confirmed off-Mac backups of Mac-only sessions. Default: no such cloud backup; provide manual local export only after explicit action.
- Account delete/export, device local wipe and logs retention policies must be documented before public beta.
- Revoke project access stops new runs; attempt to cancel already running jobs according to documented policy.

## 11. Security release gates

1. Cannot read unrelated paths outside allowed project even with symlink/subprocess tricks.
2. Agent cannot access backend secrets/keychain or exfiltrate via granted run if not explicitly scoped.
3. Agent transcript never appears in Postgres, HTTP access logs, telemetry or sync payloads.
4. Revoke device disables commands and sync; replay requests rejected.
5. Prompt injection in email cannot trigger external send or start agent.
6. State-changing requests logged with actor/resource/policy decision without raw secrets.
