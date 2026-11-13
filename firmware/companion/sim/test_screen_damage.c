#define _POSIX_C_SOURCE 200809L
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "check.h"
#include "sim_display.h"
#include "snap_fixture.h"
#include "ui_screens_priv.h"

static uint16_t partial[SIM_W * SIM_H];
static uint32_t most_pixels, least_pixels = UINT32_MAX;
static void exact_frame(void)
{
    /* Timer callbacks can change styles after the refresh timer ran. Drain only
     * queued dirty areas at this frozen clock before comparing with a full draw. */
    lv_refr_now(NULL);
    memcpy(partial, sim_fb(), sizeof partial);
    lv_obj_invalidate(lv_screen_active());
    lv_refr_now(NULL); /* frozen animation clock, full reference rendered through the same strip path */
    unsigned diff = 0;
    for (unsigned i = 0; i < SIM_W * SIM_H; i++) diff += partial[i] != sim_fb()[i];
    CHECK_EQ(diff, 0);
}

static void swipe(uint8_t type)
{
    sim_post(UI_EV_TOUCH, NULL, 0);
    sim_post(type, NULL, 0);
    sim_post(UI_EV_RELEASE, NULL, 0);
}

static void switch_and_check(uint8_t type)
{
    uint32_t before = sim_flush_pixels();
    swipe(type);
    sim_step(20);
    uint32_t pixels = sim_flush_pixels() - before;
    CHECK(pixels > 0);
    if (pixels > most_pixels) most_pixels = pixels;
    if (pixels < least_pixels) least_pixels = pixels;
    /* The 130% face has larger dirty rectangles than the previous 100% face.
     * This is a host traffic regression guard, not a board timing budget:
     * require at least 1/8 less traffic than a full-screen transfer. */
    if (pixels >= SIM_W * SIM_H * 7u / 8u) fprintf(stderr, "screen change sent %u pixels\n", pixels);
    CHECK(pixels < SIM_W * SIM_H * 7u / 8u);
    exact_frame();
}

int main(void)
{
    setenv("TZ", "UTC", 1);
    tzset();
    sim_init();
    ui_setup();
    ui_set_clock(fx_clock);
    uint8_t online = LINK_UI_ONLINE, hm[] = {14, 32};
    sim_post(UI_EV_LINK, &online, 1);
    sim_post(UI_EV_TIME, hm, 2);
    snap_t snap;
    fx_snap(&snap);
    fx_post(&snap, 1);
    sim_partial();
    CHECK_EQ(lv_display_get_render_mode(lv_display_get_default()), LV_DISPLAY_RENDER_MODE_PARTIAL);
    exact_frame();
    for (int i = 0; i < 8; i++) {
        switch_and_check(UI_EV_SWIPE_RIGHT);
        CHECK_EQ(ui_current_screen(), SCR_TODAY);
        switch_and_check(UI_EV_SWIPE_LEFT);
        CHECK_EQ(ui_current_screen(), SCR_HOME);
        snap.today_done = i;
        snap.task.due = FX_NOW + (i % 2 ? 1800 : 7200);
        fx_post(&snap, 1);
        sim_step(20);
        exact_frame();
    }
    /* Several navigation requests before a flush still clear the previously displayed widgets. */
    swipe(UI_EV_SWIPE_RIGHT); swipe(UI_EV_SWIPE_LEFT); swipe(UI_EV_SWIPE_RIGHT);
    sim_step(20);
    exact_frame();
    /* Any visible face paint must be cleared, including effects outside its eye box. */
    swipe(UI_EV_SWIPE_LEFT);
    sim_step(20);
    for (int mood = 0; mood < MOOD_COUNT; mood++) {
        for (int phase = 0; phase < 5; phase++) {
            scr_home_set_snap(&snap, FX_NOW, (mood_t)mood, false);
            sim_step(630);
            exact_frame();
            swipe(UI_EV_SWIPE_RIGHT);
            sim_step((uint32_t)(phase * 5 + 1));
            exact_frame();
            swipe(UI_EV_SWIPE_LEFT);
            sim_step(20);
            exact_frame();
        }
    }
    /* At Home scale, follow these motions through real partial buffers; the
     * periodic UI timer can also retarget the mood during each loop. */
    const mood_t animated[] = {MOOD_CURIOUS, MOOD_DIZZY, MOOD_LOVE, MOOD_MISCHIEF, MOOD_CHARGING};
    for (unsigned m = 0; m < sizeof animated / sizeof *animated; ++m) {
        scr_home_set_snap(&snap, FX_NOW, animated[m], false);
        for (int frame = 0; frame < 90; ++frame) {
            scr_home_set_snap(&snap, FX_NOW, animated[m], false);
            sim_step(34);
            exact_frame();
        }
    }
    /* Include an entire ordinary blink at Home scale, including the short
     * closing and reopening phases. */
    const mood_t blinking[] = {MOOD_CALM, MOOD_WORRIED};
    for (unsigned m = 0; m < sizeof blinking / sizeof *blinking; ++m) {
        scr_home_set_snap(&snap, FX_NOW, blinking[m], false);
        for (int frame = 0; frame < 160; ++frame) {
            scr_home_set_snap(&snap, FX_NOW, blinking[m], false);
            sim_step(34);
            exact_frame();
        }
    }
    /* Every percent and text-width change, empty rows and the offline variant. */
    snap.today_total = 100;
    for (int pct = 0; pct <= 100; pct++) {
        snap.today_done = pct;
        snap.has_task = pct % 3 != 0;
        snap.has_event = pct % 4 != 0;
        snap.unread = pct;
        fx_post(&snap, 1);
        swipe(UI_EV_SWIPE_RIGHT);
        sim_step(20);
        exact_frame();
        swipe(UI_EV_SWIPE_LEFT);
        sim_step(20);
        exact_frame();
    }
    scr_toast_show("Local test overlay");
    sim_step(20);
    exact_frame();
    swipe(UI_EV_SWIPE_RIGHT);
    sim_step(1);
    exact_frame();
    swipe(UI_EV_SWIPE_LEFT);
    sim_step(6);
    exact_frame();
    sim_step(2100); /* overlay removal must repaint the page underneath */
    exact_frame();
    uint8_t offline = LINK_UI_OFFLINE;
    sim_post(UI_EV_LINK, &offline, 1);
    sim_step(20);
    exact_frame();
    for (int i = 0; i < 4; i++) {
        swipe(UI_EV_SWIPE_RIGHT);
        sim_step(20);
        exact_frame();
        swipe(UI_EV_SWIPE_LEFT);
        sim_step(20);
        exact_frame();
    }
    printf("screen changes: %u..%u pixels (full frame %u)\n", least_pixels, most_pixels, SIM_W * SIM_H);
    return g_failed ? 1 : 0;
}
