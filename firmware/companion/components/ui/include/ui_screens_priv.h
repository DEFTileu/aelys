#pragma once
/* Internal to components/ui: the screens and the helpers they share. One UI instance, so the
 * screens keep their widgets in file-level statics. Not a public API. */
#include "owner.h"
#include "screen_fsm.h"
#include "ui.h"
#include "ui_theme.h"

#define UI_SCREEN_SIZE 466

#ifdef CONFIG_AELYS_PERF_PROBE
/* UI task only. A bench screen change, never a gesture/action/hold. False under overlays or real input. */
bool ui_probe_swipe(void);
#endif

/* screens.c: helpers */
lv_obj_t *ui_plain(lv_obj_t *parent, int32_t w, int32_t h);      /* transparent, no border/pad, inert */
/* Circle outline `inset` px inside the display. */
lv_obj_t *ui_ring(lv_obj_t *parent, int32_t inset, int32_t width, uint32_t color);
/* One-or-more-line label, LV_LABEL_LONG_MODE_DOTS in a fixed box: text that does not fit ends in "...". */
lv_obj_t *ui_label(lv_obj_t *parent, const lv_font_t *font, uint32_t color, int32_t w, int32_t lines,
                   lv_text_align_t align);
/* Wrapped height of `txt` in `w` px, clamped to `max_lines` lines (at least one). */
int32_t ui_text_height(const char *txt, const lv_font_t *font, int32_t w, int32_t max_lines);
/* Stack the visible objs top to bottom (gap[i] px above o[i]) and centre the stack in
 * [area_y, area_y + area_h) of their parent. x < 0 centres each horizontally, else sets x. */
void ui_stack(lv_obj_t *const o[], const uint8_t gap[], int n, int32_t area_y, int32_t area_h, int32_t x);

scr_t ui_current_screen(void); /* for host tests */

/* screens.c: more helpers */
void ui_text_color(lv_obj_t *o, uint32_t color);             /* ditto for the text colour */
void ui_set_text(lv_obj_t *label, const char *txt);         /* only touches the label when the text changed: no redraw */
void ui_fmt_hm(char out[8], int64_t epoch);                  /* local "HH:MM" ("--:--" for epoch <= 0) */
int64_t ui_now(void);                                        /* wall-clock epoch seconds, 0 until the clock is set */
bool ui_marked_done(const char *task_id);                    /* task.complete sent for it, answer still open or ok */
bool ui_marked_read(const char *notice_id);                  /* notification.read sent for it */
/* Round-ring track plus a clockwise lit arc from 12 o'clock (design ".ring": 12 px wide, 8 px inside the display). */
typedef struct { lv_obj_t *obj; int pct; uint32_t fg, track; } ui_arc_t;
void ui_arc_create(ui_arc_t *a, lv_obj_t *parent);
void ui_arc_set(ui_arc_t *a, int pct, uint32_t fg, uint32_t track); /* redraws only when something changed */
/* Round tick box: outline d px wide, filled with `fill` and a white check when on. */
lv_obj_t *ui_check_create(lv_obj_t *parent, int32_t d);
void ui_check_set(lv_obj_t *check, bool on, uint32_t fill);

/* mood_rules.c: translate known snapshot and clock inputs into the character engine. */
character_inputs_t ui_character_inputs(const snap_t *s, int64_t now, bool have_time, uint8_t hour,
                                       bool link_known, bool online, uint32_t snap_ms, uint32_t now_ms);
character_result_t ui_character_last(void);
mood_t scr_home_mood(void);
mood_t scr_home_offline_mood(void);

/* scr_toast.c: one short message on top of everything, gone after 2 s. */
lv_obj_t *scr_toast_create(lv_obj_t *parent);
void scr_toast_show(const char *txt);
void scr_toast_hide(void);                                 /* at once, timers stopped; also takes the Wi-Fi card off */
/* The Wi-Fi card: state as UI_EV_WIFI_ADD data[0] (0 connecting, 1 connected, 2 failed); prev "" = no network to name. False for an unknown state. */
bool scr_wifi_card_show(uint8_t state, const char *ssid, const char *prev);
void scr_wifi_card_hide(void);                             /* at once, timer stopped */
/* The find overlay ("Here I am!"): full screen, on top of everything incl. lost mode and the ICE card; its own timer runs only while shown. */
lv_obj_t *scr_find_create(lv_obj_t *parent);
void scr_find_show(bool on);                               /* idempotent: showing it again does not restart the animation */

