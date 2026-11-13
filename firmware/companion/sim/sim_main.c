/* companion_sim --shot today|aelys|aelys_offline|aelys_offline_wifi|focus_none|focus_active|focus_paused|focus_done|inbox|home|lost|lost_hint|ice|ice_progress|lost_max|ice_max|ice_defaults|lost_cyr|ice_cyr|pair|pair_done|welcome|wifi_connecting|wifi_connected|wifi_wrong|wifi_wrong_long|find|find_lost|face:<mood> --out file.bmp [--scale 100] [--at ms]:
 * renders one screen headless. The screens show fake demo data, never the real owner contacts. */
#define _POSIX_C_SOURCE 200809L /* localtime_r, setenv, tzset under -std=c11 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "bmp.h"
#include "sim_display.h"
#include "sim_cues.h"
#include "owner.h"
#include "snap_fixture.h"
#include "ui.h"

static int find_mood(const char *name)
{
    for (int m = 0; m < MOOD_COUNT; m++)
        if (!strcmp(name, mood_name((mood_t)m))) return m;
    return -1;
}

static void post_owner(const owner_info_t *o)
{
    *(owner_info_t *)tribuf_back(&ui_owner_tb) = *o;
    tribuf_publish(&ui_owner_tb);
    sim_post(UI_EV_OWNER, NULL, 0);
}

/* owner_defaults() gives the example contacts; the rest is made up for the screenshots */
static void demo_owner(owner_info_t *o)
{
    owner_defaults(o);
    strcpy(o->name, "Alex Morgan");
    strcpy(o->ice_name[0], "Jamie Lee");
    strcpy(o->ice_phone[0], "+0 000 000 00 01");
    strcpy(o->ice_name[1], "Sam Rivera");
    strcpy(o->ice_phone[1], "+0 000 000 00 02");
    strcpy(o->email, "alex@example.com");
    strcpy(o->ice_rel[0], "Sister");
    strcpy(o->ice_rel[1], "Doctor");
    strcpy(o->med_note, "Allergy: penicillin \xC2\xB7 Blood type O+");
}

/* every field full of the widest letter, as in test_screens */
static void max_owner(owner_info_t *o)
{
    memset(o, 0, sizeof *o);
    char *f[] = { o->name, o->phone, o->telegram, o->qr_url, o->message, o->med_note, o->ice_name[0],
                  o->ice_name[1], o->ice_phone[0], o->ice_phone[1], o->email, o->ice_rel[0], o->ice_rel[1] };
    const size_t cap[] = { sizeof o->name, sizeof o->phone, sizeof o->telegram, sizeof o->qr_url,
                           sizeof o->message, sizeof o->med_note, sizeof o->ice_name[0], sizeof o->ice_name[1],
                           sizeof o->ice_phone[0], sizeof o->ice_phone[1], sizeof o->email, sizeof o->ice_rel[0],
                           sizeof o->ice_rel[1] };
    for (unsigned i = 0; i < sizeof f / sizeof *f; i++) memset(f[i], 'W', cap[i] - 1);
    o->show = 0x3F;
}

/* Cyrillic and Kazakh text (UTF-8 escapes), fake names */
static void cyr_owner(owner_info_t *o)
{
    demo_owner(o);
    strcpy(o->name, "\xD0\x90\xD0\xB9\xD0\xB3\xD0\xB5\xD1\x80\xD0\xB8\xD0\xBC \xD0\xA1\xD0\xB0\xD0\xBF\xD0\xB0\xD1\x80\xD0\xBE\xD0\xB2\xD0\xB0");
    strcpy(o->ice_name[0], "\xD3\x98\xD1\x81\xD0\xB5\xD0\xBC \xD2\x9A\xD2\xB1\xD1\x80\xD0\xBC\xD0\xB0\xD0\xBD\xD2\x93\xD0\xB0\xD0\xBB\xD0\xB8");
    strcpy(o->ice_rel[0], "\xD0\xA1\xD0\xB5\xD1\x81\xD1\x82\xD1\x80\xD0\xB0");
    strcpy(o->ice_rel[1], "\xD0\x90\xD2\x93\xD0\xB0");
    strcpy(o->med_note, "\xD0\x90\xD0\xBB\xD0\xBB\xD0\xB5\xD1\x80\xD0\xB3\xD0\xB8\xD1\x8F: \xD0\xBF\xD0\xB5\xD0\xBD\xD0\xB8\xD1\x86\xD0\xB8\xD0\xBB\xD0\xBB\xD0\xB8\xD0\xBD");
    strcpy(o->message, "\xD0\x95\xD1\x81\xD0\xBB\xD0\xB8 \xD0\xBD\xD0\xB0\xD1\x88\xD0\xBB\xD0\xB8, \xD0\xBF\xD0\xBE\xD0\xB7\xD0\xB2\xD0\xBE\xD0\xBD\xD0\xB8\xD1\x82\xD0\xB5");
}

