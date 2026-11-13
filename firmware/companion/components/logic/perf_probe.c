#include "perf_probe.h"
#include <string.h>

void perf_probe_init(perf_probe_t *p) { memset(p, 0, sizeof *p); }

void perf_probe_interrupt(perf_probe_t *p)
{
    if (p->pending) { p->pending = false; p->stats.sw_interrupted++; }
}

void perf_probe_swipe_begin(perf_probe_t *p, uint32_t posted_us, uint32_t handled_us, bool accepted, uint32_t screen)
{
    perf_probe_interrupt(p);
    if (!perf_probe_request_fresh(posted_us, handled_us)) { p->stats.sw_timeout++; return; }
    if (!accepted) { p->stats.sw_refused++; return; }
    p->posted_us = posted_us;
    p->handled_us = handled_us;
    p->target_screen = screen;
    p->pending = true;
}

bool perf_probe_request_fresh(uint32_t posted_us, uint32_t now_us) { return now_us - posted_us < 1000000u; }

void perf_probe_transfer_failed(perf_probe_t *p)
{
    p->stats.frames_failed++;
    if (p->pending) { p->pending = false; p->stats.sw_transfer_failed++; }
}

void perf_probe_expire(perf_probe_t *p, uint32_t now_us)
{
    if (p->pending && now_us - p->posted_us >= 1000000u) {
        p->pending = false;
        p->stats.sw_timeout++;
    }
}

void perf_probe_frame(perf_probe_t *p, uint32_t start_us, uint32_t end_us, uint32_t te_us, uint32_t screen)
{
    perf_probe_stats_t *s = &p->stats;
    uint32_t d = end_us - start_us, work = d - (te_us > d ? d : te_us);
    s->frames++;
    if (d > 16700) s->n17++;
    if (d > 25000) s->n25++;
    if (d > s->worst_us) { s->worst_us = d; s->worst_te_us = te_us; }
    if (work > s->work_max_us) s->work_max_us = work;
    if (work > 16700) s->work_n17++;
    if (!p->pending) return;
    if (screen != p->target_screen) { perf_probe_interrupt(p); return; }
    perf_probe_expire(p, end_us);
    if (!p->pending || (int32_t)(start_us - p->handled_us) < 0) return;
    p->pending = false;
    uint32_t latency = end_us - p->posted_us;
    s->sw_ok++;
    s->sw_last_us = latency;
    if (latency > s->sw_max_us) s->sw_max_us = latency;
    uint32_t bin = latency / 5000;
    s->sw_hist[bin < 20 ? bin : 20]++;
}

void perf_probe_mailbox_init(perf_probe_mailbox_t *m)
{
    memset(m, 0, sizeof *m);
    tribuf_init(&m->tb, &m->slots[0], &m->slots[1], &m->slots[2]);
}

void perf_probe_publish(perf_probe_mailbox_t *m, perf_probe_t *p, uint32_t now_ms, uint32_t screen)
{
    p->stats.seq++;
    p->stats.sampled_ms = now_ms;
    p->stats.screen = screen;
    *(perf_probe_stats_t *)tribuf_back(&m->tb) = p->stats;
    tribuf_publish(&m->tb);
}

bool perf_probe_read(perf_probe_mailbox_t *m, perf_probe_stats_t *out)
{
    bool fresh;
    const perf_probe_stats_t *s = tribuf_latest(&m->tb, &fresh);
    if (fresh) *out = *s;
    return fresh;
}
