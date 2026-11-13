/* "Find Aelys": the beep pattern of beep.h through the ES8311 and the speaker. Everything (I2S channel, codec, amplifier, the task itself) exists
 * only while a sound plays. Pins: board_pins.h (Waveshare BSP waveshare/esp32_s3_touch_amoled_1_75c 3.0.0). The codec layer is
 * espressif/esp_codec_dev (the one that BSP uses; espressif/es8311 1.0.0~1 needs IDF < 6 and the legacy I2C driver).
 *
 * Threads: board_audio_beep() is called from one task (the link task), board_audio_stop() from any. `stop_req` and `gen` are atomics the audio
 * task polls every 10 ms chunk; `lock` orders a new request against the end of the task: the task takes it before it decides to finish and
 * keeps it through teardown, so a request that arrives meanwhile either restarts the sound (it sees `gen` change) or waits for the teardown. */
#include <stdatomic.h>
#include "beep.h"
#include "board.h"
#include "board_pins.h"
#include "driver/i2s_std.h"
#include "esp_check.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define BEEP_VOLUME 80       /* esp_codec_dev 0..100: tune on the board; the tone itself peaks at 73 % of full scale */
#define AUDIO_TASK_PRIO 3
#define AUDIO_TASK_STACK 5120
#define LEAD_CHUNKS 2        /* 20 ms of silence before and after: the amplifier switches on/off without a pop on the first/last cycle */
#define I2S_PORT I2S_NUM_0

static const char *TAG = "audio";

typedef struct {
    i2s_chan_handle_t tx;
    const audio_codec_ctrl_if_t *ctrl;
    const audio_codec_gpio_if_t *gpio;
    const audio_codec_data_if_t *data;
    const audio_codec_if_t *codec;
    esp_codec_dev_handle_t dev;
    bool opened; /* esp_codec_dev_open succeeded: its close stops the I2S channel */
} audio_t;

static StaticSemaphore_t lock_buf;
static SemaphoreHandle_t lock;       /* created by the first board_audio_beep() */
static TaskHandle_t task;            /* guarded by `lock` */
static atomic_bool stop_req;
static atomic_uint gen;              /* bumped by every request: the task restarts its clock when it changes */
static atomic_uint want_ms;

static void audio_close(audio_t *a)
{
    if (a->dev) { esp_codec_dev_close(a->dev); esp_codec_dev_delete(a->dev); } /* switches the amplifier off, stops the I2S channel */
    if (a->codec) audio_codec_delete_codec_if(a->codec);
    if (a->ctrl) audio_codec_delete_ctrl_if(a->ctrl);                          /* removes the codec's device from the shared I2C bus */
    if (a->gpio) audio_codec_delete_gpio_if(a->gpio);
    if (a->data) audio_codec_delete_data_if(a->data);
    if (a->tx) {
        if (!a->opened) i2s_channel_disable(a->tx); /* never opened: the channel is still running (close stops it otherwise) */
        i2s_del_channel(a->tx);
    }
    *a = (audio_t){0};
}

static esp_err_t audio_open(audio_t *a)
{
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    cc.dma_desc_num = 4;                       /* small, internal: 4 x 160 frames x 4 bytes = 2.5 KB */
    cc.dma_frame_num = BEEP_CHUNK_FRAMES;
    cc.auto_clear_after_cb = true;             /* an underrun is silence, not a repeated buffer */
    ESP_RETURN_ON_ERROR(i2s_new_channel(&cc, &a->tx, NULL), TAG, "i2s channel");
    const i2s_std_config_t sc = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(BEEP_RATE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = PIN_I2S_MCLK, .bclk = PIN_I2S_BCLK, .ws = PIN_I2S_WS, .dout = PIN_I2S_DOUT, .din = I2S_GPIO_UNUSED },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(a->tx, &sc), TAG, "i2s init");
    ESP_RETURN_ON_ERROR(i2s_channel_enable(a->tx), TAG, "i2s enable"); /* esp_codec_dev expects an enabled channel, as in the BSP */

    audio_codec_i2s_cfg_t ic = { .port = I2S_PORT, .tx_handle = a->tx };
    a->data = audio_codec_new_i2s_data(&ic);
    a->gpio = audio_codec_new_gpio();
    audio_codec_i2c_cfg_t cfg_i2c = { .port = I2C_NUM_0, .addr = I2C_ADDR_ES8311 << 1, .bus_handle = board_i2c_bus(),
                                      .clock_speed_hz = 400000 }; /* like the other devices on the bus */
    a->ctrl = audio_codec_new_i2c_ctrl(&cfg_i2c);
    if (!a->data || !a->gpio || !a->ctrl) return ESP_ERR_NO_MEM;
    es8311_codec_cfg_t ec = {
        .ctrl_if = a->ctrl, .gpio_if = a->gpio, .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
        .pa_pin = PIN_PA_EN, .pa_reverted = false, .master_mode = false, .use_mclk = true,
        .hw_gain = { .pa_voltage = 5.0f, .codec_dac_voltage = 3.3f }, /* as the BSP */
    };
    a->codec = es8311_codec_new(&ec);
    if (!a->codec) return ESP_FAIL;
    esp_codec_dev_cfg_t dc = { .dev_type = ESP_CODEC_DEV_TYPE_OUT, .codec_if = a->codec, .data_if = a->data };
    a->dev = esp_codec_dev_new(&dc);
    if (!a->dev) return ESP_ERR_NO_MEM;
    esp_codec_dev_sample_info_t fs = { .bits_per_sample = 16, .channel = 2, .sample_rate = BEEP_RATE_HZ };
    if (esp_codec_dev_open(a->dev, &fs) != ESP_CODEC_DEV_OK) return ESP_FAIL; /* also switches the amplifier on */
    a->opened = true;
    esp_codec_dev_set_out_vol(a->dev, BEEP_VOLUME);
    return ESP_OK;
}