static void post_ev(uint8_t type, uint8_t d0) { sim_post(type, &d0, 1); }

/* The companion screens, fed with the made-up fixture of snap_fixture.h (14:32, UTC). */
static int companion_shot(const char *shot)
{
    static snap_t s;
    setenv("TZ", "UTC", 1);
    tzset();
    ui_setup();
    ui_set_clock(fx_clock);
    sim_post(UI_EV_TIME, (const uint8_t[]){ 14, 32 }, 2);
    fx_snap(&s);
    post_ev(UI_EV_LINK, LINK_UI_ONLINE);
    if (!strncmp(shot, "focus_", 6)) {
        s.focus.status = !strcmp(shot, "focus_paused") ? FOCUS_PAUSED : !strcmp(shot, "focus_none") ? FOCUS_NONE : FOCUS_ACTIVE;
        strcpy(s.focus.mode, "pomodoro");
        s.focus.elapsed_s = !strcmp(shot, "focus_paused") ? 17 * 60 + 52 : !strcmp(shot, "focus_done") ? 25 * 60 : 9 * 60 + 5;
        strcpy(s.focus.id, "f-3");
    }
    if (!strcmp(shot, "aelys_offline") || !strcmp(shot, "aelys_offline_wifi")) {
        if (!strcmp(shot, "aelys_offline_wifi")) post_ev(UI_EV_WIFI, UI_WIFI_BAD_PASSWORD); /* the usual reason */
        post_ev(UI_EV_LINK, LINK_UI_OFFLINE);
        fx_post(&s, 0);
        return 0;
    }
    fx_post(&s, 1);
    if (!strncmp(shot, "character_", 10)) {
        post_ev(UI_EV_WIFI, UI_WIFI_ONLINE);
        if (!strcmp(shot, "character_sleep")) {
            const uint8_t night[] = {23, 0}; sim_post(UI_EV_TIME, night, 2);
            sim_step(601000);
        } else if (!strcmp(shot, "character_reconnected")) {
            post_ev(UI_EV_LINK, LINK_UI_OFFLINE); post_ev(UI_EV_LINK, LINK_UI_ONLINE);
        } else if (!strcmp(shot, "character_tap") || !strcmp(shot, "character_surprise")) {
            if (!strcmp(shot, "character_surprise")) sim_step(301000);
            const uint8_t point[] = {233, 0, 233, 0};
            sim_post(UI_EV_TOUCH, point, 4); sim_post(UI_EV_TAP, point, 4); sim_post(UI_EV_RELEASE, NULL, 0);
        } else return -1;
        return 0;
    }
    if (!strcmp(shot, "today")) sim_post(UI_EV_SWIPE_RIGHT, NULL, 0);
    else if (!strcmp(shot, "inbox")) {
        sim_post(UI_EV_SWIPE_RIGHT, NULL, 0);
        const uint8_t tap[4] = { 233, 0, 0x52, 1 }; /* (233, 338): the unread row */
        sim_post(UI_EV_TOUCH, tap, 4);
        sim_post(UI_EV_TAP, tap, 4);
    }
    else if (!strncmp(shot, "focus_", 6)) sim_post(UI_EV_SWIPE_LEFT, NULL, 0);
    else if (strcmp(shot, "aelys")) return -1;
    return 0;
}

