# Page bottom gutter and collapsed mail replies

Task: IMPLEMENTATION_PLAN Phase 3 / task 4 (Mail reading/drafts), with the
owner-requested shared desktop page gutter as its layout prerequisite.
Owner request 2026-11-04: keep 20–25px below page blocks, start the reply editor
closed, and provide a Mac build with DevTools enabled.

The desktop shell now owns a 24px bottom gutter. Known page wrappers remove
only their duplicate outer bottom padding; card-internal padding is retained.
Viewport-sized Mail, Notes, Knowledge, AI and Messages workspaces subtract the
same hero/gutter values so columns stop 24px above the bottom in a normal-height
window. Long/min-height layouts keep natural page scrolling and the 24px gap at
the end of content. Mobile safe-area/navigation spacing is preserved.

Mail initially shows a compact Reply disclosure. Its button exposes
aria-expanded/aria-controls; textarea/actions are hidden until opened. Changing
message closes it; text and per-message draft associations remain in existing
React state, including across hide/show and message switches. Full Compose and
draft save/Gmail-draft behavior retain their existing authorization and API.
No sending, data/schema, caching or fetch changes are introduced.

The requested signed Mac artifact uses the existing `devtools` feature. The
normal source default remains unchanged: inspectors are opt-in at build time.
No signing, Keychain, sandbox or backend security setting is weakened.

Validation is recorded in the delivery: web tests and TypeScript, actual-browser
bottom-gap measurements and disclosure interaction, signed DevTools build and
installed-app acceptance. No architecture OPEN decisions are changed.
