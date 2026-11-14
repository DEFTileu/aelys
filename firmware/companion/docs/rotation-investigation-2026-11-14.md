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

A thread-local host variant prevented 10,000 unrelated same-size allocations
from another thread from consuming the reserve, but an unrelated same-size
allocation on the registering thread still consumed it. Thread identity and
size alone therefore do not prove the handoff reaches the intended call. This
variant remains a host experiment, not a firmware allocator change.

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

An additional synthetic host benchmark timed only the software transform, not
rendering or device execution. In one 120-iteration run, a 494 × 325 buffer
averaged 2,242 μs per transform versus 1,188 μs for 390 × 221 and 852 μs for
300 × 200. Content and dimensions differ, so these figures only illustrate
host scaling; they do not establish board frame rate. The runner is in the
ignored `rotation-timing/` directory.

A compact host variant uses the descriptor and inverse-sampler bounds to size
separate source and destination buffers. In a synthetic retained-root test,
130% Home and 50% Pair faces retained 355,428 requested bitmap bytes together,
versus 1,474,412 in the older host prototype; both released those allocations
on deletion. Another 130% transition sequence peaked at 506,529 live requested
bytes including buffer growth, with 2,923,762 cumulative requested bytes over
18 allocations. These exclude LVGL allocations and allocator overhead and do
not bound other histories. The copied suite passed 40/40 but omitted owner,
screen-FSM and board-port tests; six scale/fault variants each passed 720
partial/full comparisons. A padded reference matched 279 sampled rotated frames
at each scale. Fragmentation, asynchronous lifetime, complete OOM recovery,
visual fidelity and hardware performance remain open. Details and the 29 sampled
allocation-failure positions are in the ignored `rotation-compact/` ledger.

A separate host visual probe found a renderer-switch discontinuity: in a
forced worried-blink stress frame, changing group angle from −0.09° to −0.10°
changed 11.5% of the foreground-union silhouette (RGB mean error 20.3/255).
Worried does not naturally rotate in the current table, so this is a controlled
counterfactual, not an observed normal animation. The probe also measured
differences during actual rotating moods; those include intended rotation and
are not automatically defects. Neither partial/full equality nor similarity to
the old unrotated renderer proves design fidelity. See the ignored
`rotation-fidelity/REPORT.md` for sampling, metrics and limitations.

In the current single UI task and software renderer, source inspection shows
that LVGL drains drawing tasks for all strips before `LV_EVENT_RENDER_READY`.
Updating the source later from the serialized UI task, outside refresh, then
invalidating the image is a candidate lifetime protocol; changing it from a draw
or flush callback is not. The panel's last DMA transfer can outlive this event,
but reads a separate display buffer. This reasoning is configuration-specific
and has not yet been validated with delayed-flush and deletion tests.

## Continuous raster and design-reference experiments

A host-only variant uses the raster path for supported pill eyes even at zero
rotation. In a frozen, counterfactual worried-blink frame at 100% scale, the
foreground-union difference across -0.09 to -0.10 degrees fell from 11.598%
to 0.099%. Across the sampled states the worst boundary difference fell from
11.598% to 0.928% at 100%, and from 5.309% to 2.063% at 130%. The bitmap
appearance at zero also differs from the original objects, and unsupported
forms, allocation failure and recovery still switch renderers. These sampled
metrics are not a complete design or transition validation.

In one 130% host sequence, checked 1.5x geometric buffer growth reduced
allocation calls from 21 to 4 and cumulative requested bytes from 3,323,311
to 624,012; retained bytes increased from 333,642 to 374,406. Peak live
requested bytes including replacement overlap were 506,529 and 499,209,
respectively. These figures exclude LVGL allocations, allocator overhead and
other histories. A larger growth request may fail where exact sizing succeeds.
Both copied suites passed 41/41, excluding owner/contact and board-port tests;
sampled one-shot bitmap failures and partial/full checks passed. Persistent
OOM, LVGL allocations, fragmentation and device performance remain untested.
See the ignored `rotation-continuous/README.md` for methods and limits.

A separate offline reference extracts only eye-related CSS from the local
design. At 100%, selected open mischief, wink and dizzy frames differed from
the compact prototype by 0.67%, 2.17% and 6.74% of the foreground union,
respectively. Browser antialiasing, RGB565 quantization and animation timing
contribute; these are not approved acceptance thresholds. The reference covers
only selected frames and is recorded in ignored `design-reference/`.

