# Local AI transport diagnostics

Task: Phase 8 native transport contract diagnostics. The owner requested a hidden
logo gesture and local diagnostics. Assumptions: ten presses within twelve seconds
opens a temporary panel; the existing AI-run creation problem is the initial
instrumented operation. No OPEN architecture decision is changed.

The panel is disabled by default. It records at most 50 entries in memory, clears
on disabling or process exit, and never writes to disk or sends diagnostics to
another service. The request view shows only an allowlist of fields; text, IDs,
model and arbitrary content are redacted. Native code reports the actual HTTP
status and the allowlisted cost value for POST /api/v1/ai/runs, before response
sanitization, so an actual HTTP 200 can be distinguished from the frontend's
synthetic 502. Other endpoints, authentication, headers, provider credentials,
CLI sessions and event streams are not recorded. The panel does not provide
arbitrary raw response access, modify policies, or grant additional capabilities.

The visible mark has a small click animation, respects reduced-motion and works
on desktop and the mobile home screen. The design references available in this
checkout do not identify a specific original logo animation, so exact design
parity remains unverified. A rebuilt native client is required; web-only updates
cannot add the native diagnostic channel.
