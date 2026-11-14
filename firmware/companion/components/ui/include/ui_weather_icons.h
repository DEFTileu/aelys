#pragma once
/* The Weather screen's condition glyphs: A8 images (img_weather_icons.c, tools/gen_weather_icons.py), one per wx_icon_t. */
#include "ui.h"

typedef enum { WX_SUN, WX_CLOUD_SUN, WX_CLOUD, WX_RAIN, WX_SNOW, WX_STORM, WX_FOG, WX_ICON_COUNT } wx_icon_t;

extern const lv_image_dsc_t weather_icon_big[WX_ICON_COUNT];   /* 48 px: the current weather */
extern const lv_image_dsc_t weather_icon_small[WX_ICON_COUNT]; /* 24 px: the hourly row */
