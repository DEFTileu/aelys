/* Menu wheel (design "Меню · колесо приложений") and the shared "Coming soon" screen.
 * Nine round items sit on a ring of 160 px around the centre, 40 degrees apart; the selected one is at 12 o'clock inside an accent
 * ring and named in the centre. A swipe turns the wheel by one item (a 160 ms animation of the item positions, nothing is rotated
 * or cached as a layer). Deviations: no icon font, so an item shows its initial in the module colour; the sub line is live for
 * Tasks, Timer and Inbox, "Coming soon" for items without a screen and empty for the rest.
 *
 * To give an item its real screen change its `target` in items[] below, nothing else. */
#include <stdio.h>
#include "ui_screens_priv.h"

#define N_ITEMS 9
#define STEP_DEG (360 / N_ITEMS)
#define RING_R 160    /* centre of the items from the display centre */
#define ITEM_D 68
#define SEL_D 88      /* the selection ring */
#define TURN_MS 160
#define CENTRE_HIT_R 100

#define COLOR_ITEM_BG 0x16141C
#define COLOR_SOON 0xA6A0B2

typedef struct {
    const char *name;
    uint32_t color;
    scr_t target; /* SCR_PLACEHOLDER = "Coming soon" */
} menu_item_t;

static const menu_item_t items[N_ITEMS] = {
    { "Tasks",     0x7FA8F5, SCR_TASKS },
    { "Focus",     0xF6907F, SCR_FOCUS },
    { "Timer",     0xF6907F, SCR_TIMER },
    { "Calendar",  0xFF8A84, SCR_PLACEHOLDER },
    { "Inbox",     0xB9A8FF, SCR_INBOX },
    { "Weather",   0x7FA8F5, SCR_PLACEHOLDER },
    { "Ask Aelys", 0xB9A8FF, SCR_PLACEHOLDER },
    { "Games",     0x5FD7A8, SCR_PLACEHOLDER },
    { "Settings",  0xA6A0B2, SCR_PLACEHOLDER },
};

static struct {
    lv_obj_t *root, *item[N_ITEMS], *name, *sub;
    int sel;
    int32_t deg, goal; /* wheel angle now / when the turn ends; goal == sel * STEP_DEG modulo 360 */
} m;

static struct { lv_obj_t *root, *name, *sub; } p;

static void place(int32_t deg)
{
    m.deg = deg;
    for (int i = 0; i < N_ITEMS; i++) {
        int16_t a = (int16_t)((((i * STEP_DEG - deg) % 360) + 360) % 360);
        lv_obj_set_pos(m.item[i], UI_SCREEN_SIZE / 2 - ITEM_D / 2 + RING_R * lv_trigo_sin(a) / LV_TRIGO_SIN_MAX,
                       UI_SCREEN_SIZE / 2 - ITEM_D / 2 - RING_R * lv_trigo_sin(a + 90) / LV_TRIGO_SIN_MAX);
    }
}

static void turn_cb(void *var, int32_t deg)
{
    (void)var;
    place(deg);
}

static void centre(lv_obj_t *name, lv_obj_t *sub)
{
    lv_obj_t *col[] = { name, sub };
    const uint8_t gap[] = { 0, 4 };
    ui_stack(col, gap, 2, 0, UI_SCREEN_SIZE, -1);
}

/* The sub line under the name: live where the snapshot has it, "Coming soon" where the item has no screen yet. */
static void sub_text(char *out, size_t cap, int i, const snap_t *s)
{
    out[0] = 0;
    if (items[i].target == SCR_PLACEHOLDER) snprintf(out, cap, "Coming soon");
    else if (items[i].target == SCR_TASKS && s->today_total > 0) snprintf(out, cap, "%d / %d done", s->today_done, s->today_total);
    else if (items[i].target == SCR_TIMER) scr_timer_summary(out, cap);
    else if (items[i].target == SCR_INBOX) snprintf(out, cap, "%d new", s->unread > 0 ? s->unread : 0);
}

