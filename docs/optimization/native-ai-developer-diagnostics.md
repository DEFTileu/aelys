# Local AI transport diagnostics

Task: Phase 8 native transport contract diagnostics. The owner requested a hidden
logo gesture and local diagnostics. Assumptions: ten presses within twelve seconds
opens a temporary panel; the existing AI-run creation problem is the initial
instrumented operation. No OPEN architecture decision is changed.

The panel is disabled by default. It records at most 50 entries in memory, clears
on disabling or process exit, and never writes to disk or sends diagnostics to
another service. At the owner's request it shows the request and response bodies
of every native API call, including message text, and each event of an AI run
stream. Fields named like passwords, secrets, API keys, tokens, cookies,
authorization, encrypted values and setup codes are replaced with `[скрыто]`;
strings longer than 4000 characters and arrays longer than 50 items are cut.
Native code still reports the actual HTTP status and cost for POST
/api/v1/ai/runs. Headers, provider credentials and CLI sessions are not recorded.

The visible mark has a small click animation, respects reduced-motion and works
on desktop and the mobile home screen. The design references available in this
checkout do not identify a specific original logo animation, so exact design
parity remains unverified. A rebuilt native client is required; web-only updates
cannot add the native diagnostic channel.
