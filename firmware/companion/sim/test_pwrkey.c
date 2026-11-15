#include "pwrkey.h"
#include "check.h"

static void test_press_release(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(!pwrkey_update(&k, false, false, 0, PWRKEY_STALE_MS));
    CHECK(pwrkey_update(&k, true, false, 100, PWRKEY_STALE_MS));
    CHECK(pwrkey_update(&k, false, false, 3000, PWRKEY_STALE_MS));
    CHECK(!pwrkey_update(&k, false, true, 3100, PWRKEY_STALE_MS));
}

static void test_both_edges_is_a_tap(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(!pwrkey_update(&k, true, true, 100, PWRKEY_STALE_MS)); /* from released */
    CHECK(pwrkey_update(&k, true, false, 200, PWRKEY_STALE_MS));
    CHECK(!pwrkey_update(&k, true, true, 300, PWRKEY_STALE_MS)); /* from pressed */
}

static void test_stale_down_expires(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(pwrkey_update(&k, true, false, 1000, PWRKEY_STALE_MS));
    CHECK(pwrkey_update(&k, false, false, 1000 + PWRKEY_STALE_MS, PWRKEY_STALE_MS)); /* exactly at the limit: still down */
    CHECK(!pwrkey_update(&k, false, false, 1000 + PWRKEY_STALE_MS + 1, PWRKEY_STALE_MS));
    CHECK(!pwrkey_update(&k, false, false, 60000, PWRKEY_STALE_MS));
}

static void test_new_press_restarts_timer(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    pwrkey_update(&k, true, false, 0, PWRKEY_STALE_MS);
    CHECK(pwrkey_update(&k, true, false, 9000, PWRKEY_STALE_MS)); /* a second press edge: the first release was lost */
    CHECK(pwrkey_update(&k, false, false, 9000 + PWRKEY_STALE_MS, PWRKEY_STALE_MS));
    CHECK(!pwrkey_update(&k, false, false, 9000 + PWRKEY_STALE_MS + 1, PWRKEY_STALE_MS));
}

static void test_wraparound(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(pwrkey_update(&k, true, false, 0xFFFFFF00u, PWRKEY_STALE_MS));
    CHECK(pwrkey_update(&k, false, false, 0x00000100u, PWRKEY_STALE_MS)); /* 512 ms later across the 32-bit wrap */
    CHECK(!pwrkey_update(&k, false, false, 0xFFFFFF00u + PWRKEY_STALE_MS + 1, PWRKEY_STALE_MS));
}

static void test_extended_stale(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(pwrkey_update(&k, true, false, 0, PWRKEY_STALE_TALK_MS));
    CHECK(pwrkey_update(&k, false, false, 11000, PWRKEY_STALE_TALK_MS));
    CHECK(!pwrkey_update(&k, false, false, 31001, PWRKEY_STALE_TALK_MS));
}

int main(void)
{
    test_extended_stale();
    test_press_release();
    test_both_edges_is_a_tap();
    test_stale_down_expires();
    test_new_press_restarts_timer();
    test_wraparound();
    return g_failed ? 1 : 0;
}
