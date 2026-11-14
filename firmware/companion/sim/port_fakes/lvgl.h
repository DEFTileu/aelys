#pragma once
#include "platform.h"
typedef struct lv_display_t lv_display_t;
typedef struct lv_event_t lv_event_t;
typedef struct { int32_t x1, y1, x2, y2; } lv_area_t;
typedef void *lv_mem_pool_t;
typedef int lv_result_t;
typedef struct { size_t total_size, free_size, free_biggest_size; uint8_t used_pct; } lv_mem_monitor_t;
#define LV_RESULT_OK 0
#define LV_DRAW_BUF_ALIGN 4
#define LV_COLOR_FORMAT_RGB565_SWAPPED 0
#define LV_DISPLAY_RENDER_MODE_PARTIAL 0
#define LV_EVENT_INVALIDATE_AREA 0
#define LV_EVENT_REFR_START 1
#define LV_EVENT_REFR_READY 2
#define lv_memzero(p, n) memset((p), 0, (n))
void *lv_event_get_param(lv_event_t *);
int lv_event_get_code(lv_event_t *);
void lv_init(void);
void lv_tick_set_cb(uint32_t (*)(void));
lv_display_t *lv_display_create(int, int);
void lv_display_set_color_format(lv_display_t *, int);
void lv_display_set_buffers(lv_display_t *, void *, void *, size_t, int);
void lv_display_set_flush_cb(lv_display_t *, void (*)(lv_display_t *, const lv_area_t *, uint8_t *));
void lv_display_set_flush_wait_cb(lv_display_t *, void (*)(lv_display_t *));
void lv_display_add_event_cb(lv_display_t *, void (*)(lv_event_t *), int, void *);
uint32_t lv_timer_handler(void);
