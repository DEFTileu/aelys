#include "check.h"
#include "link_fsm.h"

static const int CODES[] = { 0, 1000, 1006, 1011, 4000, 4401, 4403 };
#define NCODES ((int)(sizeof CODES / sizeof CODES[0]))

static link_action_t step(link_fsm_t *f, link_event_t ev, int code, uint32_t *w)
{
    uint32_t dummy;
    return link_next(f, ev, code, 500, w ? w : &dummy);
}

/* drive to LS_ONLINE from a paired boot */
static void go_online(link_fsm_t *f)
{
    link_fsm_init(f, true);
    step(f, LE_NET_UP, 0, NULL); step(f, LE_LOGIN_OK, 0, NULL); step(f, LE_WS_OPEN, 0, NULL);
}

static void test_paired_boot_waits_for_net_then_logs_in(void)
{
    link_fsm_t f; link_fsm_init(&f, true);
    CHECK_EQ(f.st, LS_WAIT_NET);
    CHECK_EQ(step(&f, LE_NET_UP, 0, NULL), LA_LOGIN);
    CHECK_EQ(f.st, LS_LOGIN);
    CHECK_EQ(step(&f, LE_LOGIN_OK, 0, NULL), LA_CONNECT);
    CHECK_EQ(f.st, LS_CONNECT);
    CHECK_EQ(step(&f, LE_WS_OPEN, 0, NULL), LA_NONE);
    CHECK_EQ(f.st, LS_ONLINE);
    link_fsm_init(&f, false);
    CHECK_EQ(f.st, LS_UNPAIRED);
    CHECK_EQ(step(&f, LE_NET_UP, 0, NULL), LA_NONE);
    CHECK_EQ(f.st, LS_UNPAIRED);
    CHECK_EQ(step(&f, LE_PAIRED, 0, NULL), LA_LOGIN);
    CHECK_EQ(f.st, LS_LOGIN);
}

static void test_4401_relogins_without_check(void)
{
    link_fsm_t f; go_online(&f);
    CHECK_EQ(step(&f, LE_WS_CLOSED, 4401, NULL), LA_LOGIN);
    CHECK_EQ(f.st, LS_LOGIN);
}

static void test_4403_checks_then_relogins_when_known(void)
{
    link_fsm_t f; go_online(&f);
    step(&f, LE_WS_STABLE, 0, NULL); /* an accepted socket: its 4403 is not counted as a rejection */
    CHECK_EQ(step(&f, LE_WS_CLOSED, 4403, NULL), LA_CHECK);
    CHECK_EQ(f.st, LS_CHECK);
    CHECK_EQ(step(&f, LE_CHALLENGE_OK, 0, NULL), LA_LOGIN);
    CHECK_EQ(f.st, LS_LOGIN);
    /* a login rejection also goes through the challenge */
    CHECK_EQ(step(&f, LE_LOGIN_REJECTED, 0, NULL), LA_CHECK);
    CHECK_EQ(step(&f, LE_CHALLENGE_OK, 0, NULL), LA_LOGIN);
    CHECK_EQ(step(&f, LE_LOGIN_REJECTED, 0, NULL), LA_CHECK);
    CHECK_EQ(step(&f, LE_CHALLENGE_OK, 0, NULL), LA_LOGIN);
    /* 3rd consecutive rejection backs off instead of looping */
    uint32_t w = 0;
    CHECK_EQ(step(&f, LE_LOGIN_REJECTED, 0, &w), LA_NONE);
    CHECK_EQ(f.st, LS_BACKOFF);
    CHECK(w > 0);
    /* the next backoff window re-checks again: a revoked board must still learn it */
    CHECK_EQ(step(&f, LE_TIMER, 0, NULL), LA_LOGIN);
    CHECK_EQ(step(&f, LE_LOGIN_REJECTED, 0, NULL), LA_CHECK);
    CHECK_EQ(f.st, LS_CHECK);
    CHECK_EQ(step(&f, LE_CHALLENGE_UNKNOWN, 0, NULL), LA_WIPE_PAIRING);
    /* a socket refused before opening cannot spin either */
    link_fsm_init(&f, true);
    step(&f, LE_NET_UP, 0, NULL);
    for (int i = 0; i < 2; i++) { step(&f, LE_LOGIN_OK, 0, NULL); step(&f, LE_WS_CLOSED, 4401, NULL); }
    step(&f, LE_LOGIN_OK, 0, NULL);
    CHECK_EQ(step(&f, LE_WS_CLOSED, 4401, &w), LA_NONE);
    CHECK_EQ(f.st, LS_BACKOFF);
}

