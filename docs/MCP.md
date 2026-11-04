# Desktop MCP

Implementation task: IMPLEMENTATION_PLAN Phase 1 / task 3 (authenticated native
transport). Owner requested local read/write data access and desktop-mediated
server requests. This does not extend coding-agent filesystem grants.

The signed macOS application provides a stdio MCP process and a local Unix-socket
broker in the open desktop process. The broker uses the GUI's current in-memory
session. It never reads or rotates the GUI's refresh credential. The original
CLI and its legacy-session lock are unchanged.

## Enable and connect

Run the installed signed application once, sign in, then enable owner data access:

```sh
~/Applications/Aelys.app/Contents/MacOS/aelys-desktop --mcp enable
codex mcp add aelys -- ~/Applications/Aelys.app/Contents/MacOS/aelys-desktop --mcp stdio
```

Enable is an explicit grant to local MCP clients that can invoke the signed
application. It grants read/write access to supported owner data across projects
and unprojected records. The grant is separate from a sandbox/project execution
grant. The invoking agent remains subject to its existing sandbox and approvals.
A host-wide trusted local process that can invoke this signed application acts
with the same data grant; this is not process-specific agent identity.

To revoke, including already-running stdio processes:

```sh
~/Applications/Aelys.app/Contents/MacOS/aelys-desktop --mcp disable
```

A subsequent enable rotates the local authorization key. macOS may ask the owner
to approve access to the dedicated Keychain item. If an updated signed build reports `KEYCHAIN_ACCESS_REQUIRED`, run
`~/Applications/Aelys.app/Contents/MacOS/aelys-desktop --mcp unlock` and approve
the macOS prompt for the dedicated MCP item. This never unlocks an arbitrary
Keychain item or returns its contents. No credentials belong in MCP
configuration or tool arguments. Reopen/reconnect an MCP client to discover tools.
The desktop application must remain open and signed in. Sign-out/revocation
continues to be enforced by the native session and backend.

## Tools

- `aelys_catalogue`: typed operation examples accepted by the policy engine.
- `aelys_read`: `{"operation":{"type":"projects"}}` (also tasks, notes, paged
  note/mail reads, calendar, finance, focus, mail drafts, activity, notifications,
  AI conversation/message reads).
- `aelys_write`: `{"request_id":"unique-intent-uuid","operation":{"type":
  "note_create","note":{"title":"Plan","markdown_body":"Next steps"}}}`.
  Supported writes include projects, tasks, notes, calendar events/reminders,
  finance ledger records, focus sessions, mail drafts and notification read state.

Use actual current versions for edits. Decimal money must be JSON strings.
Typed validation, ownership, backend policy and version checks remain in effect.
The native MCP Policy Engine denies generic HTTP, provider secrets, auth/device
management, agent execution, automation rules and external AI calls. Mail tools
prepare local drafts; sending mail is unavailable. The broker does not read raw
CLI session history or upload files. There is no public network listener.

## Durability and recovery

Every write is durably recorded before dispatch under the private local MCP
directory, bound to origin, owner, device, operation and `request_id`. Completed
replays return the saved result. Reusing the ID with different input fails.
If a process/network/storage failure leaves a pending receipt, replay returns
`MCP_WRITE_OUTCOME_UNCERTAIN`; inspect the live record before deciding on a new
intent. There is no automatic replay of uncertain writes. Offline writes are
retained as pending local records but are not automatically sent on reconnect.
Read requests require the live server and do not use the GUI's IndexedDB cache.

The app serializes MCP requests. Frames are bounded to 2 MiB; socket reads and
writes have timeouts. The socket/directory are private (0600/0700); each request
is authenticated with an HMAC key retained in macOS Keychain. Neither that key
nor server tokens are returned to the MCP client. Stdout contains JSON-RPC only.
The broker uses the active GUI account; a client authorized by the owner can
access whichever account is currently signed in. Saved mutation receipts remain
partitioned by account/device/origin.