The decoder-registration source audit found one node allocation on the pinned,
uninstrumented LVGL 9.6 success path, but task identity and allocation size do
not protect a reserve from same-task reentry or interrupts. Memory trace hooks
can run before the allocation. An independent host rerun confirmed reserve
theft, fail-stop mismatch handling and the successful registration/deletion
case. Correct target ABI, configuration, ISR exclusion, ownership, lifetime
and all other LVGL allocation failures require separate proof. None of these
experiments is integrated into the firmware.

## Delayed flush and builtin decoder wrapper probes

An isolated host harness held the submitted RGB565 display buffer until a
simulated flush-wait or explicit completion. At 100% and 130%, respectively,
112/112 and 131/131 submitted transfers completed with no detected changes to
pending pixels. Updating, deleting and recreating the face, and invalidating it
while a transfer was pending each matched a forced full redraw. Deletion
poisoned and freed the two tracked eye bitmaps while an eye-window transfer was
pending. A deliberate display-buffer corruption was detected by the negative
control. `RENDER_READY` occurred with a transfer pending 13 times at each scale:
it is not a DMA completion fence. Under the tested serialized software-renderer
schedule, the results support a source-bitmap lifetime fence at refresh return;
they do not prove asynchronous renderer, concurrent mutation, actual DMA,
missing completion, cache coherency or board behavior. See ignored
`lifecycle-delay/README.md` for the harness and limitations.

Another host-only diagnostic wrapped the existing builtin decoder callbacks,
for one exact prepared-buffer pointer, avoiding a new decoder registration and
allocation for the tested open/close. Existing A8 decoding and a partial display
redraw also passed, with and without selected cache settings. This global hook
is not integrated and is not safe as written: a higher-priority decoder can
claim the source first (demonstrated), pre-existing cache entries can bypass the
wrapper, and callback replacement, open sessions and multiple source lifetimes
need serialization and quiescence. Review also found unresolved buffer ownership
and `ALLOCATED`-flag, stride-alignment, and retained get-area callback hazards.
The diagnostic's static buffer and single-source tests do not prove those cases.
The diagnostic alone passed ASan/UBSan with prebuilt LVGL uninstrumented and
leak detection disabled. See ignored `decoder-wrap/README.md` for details; this
does not make ordinary LVGL drawing or other decoding allocations recoverable.

An eye-only CSS comparison sampled three mood switches at 100% and 130%,
using the continuous-raster host prototype. Calm-to-curious CSS changes the
eye dimensions immediately, whereas the host interpolates the numeric
geometry; the objective explicitly requires per-frame springs, so the CSS
class-switch instant is not by itself an instruction to remove interpolation.
A separate measured difference is the wink and group-motion easing: at the
sampled mischief wink onset, CSS scaleY was 0.833 and the host openness was
0.946; animation phase and renderer differences also affect the pictures. All
66 sampled host frames used the bitmap path, but finite samples do not cover
fallback or every transition. The comparison is descriptive, not an approved
pixel threshold; see ignored `design-transition/README.md` and its frames.

## Borrowed bitmap draw-task experiment

A separate host-only LVGL 9.6 source copy adds an ordered software draw task
for a caller-owned, already-decoded ARGB bitmap. It uses the captured task
clip and the software blend path without registering or opening an image
decoder. Task creation makes one checked LVGL allocation; the ordinary task
path retains its malloc assertion. In seven synthetic cases, the result matched
ordinary decoded-image rendering for selected full and partial buffers, clips,
overlays and intermediate layers in RGB565, RGB565-swapped and ARGB8888.
Swapped rendering was enabled locally for the test, not verified on hardware.
Injected failure of the new task allocation left tested queues unchanged; it
omitted the image and is not a complete fallback policy. Forty-one observed
borrowed blends made zero allocator calls, not a claim about all refresh costs.

The test and an ASan/UBSan build instrumenting both LVGL and the harness were
independently rerun successfully; leak detection was disabled. This is an
unintegrated private LVGL patch, not a complete S2 solution: buffer capacity,
borrowed lifetime, asynchronous execution, dispatch guards, multi-strip
failure and recovery, real rotation frames, broader LVGL OOM behavior and target
performance remain unproven. See ignored `borrowed-task/report.md` for test
configurations, source and reproduction instructions.

A subsequent isolated integration combines this borrowed task with the
spring-driven rotating-pill prototype. It checks buffer alignment, stride,
capacity and some arithmetic before queueing, restricts the tested software target
formats, and appends its experimental task type. Independent review found the
checks do not bound the blender's signed stride and row-offset arithmetic; a
rejected invalid source can also be passed to the decoder fallback. A serialized host protocol
asserts that face buffers are not mutated during refresh and counts tasks that
execute. In 12 sampled scale/fault cases, each 720 partial frames matched full
redraws; selected one-shot submission failures in multi-strip refreshes used
the decoded-image fallback. One 130% fault case was independently rerun. The
copied suite passed 41/41, excluding owner/contact and board-port tests. A
sanitizer run covered copied LVGL and the test, but the imported logic archive
was not instrumented and leak detection was disabled.

