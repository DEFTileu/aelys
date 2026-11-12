/* companion_sim --shot home|lost|ice|ice_progress|lost_max|ice_max|ice_defaults|face:<mood> --out file.bmp [--scale 100]:
 * renders one screen headless. The screens show fake demo data, never the real owner contacts. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "bmp.h"
#include "sim_display.h"
#include "owner.h"
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
    strcpy(o->med_note, "Allergy: penicillin \xC2\xB7 Blood type O+");
}

/* every field full of the widest letter, as in test_screens */
static void max_owner(owner_info_t *o)
{
    memset(o, 0, sizeof *o);
    char *f[] = { o->name, o->phone, o->telegram, o->qr_url, o->message, o->med_note, o->ice_name[0],
                  o->ice_name[1], o->ice_phone[0], o->ice_phone[1] };
    const size_t cap[] = { sizeof o->name, sizeof o->phone, sizeof o->telegram, sizeof o->qr_url,
                           sizeof o->message, sizeof o->med_note, sizeof o->ice_name[0], sizeof o->ice_name[1],
                           sizeof o->ice_phone[0], sizeof o->ice_phone[1] };
    for (unsigned i = 0; i < sizeof f / sizeof *f; i++) memset(f[i], 'W', cap[i] - 1);
}

static int screen_shot(const char *shot)
{
    static owner_info_t owner;
    const uint8_t time_hm[2] = { 14, 32 };
    const uint8_t on = 1, pct = 60;
    ui_setup();
    if (!strcmp(shot, "lost_max") || !strcmp(shot, "ice_max")) max_owner(&owner);
    else if (!strcmp(shot, "ice_defaults")) owner_defaults(&owner);
    else demo_owner(&owner);
    post_owner(&owner);
    sim_post(UI_EV_TIME, time_hm, sizeof time_hm);
    if (!strcmp(shot, "home")) return 0;
    if (!strcmp(shot, "lost") || !strcmp(shot, "lost_max")) { sim_post(UI_EV_LOST, &on, 1); return 0; }
    if (!strcmp(shot, "ice") || !strcmp(shot, "ice_max") || !strcmp(shot, "ice_defaults")) { sim_post(UI_EV_COMBO_FIRE, NULL, 0); return 0; }
    if (!strcmp(shot, "ice_progress")) { sim_post(UI_EV_COMBO_PROGRESS, &pct, 1); return 0; }
    return -1;
}

int main(int argc, char **argv)
{
    const char *shot = NULL, *out = NULL;
    int scale = 100;
    for (int i = 1; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--shot")) shot = argv[i + 1];
        else if (!strcmp(argv[i], "--out")) out = argv[i + 1];
        else if (!strcmp(argv[i], "--scale")) scale = atoi(argv[i + 1]);
        else shot = NULL;
    }
    if (!shot || !out || scale <= 0) {
        fprintf(stderr, "usage: %s --shot home|lost|ice|ice_progress|lost_max|ice_max|ice_defaults|face:<mood> --out <file.bmp> [--scale <percent>]\n",
                argv[0]);
        return 2;
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
    sim_step(100);
    if (bmp_write_rgb565(out, sim_fb(), SIM_W, SIM_H)) {
        fprintf(stderr, "cannot write %s\n", out);
        return 1;
    }
    return 0;
}
