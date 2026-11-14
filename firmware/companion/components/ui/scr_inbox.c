/* Inbox (design "Уведомления · входящие"): "Inbox · {unread}", up to five rows (a round tile in the kind's colour, the
 * title, "Tasks|Calendar|Focus · {relative time}"), tap a row to mark it read (the tile turns into a tick at once), and
 * "+{n} from other apps" when the server counts other notifications (a v1 server: hidden).
 * Deviations: the tile holds a colour dot instead of the module icon (no icon font); the design's Telegram row is the
 * footer count, as the brief says; the title is not upper-cased. */
#include <stdio.h>
#include <string.h>
#include "ui_screens_priv.h"

#define ROWS 5
#define ROW_W 320
#define ROW_H 58
#define TILE 42

typedef struct { const char *prefix, *name; uint32_t bg, fg; } kind_t;
static const kind_t KINDS[] = {
    { "task.", "Tasks", 0x141B2A, 0x7FA8F5 },
    { "calendar.", "Calendar", 0x2A1618, 0xFF8A84 },
    { "focus.", "Focus", 0x2A1716, 0xF6907F },
};

bool ui_notice_style(const char *kind, const char **name, uint32_t *bg, uint32_t *fg)
{
    for (unsigned j = 0; j < sizeof KINDS / sizeof *KINDS; j++)
        if (!strncmp(kind, KINDS[j].prefix, strlen(KINDS[j].prefix))) {
            *name = KINDS[j].name; *bg = KINDS[j].bg; *fg = KINDS[j].fg;
            return true;
        }
    return false;
}

static struct {
    lv_obj_t *root, *head, *foot;
    struct { lv_obj_t *row, *tile, *dot, *title, *sub; uint32_t fg; bool read; } r[ROWS];
} h;

static void restack(void)
{
    lv_obj_t *col[ROWS + 2] = { h.head };
    uint8_t gap[ROWS + 2] = { 0, 8 };
    for (int i = 0; i < ROWS; i++) col[1 + i] = h.r[i].row;
    for (int i = 2; i <= ROWS; i++) gap[i] = 0;
    col[ROWS + 1] = h.foot;
    gap[ROWS + 1] = 8;
    ui_stack(col, gap, ROWS + 2, 0, UI_SCREEN_SIZE, -1);
}

/* "now", "5 min ago", "3 h ago", "2 d ago"; "" when either clock is unknown */
static void rel_time(char *out, size_t n, int64_t now, int64_t then)
{
    int64_t d = now - then;
    if (now <= 0 || then <= 0) out[0] = 0;
    else if (d < 60) snprintf(out, n, "now");
    else if (d < 3600) snprintf(out, n, "%d min ago", (int)(d / 60));
    else if (d < 86400) snprintf(out, n, "%d h ago", (int)(d / 3600));
    else snprintf(out, n, "%d d ago", (int)(d / 86400));
}

void scr_inbox_set(const snap_t *s, int64_t now)
{
    char t[48], rel[16];
    snprintf(t, sizeof t, "Inbox \xC2\xB7 %d", s->unread > 0 ? s->unread : 0);
    ui_set_text(h.head, t);
    for (int i = 0; i < ROWS; i++) {
        bool on = i < s->n_notices;
        lv_obj_set_hidden(h.r[i].row, !on);
        if (!on) continue;
        const snap_notice_t *n = &s->notices[i];
        const char *kname = "";
        uint32_t bg = 0x16141C, fg = UI_COLOR_SUBTLE;
        bool k = ui_notice_style(n->kind, &kname, &bg, &fg);
        bool read = ui_marked_read(n->id);
        if (h.r[i].fg != fg || h.r[i].read != read) { /* restyle only on a change: no redraw once a second */
            h.r[i].fg = fg;
            h.r[i].read = read;
            ui_check_set(h.r[i].tile, read, fg); /* read: filled with the kind's colour and a tick; unread: a dot on the dark tile */
            lv_obj_set_style_bg_opa(h.r[i].tile, LV_OPA_COVER, 0);
            lv_obj_set_style_bg_color(h.r[i].tile, lv_color_hex(read ? fg : bg), 0);
            lv_obj_set_style_border_width(h.r[i].tile, 0, 0);
            lv_obj_set_style_bg_color(h.r[i].dot, lv_color_hex(fg), 0);
            lv_obj_set_hidden(h.r[i].dot, read);
        }
        ui_set_text(h.r[i].title, n->title);
        ui_text_color(h.r[i].title, read ? UI_COLOR_MUTED : UI_COLOR_TEXT);
        rel_time(rel, sizeof rel, now, n->created);
        snprintf(t, sizeof t, "%s%s%s", kname, k && rel[0] ? " \xC2\xB7 " : "", rel);
        ui_set_text(h.r[i].sub, t);
    }
    bool other = s->other_unread > 0;
    if (other) snprintf(t, sizeof t, "+%d from other apps", s->other_unread);
    ui_set_text(h.foot, other ? t : "");
    lv_obj_set_hidden(h.foot, !other);
    restack();
}

int scr_inbox_hit(int32_t x, int32_t y)
{
    lv_obj_update_layout(h.root);
    for (int i = 0; i < ROWS; i++) {
        lv_area_t a;
        if (lv_obj_is_hidden(h.r[i].row)) continue;
        lv_obj_get_coords(h.r[i].row, &a);
        if (x >= a.x1 && x <= a.x2 && y >= a.y1 && y <= a.y2) return i;
    }
    return -1;
}

lv_obj_t *scr_inbox_create(lv_obj_t *parent)
{
    h.root = ui_plain(parent, UI_SCREEN_SIZE, UI_SCREEN_SIZE);
    h.head = ui_label(h.root, &inter_16, UI_COLOR_ACCENT, 200, 1, LV_TEXT_ALIGN_CENTER);
    for (int i = 0; i < ROWS; i++) {
        lv_obj_t *r = ui_plain(h.root, ROW_W, ROW_H);
        h.r[i].row = r;
        h.r[i].tile = ui_check_create(r, TILE);
        lv_obj_set_pos(h.r[i].tile, 0, (ROW_H - TILE) / 2);
        h.r[i].dot = ui_plain(h.r[i].tile, 12, 12);
        lv_obj_set_style_radius(h.r[i].dot, LV_RADIUS_CIRCLE, 0);
        lv_obj_set_style_bg_opa(h.r[i].dot, LV_OPA_COVER, 0);
        lv_obj_center(h.r[i].dot);
        h.r[i].title = ui_label(r, &inter_20, UI_COLOR_TEXT, ROW_W - TILE - 12, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(h.r[i].title, TILE + 12, 7);
        h.r[i].sub = ui_label(r, &inter_16, UI_COLOR_SUBTLE, ROW_W - TILE - 12, 1, LV_TEXT_ALIGN_LEFT);
        lv_obj_set_pos(h.r[i].sub, TILE + 12, 7 + lv_font_get_line_height(&inter_20) + 2);
    }
    h.foot = ui_label(h.root, &inter_16, UI_COLOR_MUTED, 240, 1, LV_TEXT_ALIGN_CENTER);
    restack();
    return h.root;
}
