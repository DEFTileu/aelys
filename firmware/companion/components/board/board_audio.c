/* On-demand ES8311 output and ES7210 capture on the shared I2S0 bus.
 * The control mutex serializes lifecycle transitions; lock protects task and
 * ring ownership. The UI stop path only sets atomics. Capture stop joins the
 * worker, including any in-flight callback; callbacks must return and must not
 * call a lifecycle function that joins the capture worker itself. */
#include <stdatomic.h>
#include <string.h>
#include "beep.h"
#include "sfx.h"
#include "board.h"
#include "board_pins.h"
#include "driver/i2s_std.h"
#include "esp_check.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_private/esp_gpio_reserve.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define BEEP_VOLUME 80       /* esp_codec_dev 0..100: tune on the board; the tone itself peaks at 73 % of full scale */
#define VOICE_VOLUME 65      /* initial value; calibrate on the board */
#define VOICE_RING_BYTES (128 * 1024)
#define VOICE_CAPTURE_MAX_SAMPLES (20 * BEEP_RATE_HZ)
#define SFX_VOLUME 65        /* the small sounds: quieter than "find me" (shortcut: a first guess, tune it by ear on the board) */
#define AUDIO_TASK_PRIO 3
#define AUDIO_TASK_STACK 5120
#define LEAD_CHUNKS 2        /* 20 ms of silence before and after: the amplifier switches on/off without a pop on the first/last cycle */
#define I2S_PORT I2S_NUM_0

static const char *TAG = "audio";

typedef struct {
    i2s_chan_handle_t tx;
    i2s_chan_handle_t rx;
    const audio_codec_gpio_if_t *gpio;
    const audio_codec_data_if_t *data;
    const audio_codec_if_t *codec;
    esp_codec_dev_handle_t dev;
    bool opened; /* esp_codec_dev_open succeeded: its close stops the I2S channel */
} audio_t;

/* The codec's I2C control interface (one device on the shared bus) is created at the first sound and kept: removing it after every sound
 * collides now and then with a touch / battery transaction of another task ("Wrong I2C status, cannot delete device"), which also leaks the
 * device. Cost: one i2c device + 32 B of heap after the first sound. Only the audio task touches it, and one audio task runs at a time. */
static const audio_codec_ctrl_if_t *ctrl;
#if CONFIG_CODEC_ES7210_SUPPORT
static const audio_codec_ctrl_if_t *mic_ctrl;
#endif

static StaticSemaphore_t lock_buf;
static SemaphoreHandle_t lock;       /* created by board_audio_init() at boot, before the link and ui tasks start */
static TaskHandle_t task;            /* guarded by `lock` */
static atomic_bool stop_req;
static atomic_uint gen;              /* bumped by every request: the task restarts its clock when it changes */
static atomic_uint want_ms;
static StaticSemaphore_t control_buf;
static SemaphoreHandle_t control; /* serializes lifecycle calls; never taken by a worker or push */
static atomic_bool voice_active;
static atomic_bool voice_end;
static atomic_uint cancel_epoch;
static portMUX_TYPE cancel_mux = portMUX_INITIALIZER_UNLOCKED;
static bool voice_worker, voice_capture; /* protected by lock */
static uint8_t *voice_ring; /* protected by lock, including its entire lifetime */
static size_t ring_head, ring_tail, ring_used;
static unsigned voice_generation; /* protected by lock; rejects writers from an old stream */
static audio_t voice_audio;
static void (*voice_callback)(const int16_t *, size_t);
static atomic_uint want_sfx;         /* SFX_NONE: the find beeps; otherwise the sound effect to play */

