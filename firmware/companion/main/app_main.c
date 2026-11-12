#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lvgl.h"

#define FW_VERSION "0.1.0"

static const char *TAG = "companion";

static volatile uint32_t ev_seen;
static void on_event(const ui_event_t *ev) { ev_seen += ev->type == UI_EV_TICK; }

/* TEMPORARY display bench (task 3): a 120 px circle sweeping the whole screen, to time the panel path. */
static void anim_x(void *o, int32_t v) { lv_obj_set_x(o, v); }
static void anim_y(void *o, int32_t v) { lv_obj_set_y(o, v); }

static void bench_setup(void)
{
    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_t *ball = lv_obj_create(scr);
    lv_obj_remove_style_all(ball);
    lv_obj_set_size(ball, 120, 120);
    lv_obj_set_style_radius(ball, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(ball, lv_color_hex(0xB9A8FF), 0);
    lv_obj_set_style_bg_opa(ball, LV_OPA_COVER, 0);
    const struct { lv_anim_exec_xcb_t cb; uint32_t ms; } axes[] = {{anim_x, 1700}, {anim_y, 2300}};
    for (int i = 0; i < 2; i++) {
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, ball);
        lv_anim_set_exec_cb(&a, axes[i].cb);
        lv_anim_set_values(&a, 0, 466 - 120);
        lv_anim_set_duration(&a, axes[i].ms);
        lv_anim_set_reverse_duration(&a, axes[i].ms);
        lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
        lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
        lv_anim_start(&a);
    }
}

void app_main(void)
{
    ESP_LOGW(TAG, "Aelys companion fw %s", FW_VERSION);
    ESP_LOGW(TAG, "psram_size=%u free_internal=%u free_spiram=%u",
             (unsigned)esp_psram_get_size(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    ESP_ERROR_CHECK(board_init());
    lv_port_set_handler(on_event);
    ESP_ERROR_CHECK(lv_port_start(bench_setup));
    ESP_LOGW(TAG, "after lvgl: free_internal=%u largest_internal=%u free_spiram=%u",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        lv_port_post(&(ui_event_t){.type = UI_EV_TICK});
        uint32_t fps_x10, worst_us;
        lv_port_frame_stats(&fps_x10, &worst_us);
        ESP_LOGW(TAG, "fps_x10=%u worst_us=%u ticks=%u free_internal=%u", (unsigned)fps_x10, (unsigned)worst_us,
                 (unsigned)ev_seen,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    }
}
