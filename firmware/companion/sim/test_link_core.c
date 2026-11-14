#include <string.h>
#include "check.h"
#include "link_core.h"

static const char *ID[] = { "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002",
                            "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004",
                            "00000000-0000-4000-8000-000000000005" };

static void test_table_holds_four_and_answers_by_id(void)
{
    link_acts_t t; link_acts_init(&t);
    CHECK(link_acts_next_unsent(&t) == NULL);
    for (int i = 0; i < 4; i++) CHECK(link_acts_add(&t, ID[i], ACT_NOTIFICATION_READ, "n-1", 100));
    CHECK(!link_acts_add(&t, ID[4], ACT_FOCUS_STOP, "", 100));          /* the 5th is refused */
    act_kind_t k = ACT_TASK_COMPLETE;
    CHECK(!link_acts_done(&t, ID[4], &k) && k == ACT_TASK_COMPLETE);    /* unknown id: untouched */
    CHECK(link_acts_done(&t, ID[1], &k) && k == ACT_NOTIFICATION_READ);
    CHECK(!link_acts_done(&t, ID[1], &k));                              /* answered once */
    CHECK_EQ(t.n, 3);
    CHECK(link_acts_add(&t, ID[4], ACT_FOCUS_STOP, "", 100));           /* a slot is free again */
    CHECK_EQ(t.n, 4);
}

static void test_send_order_is_fifo_and_marks_sent(void)
{
    link_acts_t t; link_acts_init(&t);
    link_acts_add(&t, ID[0], ACT_FOCUS_START, "", 0);
    link_acts_add(&t, ID[1], ACT_FOCUS_PAUSE, "", 5);
    link_acts_add(&t, ID[2], ACT_TASK_COMPLETE, "t-9", 6);
    const link_act_t *a = link_acts_next_unsent(&t);
    CHECK(a && strcmp(a->id, ID[0]) == 0 && a->kind == ACT_FOCUS_START);
    link_acts_sent(&t, ID[0], 10);
    a = link_acts_next_unsent(&t);
    CHECK(a && strcmp(a->id, ID[1]) == 0);
    link_acts_sent(&t, ID[1], 11);
    a = link_acts_next_unsent(&t);
    CHECK(a && strcmp(a->id, ID[2]) == 0 && strcmp(a->target, "t-9") == 0);
    link_acts_sent(&t, ID[2], 12);
    CHECK(link_acts_next_unsent(&t) == NULL);
}

static void test_timeout_counts_from_the_last_send(void)
{
    link_acts_t t; link_acts_init(&t);
    link_act_t out[LINK_ACT_MAX];
    link_acts_add(&t, ID[0], ACT_FOCUS_START, "", 1000);
    link_acts_sent(&t, ID[0], 1500);
    CHECK_EQ(link_acts_expire(&t, 11499, out), 0);                      /* 9999 ms after the send */
    CHECK_EQ(link_acts_expire(&t, 11500, out), 1);                      /* 10000 ms */
    CHECK(strcmp(out[0].id, ID[0]) == 0 && out[0].sent && out[0].kind == ACT_FOCUS_START);
    CHECK_EQ(t.n, 0);
    CHECK_EQ(link_acts_expire(&t, 99999, out), 0);
}

static void test_expire_is_oldest_first_and_keeps_the_young(void)
{
    link_acts_t t; link_acts_init(&t);
    link_act_t out[LINK_ACT_MAX];
    link_acts_add(&t, ID[0], ACT_FOCUS_START, "", 0);
    link_acts_add(&t, ID[1], ACT_FOCUS_PAUSE, "", 4000);
    link_acts_add(&t, ID[2], ACT_FOCUS_STOP, "", 12000);
    CHECK_EQ(link_acts_expire(&t, 14000, out), 2);
    CHECK(strcmp(out[0].id, ID[0]) == 0 && strcmp(out[1].id, ID[1]) == 0 && !out[0].sent);
    CHECK_EQ(t.n, 1);
    CHECK(strcmp(t.a[0].id, ID[2]) == 0);
}

static void test_clock_wrap(void)
{
    link_acts_t t; link_acts_init(&t);
    link_act_t out[LINK_ACT_MAX];
    link_acts_add(&t, ID[0], ACT_FOCUS_START, "", 0xFFFFFF00u);          /* added just before the 32-bit ms counter wraps */
    CHECK_EQ(link_acts_expire(&t, 5000, out), 0);
    CHECK_EQ(link_acts_expire(&t, 0xFFFFFF00u + 10000u, out), 1);
}

