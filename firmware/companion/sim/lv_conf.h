/* Reference LVGL 9.6.0 configuration for the Aelys companion UI.
 * Used by the host sim; the firmware's sdkconfig must mirror it. Anything not listed keeps the
 * LVGL default (see lv_conf_internal.h). Only the widgets the UI uses are enabled. */
#ifndef LV_CONF_H
#define LV_CONF_H

/* Core: 16-bit colour, no OS, libc heap (firmware swaps in a PSRAM allocator), 60 fps refresh */
#define LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565
#define LV_USE_OS              LV_OS_NONE
#define LV_USE_STDLIB_MALLOC   LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING   LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF  LV_STDLIB_CLIB
#define LV_DEF_REFR_PERIOD     16
#define LV_DPI_DEF             130
#define LV_USE_LOG             0
#define LV_USE_ASSERT_NULL     1
#define LV_USE_ASSERT_MALLOC   1
#define LV_USE_OBSERVER        0
#define LV_USE_FLOAT           0

/* Software renderer: RGB565 target, ARGB8888 for layers; every other format off */
#define LV_USE_DRAW_SW                      1
#define LV_DRAW_SW_SUPPORT_RGB565           1
#define LV_DRAW_SW_SUPPORT_RGB565_SWAPPED   0
#define LV_DRAW_SW_SUPPORT_RGB565A8         0
#define LV_DRAW_SW_SUPPORT_RGB888           0
#define LV_DRAW_SW_SUPPORT_XRGB8888         0
#define LV_DRAW_SW_SUPPORT_ARGB8888         1
#define LV_DRAW_SW_SUPPORT_ARGB8888_PREMULTIPLIED 0
#define LV_DRAW_SW_SUPPORT_L8               0
#define LV_DRAW_SW_SUPPORT_AL88             0
#define LV_DRAW_SW_SUPPORT_A8               1
#define LV_DRAW_SW_SUPPORT_I1               0
#define LV_USE_DRAW_SW_COMPLEX_GRADIENTS    0
#define LV_USE_VECTOR_GRAPHIC               0
#define LV_USE_SNAPSHOT                     0

/* Fonts: only our generated Inter A8 fonts (components/ui/fonts) */
#define LV_FONT_USE_CUSTOM_INCLUDE   1
#define LV_FONT_CUSTOM_INCLUDE       "ui_lv_font.h"
#define LV_USE_CUSTOM_FONT_DEFAULT   1
#define LV_USE_FONT_COMPRESSED       0
#define LV_USE_FONT_PLACEHOLDER      1

/* No theme, no layouts: screens are positioned by hand and styled by ui_theme_apply() */
#define LV_USE_THEME_DEFAULT   0
#define LV_USE_THEME_SIMPLE    0
#define LV_USE_THEME_MONO      0
#define LV_USE_FLEX            0
#define LV_USE_GRID            0

/* Widgets: label + canvas/image (QR code for pairing, later task); everything else off */
#define LV_USE_LABEL      1
#define LV_USE_IMAGE      1
#define LV_USE_CANVAS     1
#define LV_USE_QRCODE     1
#define LV_USE_ANIMIMG    0
#define LV_USE_ARC        0
#define LV_USE_ARCLABEL   0
#define LV_USE_BAR        0
#define LV_USE_BUTTON     0
#define LV_USE_BUTTONMATRIX 0
#define LV_USE_CALENDAR   0
#define LV_USE_CHART      0
#define LV_USE_CHECKBOX   0
#define LV_USE_DROPDOWN   0
#define LV_USE_IMAGEBUTTON 0
#define LV_USE_KEYBOARD   0
#define LV_USE_LED        0
#define LV_USE_LINE       0
#define LV_USE_LIST       0
#define LV_USE_MENU       0
#define LV_USE_MSGBOX     0
#define LV_USE_ROLLER     0
#define LV_USE_SCALE      0
#define LV_USE_SLIDER     0
#define LV_USE_SPAN       0
#define LV_USE_SPINBOX    0
#define LV_USE_SPINNER    0
#define LV_USE_SWITCH     0
#define LV_USE_TEXTAREA   0
#define LV_USE_TABLE      0
#define LV_USE_TABVIEW    0
#define LV_USE_TILEVIEW   0
#define LV_USE_WIN        0

#endif /* LV_CONF_H */
