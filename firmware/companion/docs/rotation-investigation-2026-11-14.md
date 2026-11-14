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

The raster API can draw bodies, highlights and masks in separate passes so
two eyes retain the existing global stacking order, including overlapping
geometry. Slanted masks can also receive explicit absolute rectangle bounds
instead of assuming fixed unscaled margins. Tests exercise overlapping eyes,
invalid flags, mask clipping and guarded random frames; the UI still does not
use this API. The caller must validate all eyes before relying on a sequence
of individual draws as an atomic frame, and must derive the actual transformed
bounds and cut geometry. This does not establish transition or visual parity.

In a separate synthetic overlap spike at 130% scale, composing each whole
eye in sequence instead of using global passes changed 29 ARGB pixels. Against
a more generously padded raster surface, a 390 × 221 surface lost 2,399–4,530
nontransparent pixels outside the destination and differed at 93–1,440 pixels
inside it at four rotations. These counts include black mask pixels; the
intended clipping of those pixels has not been established. Comparing the
software rotation to LVGL rotating the same raster source gave 5–17 silhouette
differences and 2,260–2,534 RGB565 differences. That is not an independent
reference for eye shapes and does not establish visual equivalence. On pixels
lit in both images, the maximum per-channel difference was 4 RGB565 code
values; mean absolute differences were at most 0.071 red, 0.152 green and
0.041 blue codes across these cases. An opaque flat-colour control matched
exactly away from edges. These measurements do not isolate sampling from alpha
blending or quantization. The
reproducible host spike is in the ignored ledger (`layered-spike/`); its images
are static and its existing partial-redraw suite exercises the unchanged UI.

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

An isolated host spike subsequently exercised that decoder with an 8 × 8
caller-owned buffer: decoder registration made one LVGL allocation, the
built-in open made one allocation per open, and the custom open made none,
including with an allocator that rejected allocations during that open. An
existing A8 image continued to use the built-in decoder, and both appeared in
32-row partial-buffer output. A sequential source change plus invalidation
redrew correctly. Runtime image and header caches did not create an entry for
the custom source in this probe. The spike and exact commands are in the
ignored S2 ledger (`decoder-spike/`). It did not test allocation failure during
registration or rendering, concurrent mutation, delayed flush, cache eviction,
rotation, or device performance; it is not connected to the firmware.

A second host-only spike used two independently owned buffers over six refreshes
and 90 partial strips. Both remained independent through serialized updates,
hide, widget deletion and recreation; an illustrative guard rejected writes
during rendering. This does not prove safe asynchronous mutation, owner
destruction during drawing, cache hits after address reuse, or hardware DMA
behaviour. Commands and captured output are in `decoder-spike/`.

A separate host experiment reserved the pinned LVGL decoder-node allocation
before registration. A failed reserve skipped registration; a successful one
was consumed and later freed once. Wrong-size allocation or reallocation while
the handoff was armed deliberately fail-stopped in isolated test processes.
An unrelated allocation of the same size consumed the reserve, demonstrating
that a size check alone cannot establish ownership. This experiment depends on
private allocation details and is not enabled in the firmware. The one-shot
handoff, task ownership, target allocation and all drawing allocations still
need validation; it does not make LVGL startup or rendering OOM-safe.

Another host spike called the pinned LVGL software transform directly with
caller-owned straight-ARGB8888 source and destination buffers. At four tested
angles (3.5°, 9°, −9° and −3.7°), whole-frame and 32-row clipped calls were
byte-identical, and the RGB565 framebuffer matched LVGL's transformed-image
draw. No LVGL allocation or free calls occurred during those transform calls,
including with allocation rejection armed; guard bytes remained intact. This
internal, version-specific API still requires validated bounds, strides,
nonoverlapping storage and lifetime, and it does not present the result or
eliminate decoder and draw-task allocations. Target linking, other alpha and
configuration cases, transitions and board performance remain unverified. The
host source and runner are in `decoder-spike/sw-transform.c` and
`decoder-spike/run-sw-transform.sh` in the ignored ledger.

