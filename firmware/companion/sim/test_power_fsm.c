#include "power_fsm.h"
#include "check.h"

#define DIM 30000u
#define OFF 60000u

static void test_dims_then_off(void)
{
    power_t p; power_init(&p, DIM, OFF, 1000);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 30999), PWR_ACTIVE);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 31000), PWR_DIM);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 60999), PWR_DIM);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 61000), PWR_OFF);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 90000), PWR_OFF);
}

static void test_touch_wakes(void)
{
    power_t p; power_init(&p, DIM, OFF, 0);
    power_update(&p, PWR_IN_TICK, 40000);
    CHECK_EQ(p.state, PWR_DIM);
    CHECK_EQ(power_update(&p, PWR_IN_TOUCH, 40000), PWR_ACTIVE);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 69999), PWR_ACTIVE); /* timer restarted */
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 70000), PWR_DIM);
    power_update(&p, PWR_IN_TICK, 100000);
    CHECK_EQ(p.state, PWR_OFF);
    CHECK_EQ(power_update(&p, PWR_IN_LIFT, 100000), PWR_ACTIVE);
}

static void test_face_down_turns_off_now(void)
{
    power_t p; power_init(&p, DIM, OFF, 0);
    CHECK_EQ(power_update(&p, PWR_IN_FACE_DOWN, 100), PWR_OFF);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 200), PWR_OFF);
}

static void test_touch_ignored_face_down(void)
{
    power_t p; power_init(&p, DIM, OFF, 0);
    power_update(&p, PWR_IN_FACE_DOWN, 100);
    CHECK_EQ(power_update(&p, PWR_IN_TOUCH, 200), PWR_OFF);
    CHECK_EQ(power_update(&p, PWR_IN_HOLD, 300), PWR_OFF); /* a notification animating */
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 400), PWR_OFF);
}

static void test_button_wakes_face_down(void)
{
    power_t p; power_init(&p, DIM, OFF, 0);
    power_update(&p, PWR_IN_FACE_DOWN, 100);
    CHECK_EQ(power_update(&p, PWR_IN_BUTTON, 200), PWR_ACTIVE);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 300), PWR_ACTIVE);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 30200), PWR_DIM);  /* normal timers, still face-down */
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 60200), PWR_OFF);
    CHECK_EQ(power_update(&p, PWR_IN_TOUCH, 60300), PWR_OFF); /* table tap */
    CHECK_EQ(power_update(&p, PWR_IN_HOLD, 60400), PWR_OFF);  /* notification */
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 60500), PWR_OFF);
    CHECK_EQ(power_update(&p, PWR_IN_BUTTON, 60600), PWR_ACTIVE);
    CHECK_EQ(power_update(&p, PWR_IN_TOUCH, 60700), PWR_ACTIVE); /* touch is ignored but screen stays lit */
    power_update(&p, PWR_IN_TICK, 120600);
    CHECK_EQ(p.state, PWR_OFF);
}

static void test_face_up_and_lift_end_face_down(void)
{
    power_t p; power_init(&p, DIM, OFF, 0);
    power_update(&p, PWR_IN_FACE_DOWN, 100);
    CHECK_EQ(power_update(&p, PWR_IN_FACE_UP, 200), PWR_ACTIVE);
    CHECK_EQ(power_update(&p, PWR_IN_TOUCH, 300), PWR_ACTIVE);
    power_update(&p, PWR_IN_FACE_DOWN, 400);
    CHECK_EQ(power_update(&p, PWR_IN_LIFT, 500), PWR_ACTIVE);
    CHECK(!p.face_down);
}

static void test_hold_keeps_active(void)
{
    power_t p; power_init(&p, DIM, OFF, 0);
    for (uint32_t t = 0; t <= 200000; t += 1000) {
        power_update(&p, PWR_IN_HOLD, t);
        CHECK_EQ(power_update(&p, PWR_IN_TICK, t), PWR_ACTIVE);
    }
}

static void test_wraps_uint32(void)
{
    power_t p; power_init(&p, DIM, OFF, 0xFFFFFFFFu - 5000u);
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 20000), PWR_ACTIVE); /* 25 s */
    CHECK_EQ(power_update(&p, PWR_IN_TICK, 25000), PWR_DIM);    /* 30 s across the wrap */
}

int main(void)
{
    test_dims_then_off();
    test_touch_wakes();
    test_face_down_turns_off_now();
    test_touch_ignored_face_down();
    test_button_wakes_face_down();
    test_face_up_and_lift_end_face_down();
    test_hold_keeps_active();
    test_wraps_uint32();
    return g_failed ? 1 : 0;
}