static void test_reconnect_resends_the_same_id_and_restarts_the_timeout(void)
{
    link_acts_t t; link_acts_init(&t);
    link_act_t out[LINK_ACT_MAX];
    link_acts_add(&t, ID[0], ACT_TASK_COMPLETE, "t-1", 0);
    link_acts_add(&t, ID[1], ACT_FOCUS_STOP, "", 0);
    link_acts_sent(&t, ID[0], 1);
    link_acts_sent(&t, ID[1], 2);
    CHECK(link_acts_next_unsent(&t) == NULL);
    link_acts_unsend_all(&t, 8000);                                     /* socket dropped */
    const link_act_t *a = link_acts_next_unsent(&t);
    CHECK(a && strcmp(a->id, ID[0]) == 0 && strcmp(a->target, "t-1") == 0);   /* same id, same payload */
    CHECK_EQ(link_acts_expire(&t, 17999, out), 0);                      /* 10 s from the drop, not from the first send */
    link_acts_sent(&t, ID[0], 9000);
    link_acts_sent(&t, ID[1], 9000);
    CHECK_EQ(link_acts_expire(&t, 18999, out), 0);
    CHECK_EQ(link_acts_expire(&t, 19000, out), 2);
    /* never reconnected: un-sent actions fail 10 s after the drop and say they were never sent */
    link_acts_add(&t, ID[2], ACT_FOCUS_STOP, "", 0);
    link_acts_sent(&t, ID[2], 0);
    link_acts_unsend_all(&t, 100);
    CHECK_EQ(link_acts_expire(&t, 10100, out), 1);
    CHECK(!out[0].sent);
}

static void test_does_not_fit_is_refused(void)
{
    link_acts_t t; link_acts_init(&t);
    char longid[64]; memset(longid, 'a', sizeof longid - 1); longid[63] = 0;
    CHECK(!link_acts_add(&t, longid, ACT_FOCUS_START, "", 0));
    char longt[64]; memset(longt, 'b', sizeof longt - 1); longt[63] = 0;
    CHECK(!link_acts_add(&t, ID[0], ACT_TASK_COMPLETE, longt, 0));
    CHECK_EQ(t.n, 0);
    CHECK(link_acts_add(&t, ID[0], ACT_FOCUS_START, NULL, 0));          /* NULL target = "" */
}

static void test_http_verdict_reads_401_bodies(void)
{
    const char *unk = "{\"detail\":{\"code\":\"UNAUTHORIZED\",\"message\":\"Unknown or revoked device\"}}";
    const char *other = "{\"detail\":{\"code\":\"RATE_LIMITED\",\"message\":\"x\"}}";
    CHECK_EQ(link_http_verdict(200, "{}", 2), LH_OK);
    CHECK_EQ(link_http_verdict(401, unk, strlen(unk)), LH_UNAUTHORIZED);     /* the only verdict that may wipe */
    CHECK_EQ(link_http_verdict(401, other, strlen(other)), LH_DENIED);
    CHECK_EQ(link_http_verdict(401, "", 0), LH_DENIED);                      /* no body: never "unknown device" */
    CHECK_EQ(link_http_verdict(401, "<html>", 6), LH_DENIED);
    CHECK_EQ(link_http_verdict(403, unk, strlen(unk)), LH_DENIED);           /* a 403 never says "unknown" */
    CHECK_EQ(link_http_verdict(429, unk, strlen(unk)), LH_FAIL);
    CHECK_EQ(link_http_verdict(500, unk, strlen(unk)), LH_FAIL);
    CHECK_EQ(link_http_verdict(502, "", 0), LH_FAIL);
    CHECK_EQ(link_http_verdict(0, "", 0), LH_FAIL);
}

static void test_snapshot_save_throttle(void)
{
    CHECK(!link_snap_save_due(false, false, true, 999999));                  /* nothing new */
    CHECK(!link_snap_save_due(false, true, true, 999999));
    CHECK(link_snap_save_due(true, false, true, 0));                         /* first one */
    CHECK(!link_snap_save_due(true, false, false, 299999));
    CHECK(link_snap_save_due(true, false, false, 300000));
    CHECK(link_snap_save_due(true, true, false, 0));                         /* lost mode: flash never keeps the older data */
}

static void test_identity_transition_discards_old_actions(void)
{
    link_acts_t t; link_acts_init(&t);
    CHECK(link_acts_add(&t, ID[0], ACT_TASK_COMPLETE, "old-task", 0));
    link_acts_sent(&t, ID[0], 1);
    CHECK(link_acts_add(&t, ID[1], ACT_NOTIFICATION_READ, "old-notice", 2));
    link_acts_discard_all(&t);
    CHECK_EQ(t.n, 0); CHECK(link_acts_next_unsent(&t) == NULL);
    act_kind_t kind = ACT_FOCUS_STOP;
    CHECK(!link_acts_done(&t, ID[0], &kind)); CHECK_EQ(kind, ACT_FOCUS_STOP);
    CHECK(link_acts_add(&t, ID[2], ACT_TASK_COMPLETE, "new-task", 3));
    CHECK(!strcmp(link_acts_next_unsent(&t)->id, ID[2]));
}

int main(void)
{
    test_identity_transition_discards_old_actions();
    test_http_verdict_reads_401_bodies();
    test_snapshot_save_throttle();
    test_table_holds_four_and_answers_by_id();
    test_send_order_is_fifo_and_marks_sent();
    test_timeout_counts_from_the_last_send();
    test_expire_is_oldest_first_and_keeps_the_young();
    test_clock_wrap();
    test_reconnect_resends_the_same_id_and_restarts_the_timeout();
    test_does_not_fit_is_refused();
    return g_failed ? 1 : 0;
}