The experimental `face_lvgl_rotate_region` adapter now validates disjoint,
aligned ARGB surfaces and renders into an explicit output rectangle, so its
caller can request padding rather than silently crop to the source dimensions.
It is limited to 512 pixels per dimension and returns false for unsupported
LVGL versions/configurations or invalid inputs. The convenience same-size
variant intentionally clips. Host tests compare framebuffer pixels with LVGL,
including fractional and quarter turns, a padded source and an expanded output;
they also check invalid inputs and guards at the maximum dimensions. The ESP-IDF
build compiles the adapter, and a relocatable target link resolves its transform
symbol. Since the UI does not call it, the normal firmware link may discard it;
this is not an execution or performance test on the device. Full eye bounds,
presentation, allocation recovery and lifecycle remain open.

An unrotated descriptor-bounds helper now returns a conservative half-open
union of the raster loops for a selected eye's body, highlight and mask. It
does not yet bound the rotated output. A host sweep of the LVGL transform
found counterexamples to using LVGL's transformed rectangle as-is, and even
with a one-pixel margin: a 467 × 457 source at 52.9° produced a visible pixel
two pixels outside that rectangle. A two-pixel margin contained all observed
pixels in 156,000 tested cases, but this is not a proof for the adapter's full
input domain. Some bounds also exceed the adapter's 512-pixel output limit.
Do not use the sampled margin as a production guarantee without establishing a
bound for the pinned fixed-point calculations and a fallback or tiling policy.
The ignored `bounds-transform/NOTES.md` records the cases and commands.

The experimental adapter also computes a conservative rotated bound from the
pinned sampler's inverse mapping, instead of relying on the forward rectangle.
At unit scale the sampler's Q8 source coordinates are sums of two separately
floored terms. Their two rounding remainders add at most six units after
multiplication by four. Bounding each source coordinate to the image and
inverting the resulting integer matrix gives a conservative rectangle; the
implementation uses 64-bit intermediates and explicit floor/ceiling division.
The argument depends on LVGL 9.6.0's exact sampling code and arithmetic right
shift. A separate audit checked the derivation, and the tested ESP32-S3 compiler
uses arithmetic right shift. The adapter fails closed if its compile-time
version, configuration or shift assumptions do not hold. A valid bound can
still exceed the adapter's single-buffer or reachable-coordinate limits; the
caller must check them and provide a safe fallback. This calculation is not
connected to the UI and does not prove runtime allocation or frame-time safety.

A later host-only integration prototype rendered actual spring-driven eyes,
highlights and lids in global passes, then used the LVGL software transform.
Mischief visibly tilted. At 100% and 130%, six combinations of scale and
injected bitmap-allocation failure each compared 720 partial-buffer frames to
full redraws without differences; both tested allocation failures showed the
fallback face and later retried successfully. This covers the explicit bitmap
allocations, not LVGL decoder or draw-task allocation failures.

The prototype is not enabled: its full-image invalidation exceeds the existing
face damage bound, its two 494 × 325 ARGB surfaces cost 1,284,400 bytes at
130% before alignment, and rotated output can still be clipped. The copied
simulator suite passed 33/34 tests; `test_face_moods` failed, including the
damage bound and assertions requiring independent review after object
reparenting. Unsupported primitives use the original unrotated renderer.
The diagnostic source, fault tests and results are in the ignored
`rotation-next/` ledger directory. Full design fidelity, failure lifecycle,
device memory and frame timing remain unverified.

A subsequent host-only variant leaves the image object visible, gates its draw,
and invalidates bounding rectangles scanned from the old and new bitmap alpha,
including opaque black masks. Its 100% steady-state maximum invalidation
rectangle was 25,088 pixels, down from 95,500 for a deliberately restored
full-image invalidation; at 130% it was 41,656. These are rectangles, not flush
counts or device timings. Six scale/allocation-fault variants each passed 720
partial/full comparisons. The copied suite passed 38/38 tests, but excluded the
owner and screen-FSM tests because the throwaway copy omitted their dependencies.
The variant still needs a proven transformed bound, complete allocation and
lifetime checks, visual comparison and board measurements. Its extra bitmap
scans and 1.28 MB buffer cost are not yet measured on the device. Source and
limits are recorded in the ignored `rotation-damage/` ledger directory.

In the current single UI task and software renderer, source inspection shows
that LVGL drains drawing tasks for all strips before `LV_EVENT_RENDER_READY`.
Updating the source later from the serialized UI task, outside refresh, then
invalidating the image is a candidate lifetime protocol; changing it from a draw
or flush callback is not. The panel's last DMA transfer can outlive this event,
but reads a separate display buffer. This reasoning is configuration-specific
and has not yet been validated with delayed-flush and deletion tests.