static void audio_close(audio_t *a)
{
    if (a->dev) { esp_codec_dev_close(a->dev); esp_codec_dev_delete(a->dev); } /* switches the amplifier off, stops the I2S channel */
    if (a->codec) audio_codec_delete_codec_if(a->codec);
    if (a->gpio) audio_codec_delete_gpio_if(a->gpio);
    if (a->data) audio_codec_delete_data_if(a->data);
    if (a->rx) {
        if (!a->opened) i2s_channel_disable(a->rx);
        i2s_del_channel(a->rx);
    }
    if (a->tx) {
        if (!a->opened || a->rx) i2s_channel_disable(a->tx); /* never opened: the channel is still running (close stops it otherwise) */
        i2s_del_channel(a->tx);
    }
    if (a->gpio) esp_gpio_revoke(1ULL << PIN_PA_EN); /* the codec's gpio_config reserved the pin; without this the next setup logs "conflict found" */
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
    if (!ctrl) ctrl = audio_codec_new_i2c_ctrl(&cfg_i2c);
    if (!a->data || !a->gpio || !ctrl) return ESP_ERR_NO_MEM;
    es8311_codec_cfg_t ec = {
        .ctrl_if = ctrl, .gpio_if = a->gpio, .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC,
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
    sfx_t snd = (sfx_t)atomic_load(&want_sfx);
    bool found = snd == SFX_NONE; /* this task played the find beeps, so it ends the overlay */
    sfx_player_t pl;
    sfx_start(&pl, snd);
    ESP_LOGW(TAG, "start: free_internal=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    bool ok = audio_open(&a) == ESP_OK;
    if (!ok) ESP_LOGW(TAG, "codec or I2S did not start");
    else if (snd != SFX_NONE) esp_codec_dev_set_out_vol(a.dev, SFX_VOLUME);
    for (int i = 0; ok && i < LEAD_CHUNKS; i++) ok = play_chunk(&a, buf, &phase, false);
    for (;;) {
        uint32_t g = atomic_load(&gen);
        if (g != seen) { /* asked again: the clock restarts, maybe with the other kind of sound */
            seen = g; chunk = 0; total = atomic_load(&want_ms);
            sfx_t next = (sfx_t)atomic_load(&want_sfx);
            if (ok && (next == SFX_NONE) != (snd == SFX_NONE)) esp_codec_dev_set_out_vol(a.dev, next == SFX_NONE ? BEEP_VOLUME : SFX_VOLUME);
            snd = next;
            found |= snd == SFX_NONE;
            sfx_start(&pl, snd);
        }
        bool sfx_more = ok && snd != SFX_NONE && !atomic_load(&stop_req) && sfx_fill(&pl, buf, BEEP_CHUNK_FRAMES);
        beep_phase_t ph = !ok || atomic_load(&stop_req) ? BEEP_DONE
                          : snd != SFX_NONE           ? (sfx_more ? BEEP_ON : BEEP_DONE)
                                                      : beep_phase(chunk * BEEP_CHUNK_MS, total);
        if (ph == BEEP_DONE) {
            xSemaphoreTake(lock, portMAX_DELAY);
            if (ok && atomic_load(&gen) != seen) { xSemaphoreGive(lock); continue; } /* asked again while finishing */
            break; /* lock held through teardown */
        }
        if (snd != SFX_NONE) ok = esp_codec_dev_write(a.dev, buf, sizeof buf) == ESP_CODEC_DEV_OK; /* sfx_fill wrote buf */
        else ok = play_chunk(&a, buf, &phase, ph == BEEP_ON);
        if (!ok) ESP_LOGW(TAG, "write failed");
        chunk++;
    }
    for (int i = 0; a.dev && ok && i < LEAD_CHUNKS; i++) play_chunk(&a, buf, &phase, false);
    audio_close(&a);
    atomic_store(&stop_req, false);
    ESP_LOGW(TAG, "end: stack_free=%u free_internal=%u", (unsigned)uxTaskGetStackHighWaterMark(NULL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL)); /* before the task's own memory is freed */
    task = NULL;
    if (found) post_find(false);
    xSemaphoreGive(lock);
    vTaskDelete(NULL);
}

/* The capture channel pair has 3 x 120 x 4 bytes per direction: 2880 bytes
 * total DMA payload. The unused TX channel supplies the shared master clock. */
static esp_err_t capture_open(audio_t *a)
{
#if !CONFIG_CODEC_ES7210_SUPPORT
    (void)a;
    return ESP_ERR_NOT_SUPPORTED;
#else
    i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    cc.dma_desc_num = 3;
    cc.dma_frame_num = 120;
    cc.auto_clear_after_cb = true;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&cc, &a->tx, &a->rx), TAG, "capture channels");
    const i2s_std_config_t sc = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(BEEP_RATE_HZ),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = { .mclk = PIN_I2S_MCLK, .bclk = PIN_I2S_BCLK, .ws = PIN_I2S_WS,
                      .dout = I2S_GPIO_UNUSED, .din = PIN_I2S_DIN },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(a->tx, &sc), TAG, "capture tx init");
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(a->rx, &sc), TAG, "capture rx init");
    ESP_RETURN_ON_ERROR(i2s_channel_enable(a->tx), TAG, "capture clock");
    ESP_RETURN_ON_ERROR(i2s_channel_enable(a->rx), TAG, "capture rx enable");
    audio_codec_i2s_cfg_t ic = { .port = I2S_PORT, .tx_handle = a->tx, .rx_handle = a->rx };
    a->data = audio_codec_new_i2s_data(&ic);
    audio_codec_i2c_cfg_t i2c = { .port = I2C_NUM_0, .addr = I2C_ADDR_ES7210 << 1,
                                  .bus_handle = board_i2c_bus(), .clock_speed_hz = 400000 };
    if (!mic_ctrl) mic_ctrl = audio_codec_new_i2c_ctrl(&i2c);
    if (!a->data || !mic_ctrl) return ESP_ERR_NO_MEM;
    es7210_codec_cfg_t ec = { .ctrl_if = mic_ctrl, .master_mode = false,
                             .mic_selected = ES7210_SEL_MIC1 | ES7210_SEL_MIC2 };
    a->codec = es7210_codec_new(&ec);
    if (!a->codec) return ESP_FAIL;
    esp_codec_dev_cfg_t dc = { .dev_type = ESP_CODEC_DEV_TYPE_IN, .codec_if = a->codec, .data_if = a->data };
    a->dev = esp_codec_dev_new(&dc);
    if (!a->dev) return ESP_ERR_NO_MEM;
    esp_codec_dev_sample_info_t fs = { .bits_per_sample = 16, .channel = 2, .sample_rate = BEEP_RATE_HZ };
    if (esp_codec_dev_open(a->dev, &fs) != ESP_CODEC_DEV_OK) return ESP_FAIL;
    a->opened = true;
    if (esp_codec_dev_set_in_gain(a->dev, 24.0f) != ESP_CODEC_DEV_OK) return ESP_FAIL;
    return ESP_OK;
