#pragma once
/* Pulled in through LV_FONT_CUSTOM_INCLUDE (see sim/lv_conf.h): Inter 20 is the LVGL default font,
 * so no Montserrat is linked. lv_font_conv 1.5.2 emits non-const font structs for LVGL 9, hence
 * the non-const extern instead of LV_FONT_DECLARE. */
#define LV_FONT_CUSTOM_DECLARE extern lv_font_t inter_20;
#define LV_FONT_DEFAULT        &inter_20
