/* Host regression for the real port. No ESP-IDF, hardware, or LVGL runtime is used.
 * Assumption: a timeout with DMA still active requires fail-closed recovery; this
 * harness models esp_restart() as non-returning. Hardware timing is not tested. */
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>

#include "../components/board/lv_port.c"

static jmp_buf restart_target;
static int token, takes, draws;
static bool complete_on_take;
static bool complete_on_timeout;
static bool complete_in_submit;
static bool complete_on_warning;
static esp_err_t draw_result;
static const lv_area_t area = { 2, 4, 5, 7 };
static uint8_t pixels[32];

#define CHECK(expr) do { if (!(expr)) { \
    fprintf(stderr, "%s:%d: %s\n", __func__, __LINE__, #expr); return 1; \
} } while (0)

void esp_restart(void) { longjmp(restart_target, 1); }
int64_t esp_timer_get_time(void) { return 0; }
void fake_log_warning(const char *tag)
{
    (void)tag;
    if (complete_on_warning) {
        complete_on_warning = false;
        color_done(NULL, NULL, NULL);
    }
}

esp_lcd_panel_handle_t board_panel(void) { return (void *)&token; }
esp_err_t esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t panel, int x1, int y1,
                                    int x2, int y2, const void *px)
{
    if (panel != &token || x1 != 2 || y1 != 4 || x2 != 6 || y2 != 8 || px != pixels) abort();
    draws++;
    if (complete_in_submit) color_done(NULL, NULL, NULL);
    return draw_result;
}

BaseType_t xSemaphoreGiveFromISR(SemaphoreHandle_t sem, BaseType_t *woken)
{
    if (sem != dma_sem) abort();
    token = 1;
    *woken = pdFALSE;
    return pdTRUE;
}

BaseType_t xSemaphoreTake(SemaphoreHandle_t sem, TickType_t timeout)
{
    if (sem != dma_sem || timeout != pdMS_TO_TICKS(100)) abort();
    takes++;
    if (token) { token = 0; return pdTRUE; }
    if (complete_on_take) {
        complete_on_take = false;
        color_done(NULL, NULL, NULL);
        token = 0;
        return pdTRUE;
    }
    if (complete_on_timeout) {
        complete_on_timeout = false;
        color_done(NULL, NULL, NULL);
        return pdFALSE; /* timeout raced with the completion callback */
    }
    return pdFALSE;
}

static void reset_fakes(void)
{
    dma_sem = &token;
    dma_busy = false;
    need_te = false;
    frame_flushed = false;
#ifdef CONFIG_AELYS_PERF_PROBE
    pr_transfer_failed = false;
#endif
    token = takes = draws = 0;
    complete_on_take = complete_on_timeout = complete_in_submit = complete_on_warning = false;
    draw_result = ESP_OK;
}

static int test_normal_completion(void)
{
    reset_fakes();
    flush_cb(NULL, &area, pixels);
    CHECK(draws == 1 && dma_busy && frame_flushed);
    complete_on_take = true;
    flush_wait(NULL);
    CHECK(!dma_busy && takes == 1);
    return 0;
}

static int test_completion_before_wait(void)
{
    reset_fakes();
    flush_wait(NULL);
    CHECK(takes == 0);
    complete_in_submit = true;
    flush_cb(NULL, &area, pixels);
    CHECK(!dma_busy && draws == 1);
    flush_wait(NULL);
    CHECK(takes == 0);
    return 0;
}

static int test_stale_semaphore(void)
{
    reset_fakes();
    token = 1; /* notification from an older transfer */
    flush_cb(NULL, &area, pixels);
    complete_on_take = true;
    flush_wait(NULL);
    CHECK(!dma_busy && takes == 2);
    return 0;
}

static int test_submission_error(void)
{
    reset_fakes();
    draw_result = ESP_ERR_INVALID_STATE;
    if (setjmp(restart_target) == 0) {
        flush_cb(NULL, &area, pixels);
        fprintf(stderr, "submission error must not release uncertain buffer ownership\n");
        return 1;
    }
    CHECK(draws == 1 && dma_busy);
#ifdef CONFIG_AELYS_PERF_PROBE
    CHECK(pr_transfer_failed);
#endif
    return 0;
}

static int test_completion_racing_timeout(void)
{
    reset_fakes();
    flush_cb(NULL, &area, pixels);
    complete_on_timeout = true;
    flush_wait(NULL);
    CHECK(!dma_busy && takes == 1);
    return 0;
}

static int test_timeout_must_not_return_busy(void)
{
    reset_fakes();
    flush_cb(NULL, &area, pixels);
    CHECK(dma_busy);
    if (setjmp(restart_target) == 0) {
        flush_wait(NULL);
        CHECK(!dma_busy); /* returning to LVGL while DMA owns its buffer is unsafe */
        fprintf(stderr, "expected fail-closed restart after DMA timeout\n");
        return 1;
    }
    CHECK(dma_busy && takes == 1);
#ifdef CONFIG_AELYS_PERF_PROBE
    CHECK(pr_transfer_failed);
#endif
    return 0;
}

static int test_completion_after_recovery_decision(void)
{
    reset_fakes();
    flush_cb(NULL, &area, pixels);
    complete_on_warning = true; /* completion after the final busy check */
    if (setjmp(restart_target) == 0) {
        flush_wait(NULL);
        fprintf(stderr, "committed timeout recovery unexpectedly returned\n");
        return 1;
    }
    CHECK(!dma_busy && takes == 1);
    return 0;
}

int main(void)
{
    struct { const char *name; int (*run)(void); } cases[] = {
        { "normal completion", test_normal_completion },
        { "completion before wait", test_completion_before_wait },
        { "stale semaphore", test_stale_semaphore },
        { "completion races timeout", test_completion_racing_timeout },
        { "submission error", test_submission_error },
        { "timeout must not return busy", test_timeout_must_not_return_busy },
        { "completion after recovery decision", test_completion_after_recovery_decision },
    };
    int failures = 0;
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        int failed = cases[i].run();
        printf("%s: %s\n", failed ? "FAIL" : "PASS", cases[i].name);
        failures += failed;
    }
    return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