static void test_only_challenge_401_wipes(void)
{
    for (int st = LS_UNPAIRED; st <= LS_REPLACED; st++)
        for (int ev = LE_PAIRED; ev <= LE_WS_STABLE; ev++)
            for (int c = 0; c < NCODES; c++) {
                link_fsm_t f = { (link_state_t)st, 4000, 2, false };
                uint32_t w;
                link_action_t a = link_next(&f, (link_event_t)ev, CODES[c], 12345, &w);
                if (ev == LE_UNPAIR) {
                    CHECK_EQ(a, LA_WIPE_PAIRING); CHECK_EQ(f.st, LS_UNPAIRED);
                } else if (ev == LE_CHALLENGE_UNKNOWN && st == LS_CHECK) {
                    CHECK_EQ(a, LA_WIPE_PAIRING); CHECK_EQ(f.st, LS_UNPAIRED);
                } else {
                    CHECK(a != LA_WIPE_PAIRING);
                    CHECK(f.st != LS_UNPAIRED || st == LS_UNPAIRED);
                }
            }
    /* ten rejections in a row, plus every other failure, never wipe */
    link_fsm_t f; link_fsm_init(&f, true);
    step(&f, LE_NET_UP, 0, NULL);
    for (int i = 0; i < 10; i++) {
        CHECK(step(&f, LE_LOGIN_REJECTED, 0, NULL) != LA_WIPE_PAIRING);
        if (f.st == LS_CHECK) step(&f, LE_CHALLENGE_FAIL, 0, NULL);
        if (f.st == LS_BACKOFF) step(&f, LE_TIMER, 0, NULL);
    }
    CHECK(f.st != LS_UNPAIRED);
}

static void test_backoff_doubles_caps_and_jitters(void)
{
    static const uint32_t base[] = { 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000 };
    static const uint32_t rnds[] = { 0, 400, 200, 1 };   /* 80 %, 120 %, 100 %, 80.1 % */
    for (unsigned r = 0; r < sizeof rnds / sizeof rnds[0]; r++) {
        link_fsm_t f; link_fsm_init(&f, true);
        step(&f, LE_NET_UP, 0, NULL);
        for (unsigned i = 0; i < sizeof base / sizeof base[0]; i++) {
            uint32_t w = 0;
            CHECK_EQ(link_next(&f, LE_LOGIN_FAIL, 0, rnds[r], &w), LA_NONE);
            CHECK_EQ(f.st, LS_BACKOFF);
            CHECK_EQ(f.backoff_ms, base[i]);
            CHECK(w >= base[i] * 8 / 10 && w <= base[i] * 12 / 10);
            CHECK_EQ(w, base[i] * (800 + rnds[r] % 401) / 1000);
            CHECK_EQ(step(&f, LE_TIMER, 0, NULL), LA_LOGIN);
        }
    }
    /* wide random sweep stays in bounds */
    for (uint32_t rnd = 0; rnd < 5000; rnd++) {
        link_fsm_t f = { LS_LOGIN, 60000, 0, false }; uint32_t w;
        link_next(&f, LE_LOGIN_FAIL, 0, rnd * 2654435761u, &w);
        CHECK(w >= 48000 && w <= 72000);
    }
}