This is still not safe to integrate: submission may succeed before dispatch
fails; the global counter cannot retire cancelled or never-executed tasks;
other draw units are not excluded; and the fallback itself can allocate and
assert. Diagnostic C assertions are not a release lifetime protocol. Delayed
flush was simulated, but delayed draw execution, persistent OOM and real DMA
were not tested. The full/partial oracle shares the renderer and is not a CSS
fidelity reference. See ignored `borrowed-rotation/report.md` for details.

An isolated successor distinguishes invalid input from a checked task-node
allocation failure, so its tested face callback skips decoder fallback for an
invalid stride. It also adds restrictions for the blender's signed offsets and
moves its diagnostic pending count to task cleanup; a simulated unsupported
software renderer exercised one failed-task cleanup. The targeted failure test
and a 130% ASan/UBSan rotation case were independently rerun successfully;
the imported logic archive was not instrumented and leak detection was disabled.
Independent review confirmed the two tested corrections but found that the
blender can form an out-of-object pointer after its final row with a minimally
sized padded buffer, and that invalid input has no automatic redraw repair.
This is not a per-source ownership or cancellation protocol. No borrowed draw
task was deliberately held across source mutation or deletion, and a task that
fails after successful submission has no visual recovery. The prototype remains
unintegrated; see ignored `borrowed-retirement/report.md`.

A follow-up host test kept a real borrowed draw task waiting on a detached
layer, then mutated its caller-owned source. The queued descriptor observed the
new pixels; the deliberately failing test was independently rerun. This proves
that the current experimental task does not freeze or own its source. It does
not execute the delayed task or test deletion, growth, cancellation, actual
threading or hardware. A candidate immutable-generation and reference-counting
protocol is described in ignored `borrowed-owner/INVESTIGATION.md`; it has not
been implemented or validated.

A further isolated host adapter copies source pixels into immutable generations
and gives each tested queued task a reference. In one serial test an LVGL task
remained waiting while its owner was replaced and deleted, then the software
renderer produced the original pixels; staggered cleanup and selected failures
were also exercised. The focused normal and ASan/UBSan binaries were rerun;
leak detection was disabled. Independent review found that queued success does
not report later rendering failure, in-progress teardown lacks a worker
completion handshake, and the experimental ownership API permits unsafe copies
and mismatched release callbacks. The adapter is not connected to the face,
and concurrent workers, actual face deletion, failure recovery, and the
separately flagged boundary issue remain open. See ignored
`source-owner2/INVESTIGATION.md`.

An isolated follow-up added a task-outcome handle to the serialized host
ownership experiment. Focused tests reported renderer rejection, explicit
retry with visible pixels, successful task cleanup and cancellation of a
waiting task after owner deletion. The focused tests were independently rerun;
no full suite or sanitizer run was performed for this iteration. The retry is
explicit, task retirement is not display/DMA delivery, and in-progress
cancellation, concurrent workers, real allocation failures, automatic repair
and actual face integration remain unverified. The separately flagged boundary
investigation remains open. See ignored `source-outcome/REPORT.md`.

A separate host-only relief experiment combined inherited blinking with an
approximated, clipped elliptical lid. A partial/full redraw test was independently
rerun successfully, but selected CSS comparisons differed notably during blink
(about 22–29% foreground-union XOR at 100%, 21–24% at 130% for the sampled
closing frames). Metrics mix timing, antialiasing and rendering differences and
are not acceptance thresholds. The scanline version submitted up to 80 and 104
lid rectangles per sampled full refresh at 100% and 130%; source inspection
indicates each can allocate a draw task. These are not measured peak heap or
board timing. It is not integrated. See ignored `relief-experiment/README.md`.

Another isolated serialized ownership experiment tested opaque owners, waiting
task cancellation and a post-queue dispatch failure. Three focused normal and
ASan/UBSan tests were independently rerun; leak detection was disabled and a
prebuilt logic archive was not instrumented. Independent review found a
possible blocked parent layer after cancellation and gaps in failed-task
retirement tests. A subsequent host fix requests dispatch and adds a parent/child
regression plus failed-task lifetime tests; four focused normal and ASan/UBSan
checks were independently rerun. Leak detection remained disabled and a logic
archive was not instrumented. The experiment remains unintegrated and is not
evidence of asynchronous teardown, automatic recovery or display delivery. See ignored
`source-outcome2/REPORT.md`.
