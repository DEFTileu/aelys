#include "combo.h"
#include "check.h"

static void test_fires_after_2000ms(void)
{
    combo_t c; combo_reset(&c);
    CHECK_EQ(combo_update(&c, true, true, 0), 0);
    int p = combo_update(&c, true, true, 1990);
    CHECK(p >= 0 && p < 100);
    CHECK_EQ(combo_update(&c, true, true, 2000), 100);
    CHECK_EQ(combo_update(&c, true, true, 2100), -1);
}

static void test_release_one_cancels(void)
{
    combo_t c; combo_reset(&c);
    for (uint32_t t = 0; t < 1500; t += 20) CHECK(combo_update(&c, true, true, t) < 100);
    CHECK_EQ(combo_update(&c, false, true, 1500), -1);
    int fired_at = -1;
    for (uint32_t t = 1600; t <= 4000; t += 20)
        if (combo_update(&c, true, true, t) == 100) { fired_at = (int)t; break; }
    CHECK_EQ(fired_at, 3600);
}

static void test_single_button_never_fires(void)
{
    combo_t c; combo_reset(&c);
    for (uint32_t t = 0; t <= 10000; t += 20) CHECK(combo_update(&c, false, true, t) < 100);
}

static void test_refire_needs_release(void)
{
    combo_t c; combo_reset(&c);
    int fires = 0;
    for (uint32_t t = 0; t <= 5000; t += 20) if (combo_update(&c, true, true, t) == 100) fires++;
    CHECK_EQ(fires, 1);
    CHECK_EQ(combo_update(&c, false, false, 5020), -1);
    CHECK_EQ(combo_update(&c, true, true, 6000), 0);
    CHECK_EQ(combo_update(&c, true, true, 8000), 100);
}

int main(void)
{
    test_fires_after_2000ms();
    test_release_one_cancels();
    test_single_button_never_fires();
    test_refire_needs_release();
    return g_failed ? 1 : 0;
}
