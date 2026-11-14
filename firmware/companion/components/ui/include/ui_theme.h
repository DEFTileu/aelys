#pragma once
/* Colours and fonts shared by all screens. Source of truth: design CompanionFace.dc.html. */
#include "lvgl.h"

#define UI_COLOR_BG      0x000000 /* AMOLED: black pixels do not light up */
#define UI_COLOR_EYE     0xF4F1FF
#define UI_COLOR_ACCENT  0xB9A8FF
#define UI_COLOR_MUTED   0x8C869A
#define UI_COLOR_DIM     0x625D69
#define UI_COLOR_CHEEK   0xF6907F /* drawn at 55 % opacity */
/* Screens (design "ACTUAL AELYS Companion", section 1 and 10) */
#define UI_COLOR_TEXT    0xF1EEF6
#define UI_COLOR_TEXT2   0xCBC6D5
#define UI_COLOR_SUBTLE  0xA6A0B2
#define UI_COLOR_AMBER   0xF4C46B /* lost mode */
#define UI_COLOR_DANGER  0xFF8A84 /* emergency / ICE */
#define UI_COLOR_DANGER_BG 0x2A1618
#define UI_COLOR_RULE    0x23202B
#define UI_COLOR_ORBIT_OFF 0x2B2836
#define UI_COLOR_QR_LIGHT  0xF1EEF6
#define UI_COLOR_TASK       0x7FA8F5 /* module colour of tasks */
#define UI_COLOR_TASK_TRACK 0x141B2A
#define UI_COLOR_CHECK      0x6A4CF2 /* filled tick box */

/* lv_font_conv 1.5.2 emits non-const font structs for LVGL 9 (see fonts/README.md) */
#define UI_FONT_DECLARE(name) extern lv_font_t name

UI_FONT_DECLARE(inter_16);
UI_FONT_DECLARE(inter_20);
UI_FONT_DECLARE(inter_24);
UI_FONT_DECLARE(inter_28);
UI_FONT_DECLARE(inter_40);
UI_FONT_DECLARE(inter_clock_96); /* digits 0-9, ':' and space only */

/* Black background, light text, Inter 20: call once per screen. */
void ui_theme_apply(lv_obj_t *screen);