static int screen_shot(const char *shot)
{
    if (!strncmp(shot, "character_", 10) || !strcmp(shot, "today") || !strcmp(shot, "aelys") || !strcmp(shot, "aelys_offline") || !strcmp(shot, "aelys_offline_wifi") || !strcmp(shot, "inbox") ||
        !strncmp(shot, "focus_", 6))
        return companion_shot(shot);
    static owner_info_t owner;
    const uint8_t time_hm[2] = { 14, 32 };
    const uint8_t on = 1, pct = 60;
    ui_setup();
    if (!strcmp(shot, "lost_max") || !strcmp(shot, "ice_max")) max_owner(&owner);
    else if (!strcmp(shot, "ice_defaults")) owner_defaults(&owner);
    else if (!strcmp(shot, "lost_cyr") || !strcmp(shot, "ice_cyr")) cyr_owner(&owner);
    else demo_owner(&owner);
    post_owner(&owner);
    sim_post(UI_EV_TIME, time_hm, sizeof time_hm);
    if (!strcmp(shot, "home")) return 0;
    if (!strcmp(shot, "lost") || !strcmp(shot, "lost_max") || !strcmp(shot, "lost_cyr")) { sim_post(UI_EV_LOST, &on, 1); return 0; }
    if (!strcmp(shot, "lost_hint")) { /* a key pressed on the lost screen */
        const uint8_t key = BTN_LOW;
        sim_post(UI_EV_LOST, &on, 1);
        sim_post(UI_EV_BTN, &key, 1);
        return 0;
    }
    if (!strcmp(shot, "ice") || !strcmp(shot, "ice_max") || !strcmp(shot, "ice_defaults") || !strcmp(shot, "ice_cyr")) { sim_post(UI_EV_COMBO_FIRE, NULL, 0); return 0; }
    if (!strcmp(shot, "pair")) { const uint8_t d[7] = { PAIR_UI_CODE, '4', '8', '2', '9', '1', '3' }; sim_post(UI_EV_PAIR, d, sizeof d); return 0; }
    if (!strcmp(shot, "pair_done")) { const uint8_t d = PAIR_UI_DONE; sim_post(UI_EV_PAIR, &d, 1); return 0; }
    if (!strcmp(shot, "welcome")) { const uint8_t d = LINK_UI_UNPAIRED; sim_post(UI_EV_LINK, &d, 1); return 0; }
    if (!strncmp(shot, "wifi_", 5)) { /* UI_EV_WIFI_ADD: state, SSID, previous SSID */
        uint8_t d[60] = { !strcmp(shot, "wifi_connecting") ? 0 : !strcmp(shot, "wifi_connected") ? 1 : 2 };
        const char *name = !strcmp(shot, "wifi_wrong_long") ? "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW" : "Office";
        memcpy(&d[1], name, strlen(name));
        memcpy(&d[34], "Home", 4);
        sim_post(UI_EV_WIFI_ADD, d, sizeof d);
        return 0;
    }
    if (!strcmp(shot, "find")) { const uint8_t d = 1; sim_post(UI_EV_FIND, &d, 1); return 0; }
    if (!strcmp(shot, "find_lost")) { const uint8_t d = 1; sim_post(UI_EV_LOST, &on, 1); sim_post(UI_EV_FIND, &d, 1); return 0; }
    if (!strcmp(shot, "ice_progress")) { sim_post(UI_EV_COMBO_PROGRESS, &pct, 1); return 0; }
    return -1;
}

static character_cue_t cue_name(const char *name)
{
    if (!strcmp(name, "joy")) return CUE_JOY;
    if (!strcmp(name, "elation")) return CUE_ELATION;
    if (!strcmp(name, "surprise")) return CUE_SURPRISE;
    if (!strcmp(name, "fright")) return CUE_FRIGHT;
    if (!strcmp(name, "tender")) return CUE_TENDER;
    return CUE_NONE;
}
static const char *cue_output;
static int cue_written;
static void write_event_cue(character_cue_t cue)
{
    FILE *f = fopen(cue_output, "wb");
    if (!f) { cue_written = -1; return; }
    int error = sim_cue_write_wav(f, cue);
    if (fclose(f)) error = -1;
    cue_written = error ? -1 : 1;
}

