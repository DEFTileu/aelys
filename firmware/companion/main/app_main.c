#include <string.h>

#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "identity.h"
#include "link.h"
#include "metrics.h"
#include "net.h"
#include "owner.h"
#include "store_nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ui.h"

#define FW_VERSION "0.1.0"

static const char *TAG = "companion";

static owner_info_t owner;
static lost_state_t lost;
static settings_t settings;
static bool first_boot, boot_paired; /* first_boot: unpaired and no saved Wi-Fi, home shows the welcome */

static bool lost_is_on(void) { return lost.on; }

#ifndef CONFIG_AELYS_NO_WIFI
/* Command handlers (link task, the only writer of owner/lost/settings once the link runs). Never call LVGL from here: owner data goes
 * through ui_owner_tb, the rest as UI events. Every command is acked, a stale rev too; a state is saved exactly when its apply
 * function returns true. */
static void post_ui(ui_event_t ev)
{
    for (int i = 0; i < 10 && !lv_port_post(&ev); i++) vTaskDelay(pdMS_TO_TICKS(10)); /* queue of 16 is full: the ui task is busy */
}

static void publish_owner(void) /* what the lost and ICE screens show: lost.shown while lost, else the owner's data */
{
    *(owner_info_t *)tribuf_back(&ui_owner_tb) = lost.on ? lost.shown : owner;
    tribuf_publish(&ui_owner_tb);
    post_ui((ui_event_t){.type = UI_EV_OWNER});
}

static void warn_save(const char *what, esp_err_t e)
{
    if (e != ESP_OK) ESP_LOGW(TAG, "%s not saved: %s", what, esp_err_to_name(e)); /* the change stays live until the next reboot */
}

static void restart_soon(void)
{
    vTaskDelay(pdMS_TO_TICKS(500)); /* the ack (already sent) and the logs get out */
    esp_restart();
}

static void unpair_board(void)
{
    link_unpair(); /* pairing, revs, cached snapshot */
    warn_save("unpair wipe", store_erase_device_data()); /* Wi-Fi list, owner, lost, settings, snap */
    owner_defaults(&owner);
    memset(&lost, 0, sizeof lost);
    settings_defaults(&settings);
}

static void on_command(const proto_msg_t *m)
{
    const char *id = m->id;
    switch (m->u.cmd.name) {
    case CMD_LOST_MODE:
        if (owner_apply_lost(&lost, &owner, &m->u.cmd.a.lost)) {
            warn_save("lost", store_save_lost(&lost));
            publish_owner();
            post_ui((ui_event_t){.type = UI_EV_LOST, .len = 1, .data = {lost.on}});
        }
        link_send_ack(id, true, NULL);
        break;
    case CMD_ICE_UPDATE:
        if (owner_apply_ice(&owner, &lost, &m->u.cmd.a.ice)) {
            warn_save("owner", store_save_owner(&owner)); /* owner first, then lost */
            if (lost.on) warn_save("lost", store_save_lost(&lost));
            publish_owner();
        }
        link_send_ack(id, true, NULL);
        break;
    case CMD_SETTINGS:
        if (settings_apply(&settings, m->u.cmd.a.settings.brightness, m->u.cmd.a.settings.rev)) {
            warn_save("settings", store_save_settings(&settings));
            warn_save("brightness", board_display_set_brightness(settings.brightness));
        }
        link_send_ack(id, true, NULL);
        break;
    case CMD_RESTART:
        link_send_ack(id, true, NULL);
        restart_soon();
        break;
    case CMD_UNPAIR:
        link_send_ack(id, true, NULL); /* before the wipe: the server revokes the board right after sending the command */
        unpair_board();
        restart_soon(); /* first boot: no pairing, no Wi-Fi, the welcome screen */
        break;
    default: /* play_sound, wifi_*: later tasks */
        link_send_ack(id, false, "UNSUPPORTED");
        break;
    }
}
/* Lost mode shows no cached data. A session that was running before the power cut is not running now: drop it. */
static bool load_snap(snap_t *s)
{
    if (lost.on || !store_load_snap(s)) return false;
    s->focus.status = FOCUS_NONE;
    return true;
}
static void erase_snap(void)
{
    if (store_erase_snap() != ESP_OK) ESP_LOGW(TAG, "cached snapshot not erased"); /* flash may keep the old owner's data */
}
static void save_snap(const snap_t *s) { store_save_snap(s); }
static const char *contact_phone(void) { return owner.phone; }
static const char *contact_telegram(void) { return owner.telegram; }
/* A new pairing or a wipe: the next account's rev counters start again, or its lost_mode/ice_update would be dropped as stale. */
static void reset_revs(void)
{
    owner.ice_rev = 0;
    lost.rev = 0;
    settings.rev = 0;
    store_save_owner(&owner);
    store_save_lost(&lost);
    store_save_settings(&settings);
}
#endif

