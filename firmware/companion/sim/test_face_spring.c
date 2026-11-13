#include <stdint.h>
#include <stdlib.h>
#include "face_spring.h"
#include "check.h"

static void test_converges_and_does_not_jump(void)
{
    face_spring_t s; face_spring_init(&s, 40);
    face_spring_step(&s, 120, 0); CHECK_EQ(face_spring_value(&s), 40);
    int previous = 40;
    for (int n = 0; n < 200; ++n) {
        face_spring_step(&s, 120, 10);
        int current = face_spring_value(&s);
        CHECK(current >= previous && current <= 120);
        if (n == 9) CHECK(current > 40 && current < 120);
        previous = current;
    }
    CHECK_EQ(face_spring_value(&s), 120);
    CHECK_EQ(s.velocity_q16, 0);
}
static void test_retarget_and_variable_frames(void)
{
    face_spring_t a, b; face_spring_init(&a, -30); face_spring_init(&b, -30);
    for (int n = 0; n < 10; ++n) face_spring_step(&a, 100, 10);
    for (int n = 0; n < 5; ++n) face_spring_step(&b, 100, 20);
    CHECK_EQ(a.value_q16, b.value_q16); CHECK_EQ(a.velocity_q16, b.velocity_q16);
    face_spring_t still = {.value_q16 = 65536 - 100, .velocity_q16 = 0};
    face_spring_step(&still, 1, 0); CHECK_EQ(still.value_q16, 65536 - 100);
    int before = face_spring_value(&a);
    face_spring_step(&a, -80, 0); CHECK_EQ(face_spring_value(&a), before);
    for (int n = 0; n < 300; ++n) face_spring_step(&a, -80, 10);
    CHECK_EQ(face_spring_value(&a), -80); CHECK_EQ(a.velocity_q16, 0);
}
static void test_bounds_and_long_gap(void)
{
    face_spring_t a, b; face_spring_init(&a, 0); face_spring_init(&b, 0);
    face_spring_step(&a, 500, UINT32_MAX); face_spring_step(&b, 500, 250);
    CHECK_EQ(a.value_q16, b.value_q16); CHECK_EQ(a.velocity_q16, b.velocity_q16);
    face_spring_init(&a, INT32_MAX); CHECK_EQ(face_spring_value(&a), 4096);
    for (int n = 0; n < 100; ++n) {
        face_spring_step(&a, INT32_MIN, 1000);
        CHECK(face_spring_value(&a) >= -4096 && face_spring_value(&a) <= 4096);
    }
    CHECK_EQ(face_spring_value(&a), -4096);
}
int main(void) { test_converges_and_does_not_jump(); test_retarget_and_variable_frames(); test_bounds_and_long_gap(); return g_failed ? 1 : 0; }
