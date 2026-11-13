/* ui_mood_for: priority offline > focused > sad > worried > happy > proud > calm. */
#include <string.h>
#include "check.h"
#include "ui_screens_priv.h"

#define NOW 1000000

static snap_t calm_day(void)
{
    snap_t s;
    memset(&s, 0, sizeof s);
    s.today_done = 2;
    s.today_total = 5;
    return s;
}

static void test_each_rule(void)
{
    snap_t s = calm_day();
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_CALM);
    CHECK_EQ(ui_mood_for(&s, NOW, false, false), MOOD_OFFLINE);

    s.focus.status = FOCUS_ACTIVE;
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_FOCUSED);
    s.focus.status = FOCUS_PAUSED;                               /* only a running session focuses her */
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_CALM);

    s = calm_day();
    s.overdue = 1;
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_SAD);

    s = calm_day();
    s.has_task = true;
    s.task.due = NOW + 59 * 60;
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_WORRIED);
    s.task.due = NOW + 60 * 60;                                  /* 60 min is not "< 60" */
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_CALM);
    s.task.due = 0;                                              /* a task with no due time is never close */
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_CALM);
    s.task.due = NOW + 59 * 60;
    CHECK_EQ(ui_mood_for(&s, 0, true, false), MOOD_CALM);        /* clock not set: cannot tell */

    s = calm_day();
    CHECK_EQ(ui_mood_for(&s, NOW, true, true), MOOD_HAPPY);

    s = calm_day();
    s.today_done = 5;
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_PROUD);
    s.today_done = s.today_total = 0;                            /* nothing planned is not an achievement */
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_CALM);
    s.today_done = s.today_total = -1;                           /* v1 server */
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_CALM);
}

static void test_priority_order(void)
{
    snap_t s = calm_day();
    s.today_done = 5;                                            /* proud */
    s.has_task = true; s.task.due = NOW + 60;                    /* worried */
    s.overdue = 2;                                               /* sad */
    s.focus.status = FOCUS_ACTIVE;                               /* focused */
    CHECK_EQ(ui_mood_for(&s, NOW, true, true), MOOD_FOCUSED);    /* ... and happy */
    CHECK_EQ(ui_mood_for(&s, NOW, false, true), MOOD_OFFLINE);
    s.focus.status = FOCUS_NONE;
    CHECK_EQ(ui_mood_for(&s, NOW, true, true), MOOD_SAD);
    s.overdue = 0;
    CHECK_EQ(ui_mood_for(&s, NOW, true, true), MOOD_WORRIED);
    s.task.due = 0;
    CHECK_EQ(ui_mood_for(&s, NOW, true, true), MOOD_HAPPY);
    CHECK_EQ(ui_mood_for(&s, NOW, true, false), MOOD_PROUD);
}

int main(void)
{
    test_each_rule();
    test_priority_order();
    return g_failed ? 1 : 0;
}