/* Runs in the ui task (LVGL lock held) before the first frame. */
static void boot_ui_setup(void)
{
    ui_setup();
#ifndef CONFIG_AELYS_NO_WIFI
    ui_set_action_sink(link_post_action); /* taps and keys on Today, Focus and Inbox become actions for the server */
#endif
    *(owner_info_t *)tribuf_back(&ui_owner_tb) = lost.on ? lost.shown : owner; /* lost mode shows what the owner chose */
    tribuf_publish(&ui_owner_tb);
    ui_event_t ev = {.type = UI_EV_OWNER};
    ui_handle_event(&ev);
    if (first_boot || boot_paired) { /* unpaired with Wi-Fi saved keeps the plain "Not paired yet" home */
        ui_event_t fev = {.type = UI_EV_LINK, .len = 1, .data = {first_boot ? LINK_UI_UNPAIRED : LINK_UI_OFFLINE}};
        ui_handle_event(&fev);
    }
    if (lost.on) {
        ui_event_t lev = {.type = UI_EV_LOST, .len = 1, .data = {1}};
        ui_handle_event(&lev);
    }
}

/* A dead panel or UI task is not fixed by rebooting: log it once and idle instead of looping through
 * panics and coredump writes. */
static void halt(const char *what, esp_err_t err)
{
    ESP_LOGE(TAG, "%s failed: %s (idle)", what, esp_err_to_name(err));
    for (;;) vTaskDelay(portMAX_DELAY);
}

void app_main(void)
{
    ESP_LOGW(TAG, "Aelys companion fw %s", FW_VERSION);
    ESP_LOGW(TAG, "psram_size=%u free_internal=%u free_spiram=%u", (unsigned)esp_psram_get_size(),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    esp_err_t berr = board_init();
    if (berr != ESP_OK) halt("board_init", berr);
    /* Load settings before the UI exists, and apply them inside the ui task right after ui_setup(), so
     * the first frame is already the right screen (no home flash before lost mode). Empty or corrupt
     * NVS gives the factory contacts and lost mode off; never a crash or a reboot. */
    esp_err_t nerr = store_init();
    if (nerr != ESP_OK) ESP_LOGE(TAG, "nvs: %s (running on defaults)", esp_err_to_name(nerr));
    store_load_owner(&owner);
    store_load_lost(&lost);
    store_load_settings(&settings);
    if (board_display_set_brightness(settings.brightness) != ESP_OK) ESP_LOGW(TAG, "brightness %d%% not applied", settings.brightness);
#ifdef CONFIG_AELYS_IDENTITY_SELFTEST
    identity_selftest();
#else
    static const identity_store_t istore = {.load = store_load_pair, .save = store_save_pair, .erase = store_erase_pair};
    esp_err_t ierr = identity_init(&istore);
    if (ierr != ESP_OK) ESP_LOGE(TAG, "identity: %s (running unpaired)", esp_err_to_name(ierr));
    ESP_LOGW(TAG, "boot: paired=%d", identity_paired());
#endif
    ESP_LOGI(TAG, "boot: main stack free=%u bytes", (unsigned)uxTaskGetStackHighWaterMark(NULL));
    static wifi_list_t saved_wifi;
    store_load_wifi(&saved_wifi);
    boot_paired = identity_paired();
    first_boot = !boot_paired && saved_wifi.n == 0;
    explicit_bzero(&saved_wifi, sizeof saved_wifi); /* only the count was wanted; the list holds passwords */
    ESP_LOGW(TAG, "boot: lost_mode=%s", lost.on ? "on" : "off");

    lv_port_set_handler(ui_handle_event);
    berr = lv_port_start(boot_ui_setup);
    if (berr != ESP_OK) halt("ui start", berr);

    esp_err_t err = board_input_start();
    if (err != ESP_OK) ESP_LOGE(TAG, "input start: %s", esp_err_to_name(err));

#ifndef CONFIG_AELYS_NO_WIFI
    static const net_store_t nstore = {.load = store_load_wifi, .save = store_save_wifi, .lost_on = lost_is_on};
    err = net_start(&nstore);
    if (err != ESP_OK) ESP_LOGE(TAG, "net start: %s", esp_err_to_name(err));
    ESP_LOGW(TAG, "wifi started: free_internal=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    /* after the ui task ran ui_setup (the snapshot buffer exists) and after net_start (Wi-Fi is up or coming up) */
    static const link_deps_t ldeps = {.on_command = on_command, .save_snap = save_snap, .load_snap = load_snap,
                                      .erase_snap = erase_snap, .lost_on = lost_is_on, .contact_phone = contact_phone, .contact_telegram = contact_telegram,
                                      .load_wifi = store_load_wifi, .reset_revs = reset_revs};
    err = link_start(&ldeps);
    if (err != ESP_OK) ESP_LOGE(TAG, "link start: %s", esp_err_to_name(err));
#endif

    metrics_start(CONFIG_AELYS_METRICS_PERIOD_S);
}