/* scr_today.c (design "Today · обзор") */
lv_obj_t *scr_today_create(lv_obj_t *parent);
void scr_today_set_time(uint8_t hour, uint8_t minute);     /* hour 255 = clock not set */
void scr_today_set(const snap_t *s, int64_t now);
tap_hit_t scr_today_hit(int32_t x, int32_t y);             /* TAP_ROW = the task row, TAP_UNREAD_ROW = the "{n} new" row */

/* scr_focus.c (design "Focus · идёт / пауза / сессия завершена") */
typedef enum { FV_NONE, FV_ACTIVE, FV_PAUSED, FV_DONE } focus_view_t;
lv_obj_t *scr_focus_create(lv_obj_t *parent);
/* snap_ms: lv_tick_get() when the snapshot arrived, now_ms: lv_tick_get() now. Returns what the screen shows. */
focus_view_t scr_focus_set(const snap_t *s, uint32_t snap_ms, uint32_t now_ms);
focus_view_t scr_focus_view(void);                         /* what it showed last */
act_kind_t scr_focus_top_action(void);                     /* what the top key / a tap does in the current view */

/* scr_inbox.c (design "Уведомления · входящие") */
lv_obj_t *scr_inbox_create(lv_obj_t *parent);
void scr_inbox_set(const snap_t *s, int64_t now);
int scr_inbox_hit(int32_t x, int32_t y);                   /* row index or -1 */
/* The look of a notice kind ("Tasks", tile and dot colours); false for a kind without a title on the board (Telegram, other apps). */
bool ui_notice_style(const char *kind, const char **name, uint32_t *bg, uint32_t *fg);

/* scr_calendar.c (design "Календарь · следующее"): the one next event, relative to the clock; ring over the last 60 min before the start */
lv_obj_t *scr_calendar_create(lv_obj_t *parent);
void scr_calendar_set(const snap_t *s, int64_t now);

/* scr_notice.c (designs "Уведомление · всплывает", "Уведомление · Telegram"): the new-notice card, 6 s, over everyday screens only. A kind
 * without a title on the board (Telegram, others) shows its name and `count` instead of the title. */
lv_obj_t *scr_notice_create(lv_obj_t *parent);
void scr_notice_show(const snap_notice_t *n, int count);
void scr_notice_hide(void);                                /* at once, timer stopped */
bool scr_notice_visible(void);
bool scr_notice_hit(int32_t x, int32_t y);                 /* a touch on the card (a little around it) */

/* scr_menu.c: the menu wheel and the shared "Coming soon" screen. The item table (name, colour, target screen) is items[] there. */
lv_obj_t *scr_menu_create(lv_obj_t *parent);
void scr_menu_set(const snap_t *s);                        /* name and sub line of the selected item */
void scr_menu_step(int dir);                               /* turn the wheel one item: dir > 0 next (swipe left), < 0 previous; wraps */
int scr_menu_selected(void);                               /* index of the selected item */
scr_t scr_menu_target(void);                               /* the screen the selected item opens */
bool scr_menu_hit(int32_t x, int32_t y);                   /* a tap on the selected item or the centre */
lv_obj_t *scr_placeholder_create(lv_obj_t *parent);
void scr_placeholder_set(void);                            /* shows the selected menu item's name */

/* scr_tasks.c (design "Задачи · сегодня", one task at a time): the next task, today's progress, the check that completes it */
lv_obj_t *scr_tasks_create(lv_obj_t *parent);
void scr_tasks_set(const snap_t *s, int64_t now, bool offline);
bool scr_tasks_hit(int32_t x, int32_t y);                  /* a tap on the check (or close to it) */

/* scr_timer.c (design "Таймер · идёт / время вышло", "Секундомер"): one screen, a timer (presets by swipe) and a stopwatch (the last
 * item of the same swipe). The state lives here and runs on lv_tick_get(), so it carries on while another screen shows. */