int main(int argc, char **argv)
{
    const char *shot = NULL, *out = NULL, *cue = NULL, *event_cue = NULL;
    int hour = 14;
    int scale = 100, at = 100; /* at: ms of animation before the shot */
    for (int i = 1; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--shot")) shot = argv[i + 1];
        else if (!strcmp(argv[i], "--out")) out = argv[i + 1];
        else if (!strcmp(argv[i], "--scale")) scale = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--at")) at = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--cue")) cue = argv[i + 1];
        else if (!strcmp(argv[i], "--event-cue")) event_cue = argv[i + 1];
        else if (!strcmp(argv[i], "--hour")) hour = atoi(argv[i + 1]);
        else return 2;
    }
    if (!out || (!!shot + !!cue + !!event_cue != 1) || scale <= 0 || hour < 0 || hour > 23 || argc % 2 != 1) {
        fprintf(stderr, "usage: %s --shot today|aelys|aelys_offline|aelys_offline_wifi|focus_none|focus_active|focus_paused|focus_done|inbox|home|lost|lost_hint|ice|ice_progress|lost_max|ice_max|ice_defaults|lost_cyr|ice_cyr|pair|pair_done|welcome|wifi_connecting|wifi_connected|wifi_wrong|wifi_wrong_long|find|find_lost|face:<mood> --out <file.bmp> [--scale <percent>] [--at <ms>]\n",
                argv[0]);
        fprintf(stderr, "       %s --cue joy|elation|surprise|fright|tender --out file.wav\n"
                        "       %s --event-cue task-complete --out file.wav [--hour 0..23]\n", argv[0], argv[0]);
        return 2;
    }
    if (cue) {
        character_cue_t kind = cue_name(cue);
        if (kind == CUE_NONE) return 2;
        FILE *f = fopen(out, "wb");
        if (!f) return 1;
        int result = sim_cue_write_wav(f, kind);
        if (fclose(f)) result = -1;
        return result ? 1 : 0;
    }
    if (event_cue) {
        if (strcmp(event_cue, "task-complete")) return 2;
        sim_init(); ui_setup(); ui_set_clock(fx_clock);
        uint8_t hm[] = {(uint8_t)hour, 0}, online = LINK_UI_ONLINE;
        sim_post(UI_EV_TIME, hm, 2); sim_post(UI_EV_LINK, &online, 1);
        snap_t snap; fx_snap(&snap); fx_post(&snap, 1);
        cue_output = out; cue_written = 0; ui_set_character_cue_sink(write_event_cue);
        const uint8_t action[] = {ACT_TASK_COMPLETE, 1};
        sim_post(UI_EV_ACTION, action, sizeof action);
        ui_set_character_cue_sink(NULL);
        if (cue_written == 0) { fprintf(stderr, "cue suppressed\n"); return 3; }
        return cue_written < 0 ? 1 : 0;
    }

    sim_init();
    if (!strncmp(shot, "face:", 5)) {
        int mood = find_mood(shot + 5);
        if (mood < 0) {
            fprintf(stderr, "unknown mood '%s'\n", shot + 5);
            return 2;
        }
        lv_obj_t *face = face_create(lv_screen_active(), scale);
        if (!face) return 1;
        lv_obj_center(face);
        face_set_mood(face, (mood_t)mood);
    } else if (screen_shot(shot)) {
        fprintf(stderr, "unknown screen '%s' (try home, lost, ice, ice_progress, face:calm)\n", shot);
        return 2;
    }
    sim_step(at > 0 ? (uint32_t)at : 100);
    sim_step(20); /* the frame after the last animation step draws it */
    if (bmp_write_rgb565(out, sim_fb(), SIM_W, SIM_H)) {
        fprintf(stderr, "cannot write %s\n", out);
        return 1;
    }
    return 0;
}