#endif
}

/* One worker owns the codec. Push never keeps a ring pointer after unlocking. */
static void voice_task(void *arg)
{
    bool capture = (bool)(uintptr_t)arg;
    int16_t stereo[2 * BEEP_CHUNK_FRAMES];
    int16_t mono[BEEP_CHUNK_FRAMES];
    if (capture) {
        size_t captured = 0;
        while (!atomic_load(&stop_req) && captured < VOICE_CAPTURE_MAX_SAMPLES) {
            size_t got = 0;
            esp_err_t e = i2s_channel_read(voice_audio.rx, stereo, sizeof stereo, &got, 30);
            if (e != ESP_OK && e != ESP_ERR_TIMEOUT) break;
            size_t frames = got / (2 * sizeof(int16_t));
            size_t remaining = VOICE_CAPTURE_MAX_SAMPLES - captured;
            if (frames > remaining) frames = remaining;
            for (size_t i = 0; i < frames; ++i) mono[i] = stereo[2 * i]; /* MIC1; calibrate */
            if (frames && !atomic_load(&stop_req)) {
                voice_callback(mono, frames);
                captured += frames;
            }
        }
    } else {
        while (!atomic_load(&stop_req)) {
            xSemaphoreTake(lock, portMAX_DELAY);
            size_t n = ring_used < sizeof mono ? ring_used : sizeof mono;
            for (size_t i = 0; i < n; ++i) {
                ((uint8_t *)mono)[i] = voice_ring[ring_tail];
                ring_tail = (ring_tail + 1) % VOICE_RING_BYTES;
            }
            ring_used -= n;
            bool done = atomic_load(&voice_end) && ring_used == 0;
            xSemaphoreGive(lock);
            for (size_t i = 0; i < n / sizeof(int16_t); ++i) stereo[2*i] = stereo[2*i+1] = mono[i];
            if (n && !atomic_load(&stop_req) &&
                esp_codec_dev_write(voice_audio.dev, stereo, n * 2) != ESP_CODEC_DEV_OK) break;
            if (done) {
                /* i2s_channel_write queues into DMA; allow the last queued frames
                 * to reach the codec, but let find/stop interrupt the drain. */
                for (int i = 0; i < 4 && !atomic_load(&stop_req); ++i)
                    vTaskDelay(pdMS_TO_TICKS(10));
                break;
            }
            if (!n) vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
    xSemaphoreTake(lock, portMAX_DELAY);
    audio_close(&voice_audio);
    if (voice_ring) heap_caps_free(voice_ring);
    voice_ring = NULL;
    ring_head = ring_tail = ring_used = 0;
    ++voice_generation;
    if (!capture) atomic_store(&voice_active, false);
    voice_worker = false;
    task = NULL;
    xSemaphoreGive(lock);
    vTaskDelete(NULL);
}

/* control must be held. Wait until the worker has finished callbacks and teardown. */
static void stop_worker(void)
{
    atomic_store(&stop_req, true);
    for (;;) {
        xSemaphoreTake(lock, portMAX_DELAY);
        bool done = task == NULL;
        xSemaphoreGive(lock);
        if (done) break;
        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

bool board_audio_voice_active(void) { return atomic_load(&voice_active); }

esp_err_t board_audio_listen(void (*on_pcm)(const int16_t *, size_t))
{
    if (!on_pcm) return ESP_ERR_INVALID_ARG;
    if (!control) return ESP_ERR_INVALID_STATE;
    xSemaphoreTake(control, portMAX_DELAY);
    unsigned epoch = atomic_load(&cancel_epoch);
    stop_worker();
    xSemaphoreTake(lock, portMAX_DELAY);
    portENTER_CRITICAL(&cancel_mux);
    bool canceled = epoch != atomic_load(&cancel_epoch);
    if (!canceled) {
        atomic_store(&voice_active, true);
        atomic_store(&stop_req, false);
    }
    portEXIT_CRITICAL(&cancel_mux);
    if (canceled) { xSemaphoreGive(lock); xSemaphoreGive(control); return ESP_ERR_INVALID_STATE; }
    atomic_store(&voice_end, false);
    ++voice_generation;
    voice_callback = on_pcm;
    esp_err_t e = capture_open(&voice_audio);
    if (e == ESP_OK && xTaskCreate(voice_task, "audio_rx", AUDIO_TASK_STACK, (void *)(uintptr_t)1,
                                  AUDIO_TASK_PRIO, &task) != pdPASS) e = ESP_ERR_NO_MEM;
    if (e != ESP_OK) { audio_close(&voice_audio); atomic_store(&voice_active, false); }
    else { voice_worker = true; voice_capture = true; }
    xSemaphoreGive(lock);
    xSemaphoreGive(control);
    return e;
}

void board_audio_listen_stop(void)
{
    if (!control) return;
    xSemaphoreTake(control, portMAX_DELAY);
    xSemaphoreTake(lock, portMAX_DELAY);
    bool capturing = voice_worker && voice_capture;
    xSemaphoreGive(lock);
    if (capturing) stop_worker(); /* session remains open during thinking */
    xSemaphoreGive(control);
}

esp_err_t board_audio_play_begin(void)
{
    if (!control) return ESP_ERR_INVALID_STATE;
    if (xSemaphoreTake(control, 0) != pdTRUE) return ESP_ERR_INVALID_STATE;
    unsigned epoch = atomic_load(&cancel_epoch);
    xSemaphoreTake(lock, portMAX_DELAY);
    if (!atomic_load(&voice_active) || atomic_load(&voice_end)) {
        xSemaphoreGive(lock);
        xSemaphoreGive(control);
        return ESP_ERR_INVALID_STATE;
    }
    if (voice_ring && !atomic_load(&stop_req)) {
        xSemaphoreGive(lock);
        xSemaphoreGive(control);
        return ESP_OK;
    }
    /* Never join a capture worker here: its callback may be sending through
     * a WebSocket lock held by the caller. The link must stop capture first. */
    if (task) {
        xSemaphoreGive(lock);
        xSemaphoreGive(control);
        return ESP_ERR_INVALID_STATE;
    }
    portENTER_CRITICAL(&cancel_mux);
    bool canceled = !atomic_load(&voice_active) || epoch != atomic_load(&cancel_epoch);
    if (!canceled) atomic_store(&stop_req, false);
    portEXIT_CRITICAL(&cancel_mux);
    if (canceled) {
        xSemaphoreGive(lock);
        xSemaphoreGive(control);
        return ESP_ERR_INVALID_STATE;
    }
    atomic_store(&voice_end, false);
    ++voice_generation;
    voice_ring = heap_caps_malloc(VOICE_RING_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    esp_err_t e = voice_ring ? audio_open(&voice_audio) : ESP_ERR_NO_MEM;
    if (e == ESP_OK) {
        esp_codec_dev_set_out_vol(voice_audio.dev, VOICE_VOLUME);
        if (xTaskCreate(voice_task, "audio_tx", AUDIO_TASK_STACK, NULL, AUDIO_TASK_PRIO, &task) != pdPASS)
            e = ESP_ERR_NO_MEM;
    }
    if (e != ESP_OK) {
        audio_close(&voice_audio);
        heap_caps_free(voice_ring); voice_ring = NULL;
        atomic_store(&voice_active, false);
    } else { voice_worker = true; voice_capture = false; }
    xSemaphoreGive(lock);
    xSemaphoreGive(control);
    return e;
}

bool board_audio_play_push(const uint8_t *pcm, size_t len, uint32_t wait_ms)
{
    if (!lock || !pcm || !len || (len & 1) || len > VOICE_RING_BYTES) return false;
    TickType_t started = xTaskGetTickCount();
    TickType_t wait = pdMS_TO_TICKS(wait_ms);
    xSemaphoreTake(lock, portMAX_DELAY);
    unsigned generation = voice_generation;
    for (;;) {
        if (!voice_ring || atomic_load(&stop_req) || atomic_load(&voice_end) || generation != voice_generation) break;
        if (VOICE_RING_BYTES - ring_used >= len) {
            size_t first = VOICE_RING_BYTES - ring_head;
            if (first > len) first = len;
            memcpy(voice_ring + ring_head, pcm, first);
            memcpy(voice_ring, pcm + first, len - first);
            ring_head = (ring_head + len) % VOICE_RING_BYTES;
            ring_used += len;
            xSemaphoreGive(lock);
            return true;
        }
        xSemaphoreGive(lock);
        if ((TickType_t)(xTaskGetTickCount() - started) >= wait) return false;
        vTaskDelay(pdMS_TO_TICKS(1));
        xSemaphoreTake(lock, portMAX_DELAY);
    }
    xSemaphoreGive(lock);
    return false;
}

void board_audio_play_end(void)
{
    if (!lock) return;
    xSemaphoreTake(lock, portMAX_DELAY);
    if (voice_ring) atomic_store(&voice_end, true); /* worker drains and closes */
    else atomic_store(&voice_active, false); /* text-only turn */
    xSemaphoreGive(lock);
}

esp_err_t board_audio_beep(uint32_t duration_ms)
{
    if (duration_ms == 0) return ESP_ERR_INVALID_ARG;
    if (!lock) return ESP_ERR_INVALID_STATE; /* board_audio_init() not called */
    xSemaphoreTake(control, portMAX_DELAY);
    xSemaphoreTake(lock, portMAX_DELAY);
    bool stopping_voice = voice_worker;
    atomic_store(&voice_active, false);
    xSemaphoreGive(lock);
    if (stopping_voice) stop_worker();
    xSemaphoreTake(lock, portMAX_DELAY); /* waits only while a finished sound is torn down */
    atomic_store(&stop_req, false);
    atomic_store(&want_ms, duration_ms > BEEP_MAX_MS ? BEEP_MAX_MS : duration_ms);
    atomic_store(&want_sfx, SFX_NONE);
    atomic_fetch_add(&gen, 1);
    esp_err_t e = ESP_OK;
    if (!task && xTaskCreate(audio_task, "audio", AUDIO_TASK_STACK, NULL, AUDIO_TASK_PRIO, &task) != pdPASS) {
        task = NULL;
        e = ESP_ERR_NO_MEM;
    }
    if (e == ESP_OK) post_find(true); /* the overlay follows the sound; a later init failure ends it with the task's FIND(0) */
    xSemaphoreGive(lock);
    xSemaphoreGive(control);
    return e;
}

void board_audio_init(void)
{
    if (!lock) lock = xSemaphoreCreateMutexStatic(&lock_buf);
    if (!control) control = xSemaphoreCreateMutexStatic(&control_buf);
}

void board_audio_stop(void)
{
    portENTER_CRITICAL(&cancel_mux);
    atomic_fetch_add(&cancel_epoch, 1);
    atomic_store(&voice_active, false);
    atomic_store(&stop_req, true); /* worker owns teardown; safe for the UI task */
    portEXIT_CRITICAL(&cancel_mux);
}

void board_audio_sfx(uint8_t id)
{
    if (id == SFX_NONE || id >= SFX_COUNT) return;
    if (!lock) return;
    if (xSemaphoreTake(lock, 0) != pdTRUE) return; /* a sound is being torn down: drop this one rather than stall the ui */
    if (atomic_load(&voice_active) || voice_worker) { xSemaphoreGive(lock); return; }
    if (task && atomic_load(&want_sfx) == SFX_NONE) { xSemaphoreGive(lock); return; } /* "find me" is beeping: never cut it short */
    atomic_store(&stop_req, false);
    atomic_store(&want_sfx, id);
    atomic_fetch_add(&gen, 1);
    if (!task && xTaskCreate(audio_task, "audio", AUDIO_TASK_STACK, NULL, AUDIO_TASK_PRIO, &task) != pdPASS) task = NULL;
    xSemaphoreGive(lock);
}
