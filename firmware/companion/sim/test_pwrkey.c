#include "pwrkey.h"
#include "check.h"

static void test_press_release(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(!pwrkey_update(&k, false, false, 0));
    CHECK(pwrkey_update(&k, true, false, 100));
    CHECK(pwrkey_update(&k, false, false, 3000));
    CHECK(!pwrkey_update(&k, false, true, 3100));
}

static void test_both_edges_is_a_tap(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(!pwrkey_update(&k, true, true, 100)); /* from released */
    CHECK(pwrkey_update(&k, true, false, 200));
    CHECK(!pwrkey_update(&k, true, true, 300)); /* from pressed */
}

static void test_stale_down_expires(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(pwrkey_update(&k, true, false, 1000));
    CHECK(pwrkey_update(&k, false, false, 1000 + PWRKEY_STALE_MS)); /* exactly at the limit: still down */
    CHECK(!pwrkey_update(&k, false, false, 1000 + PWRKEY_STALE_MS + 1));
    CHECK(!pwrkey_update(&k, false, false, 60000));
}

static void test_new_press_restarts_timer(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    pwrkey_update(&k, true, false, 0);
    CHECK(pwrkey_update(&k, true, false, 9000)); /* a second press edge: the first release was lost */
    CHECK(pwrkey_update(&k, false, false, 9000 + PWRKEY_STALE_MS));
    CHECK(!pwrkey_update(&k, false, false, 9000 + PWRKEY_STALE_MS + 1));
}

static void test_wraparound(void)
{
    pwrkey_t k; pwrkey_reset(&k);
    CHECK(pwrkey_update(&k, true, false, 0xFFFFFF00u));
    CHECK(pwrkey_update(&k, false, false, 0x00000100u)); /* 512 ms later across the 32-bit wrap */
    CHECK(!pwrkey_update(&k, false, false, 0xFFFFFF00u + PWRKEY_STALE_MS + 1));
}

int main(void)
{
    test_press_release();
    test_both_edges_is_a_tap();
    test_stale_down_expires();
    test_new_press_restarts_timer();
    test_wraparound();
    return g_failed ? 1 : 0;
}