/* The ui task drains this queue; both ends of a sound must reach it or the overlay would be wrong. Always posted under `lock`: the old
 * sound's FIND(0) goes out before the lock is released, a new request's FIND(1) after it is taken, so the ui task sees them in that order. */
static void post_find(bool on)
{
    ui_event_t ev = { .type = UI_EV_FIND, .len = 1, .data = { on } };
    for (int i = 0; i < 50 && !lv_port_post(&ev); i++) vTaskDelay(pdMS_TO_TICKS(10));
}

static bool play_chunk(audio_t *a, int16_t *buf, uint32_t *phase, bool on)
{
    beep_fill(buf, BEEP_CHUNK_FRAMES, phase, on);
    return esp_codec_dev_write(a->dev, buf, 2 * sizeof(int16_t) * BEEP_CHUNK_FRAMES) == ESP_CODEC_DEV_OK;
}

static void audio_task(void *arg)
{
    (void)arg;
    audio_t a = {0};
    int16_t buf[2 * BEEP_CHUNK_FRAMES];
    uint32_t phase = 0, chunk = 0, seen = atomic_load(&gen), total = atomic_load(&want_ms);
    ESP_LOGW(TAG, "start: free_internal=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    bool ok = audio_open(&a) == ESP_OK;
    if (!ok) ESP_LOGW(TAG, "codec or I2S did not start");
    for (int i = 0; ok && i < LEAD_CHUNKS; i++) ok = play_chunk(&a, buf, &phase, false);
    for (;;) {
        uint32_t g = atomic_load(&gen);
        if (g != seen) { seen = g; chunk = 0; total = atomic_load(&want_ms); } /* asked again: the clock restarts */
        beep_phase_t ph = !ok || atomic_load(&stop_req) ? BEEP_DONE : beep_phase(chunk * BEEP_CHUNK_MS, total);
        if (ph == BEEP_DONE) {
            xSemaphoreTake(lock, portMAX_DELAY);
            if (ok && atomic_load(&gen) != seen) { xSemaphoreGive(lock); continue; } /* asked again while finishing */
            break; /* lock held through teardown */
        }
        ok = play_chunk(&a, buf, &phase, ph == BEEP_ON);
        if (!ok) ESP_LOGW(TAG, "write failed");
        chunk++;
    }
    for (int i = 0; a.dev && ok && i < LEAD_CHUNKS; i++) play_chunk(&a, buf, &phase, false);
    audio_close(&a);
    atomic_store(&stop_req, false);
    ESP_LOGW(TAG, "end: stack_free=%u free_internal=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL)); /* before the task's own memory is freed */
    task = NULL;
    post_find(false);
    xSemaphoreGive(lock);
    vTaskDelete(NULL);
}

esp_err_t board_audio_beep(uint32_t duration_ms)
{
    if (duration_ms == 0) return ESP_ERR_INVALID_ARG;
    if (!lock) lock = xSemaphoreCreateMutexStatic(&lock_buf); /* one caller: no race */
    xSemaphoreTake(lock, portMAX_DELAY); /* waits only while a finished sound is torn down */
    atomic_store(&stop_req, false);
    atomic_store(&want_ms, duration_ms > BEEP_MAX_MS ? BEEP_MAX_MS : duration_ms);
    atomic_fetch_add(&gen, 1);
    esp_err_t e = ESP_OK;
    if (!task && xTaskCreate(audio_task, "audio", AUDIO_TASK_STACK, NULL, AUDIO_TASK_PRIO, &task) != pdPASS) {
        task = NULL;
        e = ESP_ERR_NO_MEM;
    }
    if (e == ESP_OK) post_find(true); /* the overlay follows the sound; a later init failure ends it with the task's FIND(0) */
    xSemaphoreGive(lock);
    return e;
}

void board_audio_stop(void) { atomic_store(&stop_req, true); }
