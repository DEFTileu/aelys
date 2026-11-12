#include "check.h"
#include "sim_display.h"
#include "ui_face_priv.h"

static int is_eye(uint16_t c) { return ((c >> 11) & 31) > 26 && ((c >> 5) & 63) > 52 && (c & 31) > 26; }
static int is_black(uint16_t c) { return c == 0; }

int main(void)
{
    /* geometry straight from the design's MOODS table (CompanionFace.dc.html), scale 1 */
    const face_mood_t *calm = face_mood_def(MOOD_CALM);
    face_rect_t l = face_eye_rect(&calm->eye[0], 0, 100, 1000), r = face_eye_rect(&calm->eye[1], 1, 100, 1000);
    CHECK_EQ(l.x, 39); CHECK_EQ(l.y, 28); CHECK_EQ(l.w, 70); CHECK_EQ(l.h, 104);
    CHECK_EQ(r.x, 171); CHECK_EQ(r.cx, 206); CHECK_EQ(r.cy, 80);
    face_rect_t c = face_eye_rect(&face_mood_def(MOOD_CURIOUS)->eye[1], 1, 100, 1000);
    CHECK_EQ(c.cx, 220); CHECK_EQ(c.h, 82); CHECK_EQ(c.y, 39); /* dx 14, right eye shorter */
    face_rect_t s = face_eye_rect(&face_mood_def(MOOD_SAD)->eye[0], 0, 100, 1000);
    CHECK_EQ(s.cy, 90);                                        /* dy 10 */
    face_rect_t b = face_eye_rect(&calm->eye[0], 0, 150, 500);
    CHECK_EQ(b.h, 78); CHECK_EQ(b.cy, 120);                    /* half-closed, centre unchanged */

    /* blink: 5.2 s cycle, open, ~150 ms to 8 %, back open; none for sleeping/dizzy/offline */
    CHECK_EQ(face_blink_x1000(0), 1000);
    CHECK_EQ(face_blink_x1000(4700), 1000);
    CHECK_EQ(face_blink_x1000(4940), 80);
    CHECK(face_blink_x1000(4860) < 1000 && face_blink_x1000(4860) > 80);
    CHECK_EQ(face_blink_x1000(5200), 1000);                    /* wraps */
    for (int m = 0; m < MOOD_COUNT; m++) {
        int still = m == MOOD_SLEEPING || m == MOOD_DIZZY || m == MOOD_OFFLINE;
        CHECK_EQ(face_mood_def((mood_t)m)->blink, !still);
    }
    CHECK(face_mood_def(MOOD_COUNT) == NULL);

    /* rendered pixels: lit eye on black, face at the screen origin */
    sim_init();
    lv_obj_t *face = face_create(lv_screen_active(), 100);
    lv_obj_set_pos(face, 0, 0);
    face_set_mood(face, MOOD_CALM);
    sim_step(100);
    const uint16_t *fb = sim_fb();
    CHECK(is_eye(fb[80 * SIM_W + 74]));      /* left eye centre */
    CHECK(is_eye(fb[80 * SIM_W + 206]));     /* right eye centre */
    CHECK(is_black(fb[80 * SIM_W + 140]));   /* between the eyes */
    CHECK(is_black(fb[2 * SIM_W + 74]));     /* above the eye */
    face_set_mood(face, MOOD_SLEEPING);      /* closed: thin line at dy 12 */
    sim_step(100);
    CHECK(is_black(fb[60 * SIM_W + 74]));
    CHECK(is_eye(fb[92 * SIM_W + 74]));
    return g_failed ? 1 : 0;
}
