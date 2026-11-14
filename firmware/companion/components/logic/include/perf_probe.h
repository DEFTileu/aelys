#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "tribuf.h"

/* Cumulative diagnostics, owned by the UI task. Histogram: 5 ms bins, last = >=100 ms. */
typedef struct {
    uint32_t seq, sampled_ms, screen;
    uint32_t frames, n17, n25, worst_us, worst_te_us, work_max_us, work_n17;
    uint32_t handler_max_us, ev_max_us, ev_max_type, snaps, snap_max_us;
    uint32_t sw_ok, sw_refused, sw_timeout, sw_interrupted, sw_max_us, sw_last_us, sw_hist[21];
    uint32_t sw_dropped;
    uint32_t frames_failed, sw_transfer_failed;
} perf_probe_stats_t;

typedef struct {
    perf_probe_stats_t stats;
    uint32_t posted_us, handled_us, target_screen;
    bool pending;
} perf_probe_t;

typedef struct { tribuf_t tb; perf_probe_stats_t slots[3]; } perf_probe_mailbox_t;

void perf_probe_init(perf_probe_t *p);
void perf_probe_frame(perf_probe_t *p, uint32_t start_us, uint32_t end_us, uint32_t te_us, uint32_t screen);
void perf_probe_swipe_begin(perf_probe_t *p, uint32_t posted_us, uint32_t handled_us, bool accepted, uint32_t screen);
void perf_probe_interrupt(perf_probe_t *p);
void perf_probe_expire(perf_probe_t *p, uint32_t now_us);
/* Reject stale queued requests before calling the UI callback. */
bool perf_probe_request_fresh(uint32_t posted_us, uint32_t now_us);
void perf_probe_transfer_failed(perf_probe_t *p);
void perf_probe_mailbox_init(perf_probe_mailbox_t *m);
/* One UI writer; one metrics reader. A skipped publish cannot lose cumulative worst times or failures. */
void perf_probe_publish(perf_probe_mailbox_t *m, perf_probe_t *p, uint32_t now_ms, uint32_t screen);
bool perf_probe_read(perf_probe_mailbox_t *m, perf_probe_stats_t *out);