void scr_menu_set(const snap_t *s)
{
    char t[24];
    sub_text(t, sizeof t, m.sel, s);
    ui_set_text(m.name, items[m.sel].name);
    ui_text_color(m.name, items[m.sel].color);
    ui_set_text(m.sub, t);
    lv_obj_set_hidden(m.sub, !t[0]);
    centre(m.name, m.sub);
}

void scr_menu_step(int dir)
{
    m.sel = (m.sel + (dir < 0 ? N_ITEMS - 1 : 1)) % N_ITEMS;
    m.goal += dir < 0 ? -STEP_DEG : STEP_DEG;
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, m.root);
    lv_anim_set_exec_cb(&a, turn_cb);
    lv_anim_set_values(&a, m.deg, m.goal);
    lv_anim_set_duration(&a, TURN_MS);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_out);
    lv_anim_delete(m.root, turn_cb); /* a second swipe mid-turn carries on from where the wheel is */
    lv_anim_start(&a);
}

int scr_menu_selected(void) { return m.sel; }
scr_t scr_menu_target(void) { return items[m.sel].target; }

bool scr_menu_hit(int32_t x, int32_t y)
{
    int32_t cx = UI_SCREEN_SIZE / 2, dx = x - cx, dy = y - (cx - RING_R);
    int32_t ex = x - cx, ey = y - cx;
    return dx * dx + dy * dy <= (SEL_D / 2) * (SEL_D / 2) || ex * ex + ey * ey <= CENTRE_HIT_R * CENTRE_HIT_R;
}

lv_obj_t *scr_menu_create(lv_obj_t *parent)
{
    m.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    for (int i = 0; i < N_ITEMS; i++) {
        lv_obj_t *c = ui_plain(m.root, ITEM_D, ITEM_D);
        lv_obj_set_style_radius(c, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_opa(c, LV_OPA_COVER, 0);
        lv_obj_set_style_bg_color(c, lv_color_hex(COLOR_ITEM_BG), 0);
        lv_obj_t *l = ui_label(c, &inter_28, items[i].color, ITEM_D, 1, LV_TEXT_ALIGN_CENTER);
        char ini[2] = { items[i].name[0], 0 };
        lv_label_set_text(l, ini);
        lv_obj_center(l);
        m.item[i] = c;
    }
    lv_obj_t *ring = ui_plain(m.root, SEL_D, SEL_D);
    lv_obj_set_pos(ring, (UI_SCREEN_SIZE - SEL_D) / 2, (UI_SCREEN_SIZE - 2 * RING_R - ITEM_D) / 2 + (ITEM_D - SEL_D) / 2);
    lv_obj_set_style_radius(ring, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_border_width(ring, 3, 0);
    lv_obj_set_style_border_color(ring, lv_color_hex(UI_COLOR_ACCENT), 0);
    m.name = ui_label(m.root, &inter_28, UI_COLOR_TEXT, 220, 1, LV_TEXT_ALIGN_CENTER);
    m.sub = ui_label(m.root, &inter_16, UI_COLOR_SUBTLE, 220, 1, LV_TEXT_ALIGN_CENTER);
    m.sel = 0;
    m.goal = 0;
    place(0);
    scr_menu_set(&(snap_t){ 0 });
    return m.root;
}

/* The placeholder: the name of the item that was opened and "Coming soon". */
void scr_placeholder_set(void)
{
    ui_set_text(p.name, items[m.sel].name);
    ui_text_color(p.name, items[m.sel].color);
    centre(p.name, p.sub);
}

lv_obj_t *scr_placeholder_create(lv_obj_t *parent)
{
    p.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    p.name = ui_label(p.root, &inter_28, UI_COLOR_TEXT, 300, 1, LV_TEXT_ALIGN_CENTER);
    p.sub = ui_label(p.root, &inter_20, COLOR_SOON, 300, 1, LV_TEXT_ALIGN_CENTER);
    lv_label_set_text(p.sub, "Coming soon");
    scr_placeholder_set();
    return p.root;
}
