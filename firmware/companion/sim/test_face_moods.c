#include <string.h>
#include "check.h"
#include "sim_display.h"
#include "ui.h"

int main(void)
{
    sim_init();
    CHECK_EQ(MOOD_COUNT, 14);
    for (int m = 0; m < MOOD_COUNT; m++) {
        lv_obj_t *face = face_create(lv_screen_active(), 100);
        CHECK(face != NULL);
        if (face) face_set_mood(face, (mood_t)m);
        sim_step(40);
        if (face) lv_obj_delete(face);

        const char *name = mood_name((mood_t)m);
        CHECK(name && name[0]);
        for (int k = 0; name && k < m; k++) CHECK(strcmp(name, mood_name((mood_t)k)) != 0);
    }
    CHECK(strcmp(mood_name(MOOD_COUNT), "?") == 0);
    CHECK(face_create(NULL, 100) == NULL);
    return g_failed ? 1 : 0;
}
