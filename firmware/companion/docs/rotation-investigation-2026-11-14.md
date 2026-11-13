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

## Reusable snapshot experiment

A second host-only prototype rendered the hidden eye group into a reusable
ARGB8888 buffer, drew that image with a rotation, and invalidated conservative
old/new eye bounds. It passed 32-row partial-buffer comparisons during
90-frame loops exercising curious, dizzy, love and mischief; the periodic UI
timer could also retarget the mood within each loop. Disabling both old and new
invalidation made the oracle fail, confirming that it exercises this path.
The same 100-step curious host scenario sent 3,176,864 pixels over 66 refreshes,
versus 1,281,536 over 62 for the current unrotated implementation. These are
host pixel counts, not physical display timing.

The experiment was not retained in the product. At the 130% Home scale the
snapshot pixel buffer alone requires approximately 344,760 bytes of PSRAM,
before alignment and other allocations. Independent review found that even
when the application's own buffer allocation is checked, LVGL allocates draw
tasks and gradient data inside `lv_snapshot_take_to_draw_buf()`. With the
firmware's `CONFIG_LV_USE_ASSERT_MALLOC=y`, failure can stop the UI before the
caller receives an error. Ordinary LVGL rendering also has this assertion
behaviour; the snapshot adds memory pressure and a further rendering path. A
free-memory check would reduce risk but cannot guarantee recovery from a
concurrent allocation or fragmentation. No global LVGL assertions were
disabled. The diagnostic patch and test are retained in the ignored S2 ledger,
not enabled in the firmware. The remaining question is how to render a stable,
rotated image without adding this failure mode, while meeting the existing
partial-redraw and memory constraints.

## Allocation-free raster primitives

The experimental `face_raster` module draws into caller-owned ARGB8888 storage
without allocating: gradient pills, A8 highlights, opaque slanted or dome lids,
and open rings with a caller-provided Q15 opening direction. It validates the
surface capacity and clips writes; it is **not connected to the UI** and does
not animate or display the face. Its visual comparison with the existing
LVGL renderer covers selected still poses and ring phases, not the design's
complete motion or spring transitions. At 100% scale the comparison found 64,
48 and 44 silhouette pixels different for calm, happy and worried respectively;
a 76 px ring differed by 42 pixels in each of eight tested phases. At 130%,
happy differed by 416 silhouette pixels. These are approximation measurements,
not a claim of pixel equivalence or hardware performance.

Host-only AddressSanitizer and UndefinedBehaviorSanitizer checks include 3,000
clipped randomized frames and guarded surface boundaries. Further work must
preserve the existing draw order across both eyes, separately validate animated
masks and highlights during spring retargets and blinking, rotate the composite
with correct old/new invalidation, bound its PSRAM storage and fallback, and
measure device CPU, heap and frame times. The renderer is a building block,
not completion of S2.

## Software rotation and image drawing experiment

The experimental module also rotates one caller-owned ARGB8888 surface into
another, with capacity and overlap checks and premultiplied bilinear sampling.
Host tests check identity, quarter turns, rejected buffers, fractional alpha and
colour, and transparent coloured neighbours. Six fractional angles from -9 to
9 degrees differed from LVGL's transformed silhouette by 12–25 pixels per
comparison; this does not establish exact colour or animation equivalence.

A separate, unretained UI prototype rasterized the eyes, rotated the bitmap,
and displayed it using `lv_draw_image`. It passed the host partial-buffer
oracle for the exercised mood loops. At 130% scale its two 442 × 273 ARGB8888
buffers require 965,328 bytes before alignment. Over 100 host animation steps,
curious flushed 3,176,864 pixels in 66 refreshes versus 1,281,536 in 62 for
the existing implementation; mischief flushed 1,129,944 in 23 versus 169,148
in 23. These are not device performance measurements.

Independent review found that each clipped image draw can open LVGL's built-in
image decoder, which allocates and asserts on allocation failure. The checked
bitmap allocations and their tested retry therefore do not make the complete
path recoverable. Ordinary LVGL draws also have allocation assertions, but
this path adds decoder allocations and substantial memory pressure. The UI
prototype is not enabled; its diagnostic patch and allocator-fault test are in
the ignored S2 ledger. No assertion was disabled. A recoverable drawing path,
transition and draw-order fidelity, and board measurements remain open.

Directly compositing pixels from an object draw event was also investigated.
In the pinned LVGL version, pending tasks can include blocked layer composites;
the event is not itself an ordered draw task, and the effective object clip is
internal state. The event's layer can also be an intermediate layer rather than
the display strip. The current synchronous software configuration is therefore
not sufficient evidence that direct buffer writes preserve clipping and draw
order. This approach was not enabled.

Source review identified a narrower decoder experiment: a custom decoder could
return a persistent, caller-owned `lv_draw_buf_t` for one explicitly recognized
source, avoiding the built-in decoder's per-open allocation. It requires LVGL's
private decoder descriptor API; registration itself allocates and asserts,
normal draw tasks still allocate, and queued tasks must finish before the
buffer changes or is released. Cache behaviour and software draw arguments
also need explicit bounds. This is an untested possibility, not an enabled or
proven recovery mechanism. A prototype would require allocation-fault and
queued-task lifetime tests in addition to the partial-buffer oracle.

In the current single UI task and software renderer, source inspection shows
that LVGL drains drawing tasks for all strips before `LV_EVENT_RENDER_READY`.
Updating the source later from the serialized UI task, outside refresh, then
invalidating the image is a candidate lifetime protocol; changing it from a draw
or flush callback is not. The panel's last DMA transfer can outlive this event,
but reads a separate display buffer. This reasoning is configuration-specific
and has not yet been validated with delayed-flush and deletion tests.
