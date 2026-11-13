#include <limits.h>
#include <string.h>
#include <pthread.h>
#include "check.h"
#include "perf_probe.h"

static void test_latency_matches_a_completed_frame(void)
{
    perf_probe_t p;
    perf_probe_init(&p);
    perf_probe_swipe_begin(&p, 1000, 2000, true, 3);
    perf_probe_frame(&p, 1500, 2500, 0, 3); /* refresh began before the request was handled */
    CHECK_EQ(p.stats.sw_ok, 0);
    perf_probe_frame(&p, 2000, 31000, 10000, 3);
    CHECK_EQ(p.stats.sw_ok, 1);
    CHECK_EQ(p.stats.sw_last_us, 30000);
    CHECK_EQ(p.stats.sw_max_us, 30000);
    CHECK_EQ(p.stats.sw_hist[6], 1);
    CHECK_EQ(p.stats.frames, 2);
    CHECK_EQ(p.stats.n17, 1);
    CHECK_EQ(p.stats.n25, 1);
    CHECK_EQ(p.stats.worst_us, 29000);
    CHECK_EQ(p.stats.worst_te_us, 10000);
    CHECK_EQ(p.stats.work_max_us, 19000);
    perf_probe_frame(&p, 32000, 33000, 0, 3);
    CHECK_EQ(p.stats.sw_ok, 1);
}

static void test_failures_are_not_latency_samples(void)
{
    perf_probe_t p;
    perf_probe_init(&p);
    perf_probe_swipe_begin(&p, 0, 10, false, 4);
    CHECK_EQ(p.stats.sw_refused, 1);
    perf_probe_swipe_begin(&p, 100, 200, true, 3);
    perf_probe_interrupt(&p);
    perf_probe_frame(&p, 300, 400, 0, 3);
    CHECK_EQ(p.stats.sw_interrupted, 1);
    perf_probe_swipe_begin(&p, 500, 600, true, 3);
    perf_probe_frame(&p, 700, 800, 0, 0); /* another screen replaced the target */
    CHECK_EQ(p.stats.sw_interrupted, 2);
    perf_probe_swipe_begin(&p, 1000, 1100, true, 3);
    perf_probe_expire(&p, 1000999);
    CHECK_EQ(p.stats.sw_timeout, 0);
    perf_probe_expire(&p, 1001000);
    perf_probe_frame(&p, 1002000, 1003000, 0, 3);
    CHECK_EQ(p.stats.sw_timeout, 1);
    CHECK_EQ(p.stats.sw_ok, 0);
    CHECK_EQ(p.stats.sw_last_us, 0);
    for (int i = 0; i < 21; i++) CHECK_EQ(p.stats.sw_hist[i], 0);
    perf_probe_swipe_begin(&p, 0, 1000000, true, 3); /* queued for a second: must expire before any UI callback */
    CHECK(!p.pending);
    CHECK_EQ(p.stats.sw_timeout, 2);
    perf_probe_swipe_begin(&p, 2000000, 2000100, true, 3);
    perf_probe_transfer_failed(&p);
    CHECK_EQ(p.stats.frames_failed, 1);
    CHECK_EQ(p.stats.sw_transfer_failed, 1);
    CHECK_EQ(p.stats.sw_ok, 0);
}

static void test_wrap_and_histogram_overflow(void)
{
    perf_probe_t p;
    perf_probe_init(&p);
    perf_probe_swipe_begin(&p, UINT32_MAX - 9999, UINT32_MAX - 8999, true, 0);
    perf_probe_frame(&p, UINT32_MAX - 7999, 15000, 2000, 0);
    CHECK_EQ(p.stats.sw_last_us, 25000);
    CHECK_EQ(p.stats.sw_hist[5], 1);
    CHECK_EQ(p.stats.worst_us, 23000);
    perf_probe_swipe_begin(&p, 20000, 21000, true, 0);
    perf_probe_frame(&p, 21000, 140000, 0, 0);
    CHECK_EQ(p.stats.sw_hist[20], 1);
    CHECK_EQ(p.stats.sw_max_us, 120000);
    perf_probe_swipe_begin(&p, UINT32_MAX - 9999, UINT32_MAX - 8999, true, 0);
    perf_probe_expire(&p, 990000);
    CHECK_EQ(p.stats.sw_timeout, 1);
}

static void test_unread_windows_keep_cumulative_evidence(void)
{
    perf_probe_t p;
    perf_probe_mailbox_t m;
    perf_probe_stats_t out;
    perf_probe_init(&p);
    perf_probe_mailbox_init(&m);
    CHECK(!perf_probe_read(&m, &out));
    perf_probe_frame(&p, 0, 30000, 100, 0);
    perf_probe_publish(&m, &p, 1000, 0);
    perf_probe_frame(&p, 40000, 50000, 20, 3);
    perf_probe_publish(&m, &p, 2000, 3);
    perf_probe_publish(&m, &p, 3000, 3);
    CHECK(perf_probe_read(&m, &out));
    CHECK_EQ(out.seq, 3);
    CHECK_EQ(out.sampled_ms, 3000);
    CHECK_EQ(out.screen, 3);
    CHECK_EQ(out.frames, 2);
    CHECK_EQ(out.worst_us, 30000);
    CHECK(!perf_probe_read(&m, &out));
}

static perf_probe_mailbox_t threaded_mail;
#define PUBLISHES 100000u
static void *publish_many(void *unused)
{
    (void)unused;
    perf_probe_t p;
    perf_probe_init(&p);
    for (uint32_t i = 1; i <= PUBLISHES; i++) {
        perf_probe_frame(&p, 0, 30000, 1000, i);
        perf_probe_publish(&threaded_mail, &p, i, i);
    }
    return NULL;
}

static void test_cross_thread_snapshots_never_tear(void)
{
    perf_probe_mailbox_init(&threaded_mail);
    pthread_t writer;
    CHECK_EQ(pthread_create(&writer, NULL, publish_many, NULL), 0);
    uint32_t seen = 0;
    while (seen != PUBLISHES) {
        perf_probe_stats_t out;
        if (!perf_probe_read(&threaded_mail, &out)) continue;
        CHECK(out.seq > seen);
        CHECK_EQ(out.seq, out.sampled_ms);
        CHECK_EQ(out.seq, out.screen);
        CHECK_EQ(out.seq, out.frames);
        CHECK_EQ(out.seq, out.n17);
        CHECK_EQ(out.seq, out.n25);
        CHECK_EQ(out.worst_us, 30000);
        CHECK_EQ(out.worst_te_us, 1000);
        seen = out.seq;
    }
    CHECK_EQ(pthread_join(writer, NULL), 0);
}

int main(void)
{
    test_latency_matches_a_completed_frame();
    test_failures_are_not_latency_samples();
    test_wrap_and_histogram_overflow();
    test_unread_windows_keep_cumulative_evidence();
    test_cross_thread_snapshots_never_tear();
    return g_failed ? 1 : 0;
}