static void test_only_a_stable_socket_resets_backoff(void)
{
    link_fsm_t f; link_fsm_init(&f, true);
    step(&f, LE_NET_UP, 0, NULL);
    step(&f, LE_LOGIN_FAIL, 0, NULL); step(&f, LE_TIMER, 0, NULL);
    step(&f, LE_LOGIN_FAIL, 0, NULL); step(&f, LE_TIMER, 0, NULL);
    CHECK_EQ(f.backoff_ms, 2000);
    step(&f, LE_LOGIN_OK, 0, NULL); step(&f, LE_WS_OPEN, 0, NULL);
    CHECK_EQ(f.backoff_ms, 2000);                 /* `ready` alone proves nothing: a server can ready-then-close in a loop */
    uint32_t w = 0;
    CHECK_EQ(step(&f, LE_WS_CLOSED, 1006, &w), LA_NONE);
    CHECK_EQ(f.st, LS_BACKOFF);
    CHECK_EQ(f.backoff_ms, 4000);                 /* it keeps doubling */
    CHECK(w >= 3200 && w <= 4800);
    step(&f, LE_TIMER, 0, NULL); step(&f, LE_LOGIN_OK, 0, NULL); step(&f, LE_WS_OPEN, 0, NULL);
    CHECK_EQ(step(&f, LE_WS_STABLE, 0, NULL), LA_NONE);
    CHECK_EQ(f.st, LS_ONLINE);
    CHECK_EQ(f.backoff_ms, 0);
    CHECK_EQ(step(&f, LE_WS_CLOSED, 1006, &w), LA_NONE);
    CHECK_EQ(f.backoff_ms, 1000);                 /* a long-lived socket that drops starts from the bottom */
    CHECK(w >= 800 && w <= 1200);
    /* a close with no code backs off too */
    go_online(&f);
    step(&f, LE_WS_CLOSED, 0, NULL);
    CHECK_EQ(f.st, LS_BACKOFF);
    /* a stale stable tick outside LS_ONLINE changes nothing */
    link_fsm_t g = { LS_BACKOFF, 8000, 1, false };
    CHECK_EQ(step(&g, LE_WS_STABLE, 0, NULL), LA_NONE);
    CHECK_EQ(g.backoff_ms, 8000);
}

/* connect + ready + immediate close with the code; the caller answers a CHECK with a known device */
static link_action_t early_close(link_fsm_t *f, int code, uint32_t *w)
{
    step(f, LE_LOGIN_OK, 0, NULL);
    step(f, LE_WS_OPEN, 0, NULL);
    link_action_t a = step(f, LE_WS_CLOSED, code, w);
    if (a == LA_CHECK) step(f, LE_CHALLENGE_OK, 0, NULL);
    return a;
}

/* A server that sends `ready` and then closes 4401/4403 at once must not loop at login RTT. */
static void test_early_4401_after_ready_counts_as_a_rejection(void)
{
    static const int codes[] = { 4401, 4403 };
    for (int k = 0; k < 2; k++) {
        link_action_t retry = codes[k] == 4401 ? LA_LOGIN : LA_CHECK;
        link_fsm_t f; link_fsm_init(&f, true);
        uint32_t w = 0;
        step(&f, LE_NET_UP, 0, NULL);
        CHECK_EQ(early_close(&f, codes[k], &w), retry);              /* 1st: retry at once */
        CHECK_EQ(early_close(&f, codes[k], &w), retry);              /* 2nd: retry at once */
        CHECK_EQ(early_close(&f, codes[k], &w), LA_NONE);            /* 3rd: backoff */
        CHECK_EQ(f.st, LS_BACKOFF);
        CHECK(w > 0);
        CHECK_EQ(f.backoff_ms, 1000);
        step(&f, LE_TIMER, 0, NULL);                                 /* the next window backs off longer */
        early_close(&f, codes[k], &w); early_close(&f, codes[k], &w);
        CHECK_EQ(early_close(&f, codes[k], &w), LA_NONE);
        CHECK_EQ(f.backoff_ms, 2000);
    }
    /* once the socket was stable, a 4401 (the normal token expiry) is a plain re-login, not a rejection */
    link_fsm_t f; go_online(&f);
    step(&f, LE_WS_STABLE, 0, NULL);
    for (int i = 0; i < 10; i++) {
        CHECK_EQ(step(&f, LE_WS_CLOSED, 4401, NULL), LA_LOGIN);
        CHECK_EQ(f.st, LS_LOGIN);
        step(&f, LE_LOGIN_OK, 0, NULL); step(&f, LE_WS_OPEN, 0, NULL); step(&f, LE_WS_STABLE, 0, NULL);
    }
    /* 4401 after a stable socket, then an early one, then early again: the stable one does not count */
    go_online(&f); step(&f, LE_WS_STABLE, 0, NULL);
    step(&f, LE_WS_CLOSED, 4401, NULL); step(&f, LE_LOGIN_OK, 0, NULL); step(&f, LE_WS_OPEN, 0, NULL);
    CHECK_EQ(f.login_rejects, 0);
    CHECK_EQ(step(&f, LE_WS_CLOSED, 4401, NULL), LA_LOGIN);
    CHECK_EQ(f.login_rejects, 1);
}