lv_obj_t *scr_timer_create(lv_obj_t *parent);
void scr_timer_set(void);                                  /* render the state (the visible screen) */
void scr_timer_swipe(int dir);                             /* dir > 0 swipe left: next preset / the stopwatch; paused timer: back to Set */
void scr_timer_top(void);                                  /* the top key: start / pause / resume; stop on "Time's up"; stopwatch start / stop */
void scr_timer_tap(int32_t x, int32_t y);                  /* the same as the top key, +1 min on "Time's up", Lap / Reset on the stopwatch pill */
void scr_timer_summary(char *out, size_t cap);             /* one line for the menu: "04:12 left", "Paused", "Time's up" or "" */
void ui_toast(const char *txt);                            /* screens.c: toast() for screens that expire on their own */

/* scr_settings.c (designs "Настройки", "Wi-Fi · сохранённые сети"): the list and the Wi-Fi and About screens it opens */
lv_obj_t *scr_settings_create(lv_obj_t *parent);
lv_obj_t *scr_wifinets_create(lv_obj_t *parent);
lv_obj_t *scr_about_create(lv_obj_t *parent);
void scr_settings_set(void);
void scr_wifinets_set(void);
void scr_about_set(void);
void scr_settings_step(int dir);                           /* the highlight to the next (dir > 0, swipe left) or previous enabled row; wraps */
scr_t scr_settings_top(void);                              /* the top key on the highlighted row: the screen to open (SCR_SETTINGS = stay) */
scr_t scr_settings_tap(int32_t x, int32_t y);              /* a tap on a row: selects and acts like the top key */
void scr_settings_note_brightness(uint8_t pct);            /* UI_EV_BRIGHTNESS */
void scr_settings_set_wifi(uint8_t state, const char *cur); /* UI_EV_WIFI: ui_wifi_state_t and the network in use ("" = none) */
void scr_settings_level_changed(bool on);                  /* tells the board (hook) that the switch changed */
bool ui_level_on(void);                                    /* screens.c: "always level" */
void ui_level_set(bool on, bool notify);                   /* turn it on or off; notify: also tell the board to save it */
bool ui_paired(void);                                      /* screens.c: the board is paired with the server */

/* orbit.c: task dots on a ring. total == 0 draws 8 dim placeholder dots (nothing paired yet). */
lv_obj_t *orbit_create(lv_obj_t *parent, int32_t size);
void orbit_set(lv_obj_t *orbit, int done, int total);

lv_obj_t *scr_home_create(lv_obj_t *parent);
lv_obj_t *scr_home_root(void);
void scr_home_set_time(uint8_t hour, uint8_t minute);
void scr_home_set_tasks(int done, int total);
void scr_home_set_wifi(uint8_t state); /* ui_wifi_state_t */
void scr_home_set_paired(bool on);    /* paired: no "Not paired yet" line while there are no tasks */
void scr_home_set_snap(const snap_t *s, int64_t now, mood_t mood, bool offline); /* orbit, face mood and the "Offline" view */
void scr_home_set_level(int32_t angle10); /* keeps both home faces level (face_set_level) */
void scr_home_set_welcome(bool on);   /* first boot: "Hi, I'm Aelys / Connect me by USB ..." instead of the agenda line */

lv_obj_t *scr_lost_create(lv_obj_t *parent);
void scr_lost_set_owner(const owner_info_t *o);
void scr_lost_show_hint(void); /* "Only the owner can turn this off" for 2 s; a second call restarts it */
void scr_lost_hide_hint(void);

lv_obj_t *scr_ice_create(lv_obj_t *parent);
void scr_ice_set_owner(const owner_info_t *o);

/* Both-buttons-held overlay: ring that fills with pct (0..100). */
lv_obj_t *scr_hold_create(lv_obj_t *parent);
void scr_hold_set(int pct);

lv_obj_t *scr_pair_create(lv_obj_t *parent);
bool scr_pair_set_code(const char *digits); /* 6 ASCII digits; false (nothing changed) if one is not a digit */
void scr_pair_set_done(void);               /* the "Paired" card */
