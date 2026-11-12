/* companion_sim --shot face:<mood> --out file.bmp [--scale 100]: renders one screen headless. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "bmp.h"
#include "sim_display.h"
#include "ui.h"

static int find_mood(const char *name)
{
    for (int m = 0; m < MOOD_COUNT; m++)
        if (!strcmp(name, mood_name((mood_t)m))) return m;
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
        fprintf(stderr, "usage: %s --shot face:<mood> --out <file.bmp> [--scale <percent>]\n", argv[0]);
        return 2;
    }
    int mood = strncmp(shot, "face:", 5) ? -1 : find_mood(shot + 5);
    if (mood < 0) {
        fprintf(stderr, "unknown screen '%s' (try face:calm)\n", shot);
        return 2;
    }

    sim_init();
    lv_obj_t *face = face_create(lv_screen_active(), scale);
    if (!face) return 1;
    lv_obj_center(face);
    face_set_mood(face, (mood_t)mood);
    sim_step(100);
    if (bmp_write_rgb565(out, sim_fb(), SIM_W, SIM_H)) {
        fprintf(stderr, "cannot write %s\n", out);
        return 1;
    }
    return 0;
}
