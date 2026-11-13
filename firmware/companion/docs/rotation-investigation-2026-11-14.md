# Companion eye rotation: host investigation, 2026-11-14

S2 remains incomplete. The design rotates the eye group, including highlights
and lids; the current implementation rotates the eye centres only. The board
was not present, and no hardware, heap, frame-rate or TLS measurements were
made during this investigation.

A host-only LVGL prototype placed eyes and their masks in a group and rotated
it. The intended tilt became visible. With ordinary group invalidation the
existing 32-row partial-buffer pixel oracle found stale or differing pixels,
while two successive full redraws matched. Expanding the invalidation to
full-width strips aligned to the partial-buffer boundaries made that oracle
pass, but violated the existing face-only damage bound. This observation is
specific to the current LVGL renderer and configurations; it does not establish
the precise cause of every mismatch.

In identical host tests, a 130% face at the same position was warmed up, then
advanced 100 times by 34 ms. The numbers are total pixels sent to the simulator
flush callback, not board bandwidth or timing:

| Mood | Current implementation | Full-width prototype |
|---|---:|---:|
| Curious | 1,281,536 pixels / 62 refreshes | 17,894,400 pixels / 100 refreshes |
| Mischief | 169,148 pixels / 23 refreshes | 17,894,400 pixels / 100 refreshes |

The prototype invalidated on every animation step even where the angle was
unchanged; this is a known inefficiency. It was not enabled or committed. Its
reproducible draft, benchmark sources and a simulator image are in the ignored
S2 ledger directory (`rotation-lvgl-prototype.patch`, `rotation-bench.c`,
`rotation-curious-bench.c`, `shots/mischief-rotation-prototype.png`). The draft
contains diagnostic test changes and is not a release patch.

A possible next spike is to render eyes into a reusable PSRAM-backed draw
buffer and rotate the resulting image, so partial refreshes sample the same
source regardless of strip clipping. Verify LVGL snapshot/render APIs and their
lifetime, transparency, clipping, memory use, and redraw behaviour first;
`LV_USE_SNAPSHOT` is currently disabled. Any solution must pass both the
partial-buffer pixel oracle and the face-only damage bound, and needs actual
board measurements before making claims about the 30 fps face or internal RAM.