static void test_4000_stays_replaced_until_net_cycles(void)
{
    link_fsm_t f; go_online(&f);
    uint32_t w = 9;
    CHECK_EQ(step(&f, LE_WS_CLOSED, 4000, &w), LA_NONE);
    CHECK_EQ(f.st, LS_REPLACED);
    CHECK_EQ(w, 0);
    link_event_t noisy[] = { LE_TIMER, LE_NET_UP, LE_LOGIN_OK, LE_WS_OPEN, LE_WS_CLOSED, LE_LOGIN_FAIL };
    for (unsigned i = 0; i < sizeof noisy / sizeof noisy[0]; i++) {
        CHECK_EQ(step(&f, noisy[i], 1006, NULL), LA_NONE);
        CHECK_EQ(f.st, LS_REPLACED);
    }
    CHECK_EQ(step(&f, LE_NET_DOWN, 0, NULL), LA_NONE);
    CHECK_EQ(f.st, LS_WAIT_NET);
    CHECK_EQ(step(&f, LE_NET_UP, 0, NULL), LA_LOGIN);
    CHECK_EQ(f.st, LS_LOGIN);
    /* reboot: init resets it */
    go_online(&f); step(&f, LE_WS_CLOSED, 4000, NULL);
    link_fsm_init(&f, true);
    CHECK_EQ(f.st, LS_WAIT_NET);
}

static void test_net_down_from_any_state_waits(void)
{
    for (int st = LS_WAIT_NET; st <= LS_REPLACED; st++) {
        link_fsm_t f = { (link_state_t)st, 8000, 1, false }; uint32_t w = 5;
        link_action_t a = link_next(&f, LE_NET_DOWN, 0, 1, &w);
        CHECK_EQ(f.st, LS_WAIT_NET);
        CHECK_EQ(w, 0);
        CHECK_EQ(a, (st == LS_CONNECT || st == LS_ONLINE) ? LA_CLOSE : LA_NONE);
        CHECK_EQ(link_next(&f, LE_TIMER, 0, 1, &w), LA_NONE); /* a stale backoff timer is ignored */
        CHECK_EQ(f.st, LS_WAIT_NET);
    }
    link_fsm_t u = { LS_UNPAIRED, 0, 0, false };
    CHECK_EQ(link_next(&u, LE_NET_DOWN, 0, 1, &(uint32_t){0}), LA_NONE);
    CHECK_EQ(u.st, LS_UNPAIRED);
}

static void test_paired_from_any_state_logs_in_with_the_new_identity(void)
{
    for (int st = LS_UNPAIRED; st <= LS_REPLACED; st++) {
        link_fsm_t f = { (link_state_t)st, 8000, 2, false };
        uint32_t w = 5;
        link_action_t a = link_next(&f, LE_PAIRED, 0, 1, &w);
        CHECK_EQ(a, (st == LS_CONNECT || st == LS_ONLINE) ? LA_CLOSE_LOGIN : LA_LOGIN);
        CHECK_EQ(f.st, LS_LOGIN);
        CHECK_EQ(f.backoff_ms, 0);
        CHECK_EQ(f.login_rejects, 0);
        CHECK_EQ(w, 0);
        CHECK_EQ(link_next(&f, LE_TIMER, 0, 1, &w), LA_NONE); /* a stale backoff timer is ignored */
    }
}

int main(void)
{
    test_paired_boot_waits_for_net_then_logs_in();
    test_4401_relogins_without_check();
    test_4403_checks_then_relogins_when_known();
    test_only_challenge_401_wipes();
    test_backoff_doubles_caps_and_jitters();
    test_only_a_stable_socket_resets_backoff();
    test_early_4401_after_ready_counts_as_a_rejection();
    test_4000_stays_replaced_until_net_cycles();
    test_net_down_from_any_state_waits();
    test_paired_from_any_state_logs_in_with_the_new_identity();
    return g_failed ? 1 : 0;
}
