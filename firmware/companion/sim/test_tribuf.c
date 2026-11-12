#include <pthread.h>
#include <stdint.h>
#include <string.h>
#include "check.h"
#include "tribuf.h"

static void test_reader_sees_latest_publish(void)
{
    uint8_t s0 = 0, s1 = 0, s2 = 0;
    tribuf_t t;
    tribuf_init(&t, &s0, &s1, &s2);
    bool fresh;
    for (uint8_t v = 1; v <= 5; v++) {
        *(uint8_t *)tribuf_back(&t) = v;
        tribuf_publish(&t);
    }
    /* several publishes before one read: the reader gets only the newest */
    const uint8_t *p = tribuf_latest(&t, &fresh);
    CHECK(fresh);
    CHECK_EQ(*p, 5);
    p = tribuf_latest(&t, &fresh);
    CHECK(!fresh);
    CHECK_EQ(*p, 5);
}

static void test_no_fresh_without_publish(void)
{
    uint8_t s0 = 0, s1 = 0, s2 = 0;
    tribuf_t t;
    tribuf_init(&t, &s0, &s1, &s2);
    bool fresh = true;
    CHECK(tribuf_latest(&t, &fresh) != NULL);
    CHECK(!fresh);
    *(uint8_t *)tribuf_back(&t) = 9; /* written but not published */
    tribuf_latest(&t, &fresh);
    CHECK(!fresh);
}

#define N 1000000u
typedef struct { uint32_t v[128]; } slot_t; /* 512 bytes */
static tribuf_t g_tb;
static slot_t g_slot[3];

static void *writer(void *arg)
{
    (void)arg;
    for (uint32_t i = 1; i <= N; i++) {
        slot_t *s = tribuf_back(&g_tb);
        for (int k = 0; k < 128; k++) s->v[k] = i;
        tribuf_publish(&g_tb);
    }
    return NULL;
}

static void test_stress_two_threads(void)
{
    memset(g_slot, 0, sizeof g_slot);
    tribuf_init(&g_tb, &g_slot[0], &g_slot[1], &g_slot[2]);
    pthread_t th;
    pthread_create(&th, NULL, writer, NULL);
    uint32_t last = 0, reads = 0, torn = 0, back = 0;
    while (last != N) {
        bool fresh;
        const slot_t *s = tribuf_latest(&g_tb, &fresh);
        uint32_t first = s->v[0];
        for (int k = 1; k < 128; k++) if (s->v[k] != first) { torn++; break; }
        if (first < last) back++;
        last = first;
        reads++;
    }
    pthread_join(th, NULL);
    CHECK_EQ(torn, 0);
    CHECK_EQ(back, 0);
    CHECK(reads > 0);
}

int main(void)
{
    test_reader_sees_latest_publish();
    test_no_fresh_without_publish();
    test_stress_two_threads();
    return g_failed ? 1 : 0;
}
