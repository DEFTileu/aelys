#include <string.h>

#include "beep.h"
#include "board.h"
#include "codec_util.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "sdkconfig.h"
#include "identity.h"
#include "link.h"
#include "metrics.h"
#include "net.h"
#include "owner.h"
#include "store_nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ui.h"
#ifdef CONFIG_AELYS_PERF_PROBE
#include "ui_screens_priv.h"
static uint32_t probe_screen(void) { return (uint32_t)ui_current_screen(); }
#endif

#define FW_VERSION "0.1.0"

/* sdkconfig.defaults only fills keys a sdkconfig does not have yet, so an old sdkconfig keeps its old (smaller) values and fails at runtime. */
#if CONFIG_ESP_MAIN_TASK_STACK_SIZE < 6144 || !defined(CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC) || !defined(CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_CMN)
#error "stale sdkconfig: delete firmware/companion/sdkconfig and rebuild (sdkconfig.defaults only applies to new keys)"
#endif

static const char *TAG = "companion";

static owner_info_t owner;
static lost_state_t lost;
static settings_t settings;
static bool first_boot, boot_paired; /* first_boot: unpaired and no saved Wi-Fi, home shows the welcome */

static bool lost_is_on(void) { return lost.on; }
#ifndef CONFIG_AELYS_NO_WIFI
static uint32_t lost_revision(void) { return lost.rev; }
#endif

#ifndef CONFIG_AELYS_NO_WIFI
/* Command handlers (link task, the only writer of owner/lost/settings once the link runs). Never call LVGL or the panel from here:
 * owner data goes through ui_owner_tb, everything else as UI events. Every command is acked. A stale rev acks ok and changes
 * nothing; an applied one is saved, and a failed save keeps the live state but acks BUSY with the rev rolled back (cmd_settle),
 * so the server resends it after the next hello and the save is retried. */
static void post_ui(ui_event_t ev)
{
    /* This task may block: a dropped UI_EV_LOST would leave a board that acked lost-on showing home. Only a dead ui task ends it. */
    int tries = 0;
    while (!lv_port_post(&ev) && ++tries < 3000) vTaskDelay(pdMS_TO_TICKS(10));
    if (tries >= 3000) ESP_LOGE(TAG, "ui event %d not delivered (queue stuck for 30 s)", ev.type);
}

static void publish_owner(void) /* what the lost and ICE screens show: lost.shown while lost, else the owner's data */
{
    *(owner_info_t *)tribuf_back(&ui_owner_tb) = lost.on ? lost.shown : owner;
    tribuf_publish(&ui_owner_tb);
    post_ui((ui_event_t){.type = UI_EV_OWNER});
}

static bool saved(const char *what, esp_err_t e)
{
    if (e != ESP_OK) ESP_LOGW(TAG, "%s not saved: %s (BUSY, the server will resend)", what, esp_err_to_name(e));
    return e == ESP_OK;
}

static void ack(const char *id, cmd_ack_t r)
{
    if (r == CMD_ACK_OK) link_send_ack(id, true, NULL);
    else link_send_ack(id, false, "BUSY");
}

static void restart_soon(void)
{
    vTaskDelay(pdMS_TO_TICKS(500)); /* the ack (already sent) and the logs get out */
    esp_restart();
}

static void unpair_board(void)
{
    link_unpair(); /* pairing, revs, cached snapshot */
    if (!saved("unpair wipe", store_erase_device_data())) ESP_LOGE(TAG, "unpair: some data may remain in flash"); /* Wi-Fi list, owner, lost, settings, snap */
    owner_defaults(&owner);
    memset(&lost, 0, sizeof lost);
    settings_defaults(&settings);
}

/* Wi-Fi commands. wifi_add switches the board's network, which drops the channel: its ack is queued in RAM and goes out after the
 * reconnect and hello (then wifi_state). Buffers are static (the link task stack is kept free for mbedTLS) and wiped right after use;
 * nothing here logs an SSID, a password, the blob or the plaintext. */
static struct { uint8_t blob[528]; char ssid[33], pass[65], prev[33]; } wa; /* 704 base64url chars decode to at most 528 bytes */
static char scan_buf[1536];

static void post_wifi_add(uint8_t state, const char *ssid, const char *prev)
{
    ui_event_t ev = {.type = UI_EV_WIFI_ADD, .len = 60, .data = {state}};
    strlcpy((char *)&ev.data[1], ssid, 33);
    utf8_copy((char *)&ev.data[34], 26, prev, strlen(prev)); /* 25 bytes, never half a character */
    post_ui(ev);
    explicit_bzero(&ev, sizeof ev);
}

static void wifi_add(const char *id, const char *blob_b64)
{
    int n = b64url_decode(blob_b64, wa.blob, sizeof wa.blob);
    esp_err_t e = n > 0 ? identity_wifi_decrypt(wa.blob, (size_t)n, wa.ssid, wa.pass) : ESP_FAIL;
    explicit_bzero(wa.blob, sizeof wa.blob);
    if (e != ESP_OK) {
        ESP_LOGW(TAG, "wifi_add: blob did not decrypt");
        explicit_bzero(&wa, sizeof wa);
        link_send_ack(id, false, "DECRYPT_FAILED"); /* nothing changed: the channel is still up */
        return;
    }
    strlcpy(wa.prev, net_wifi_current_ssid(), sizeof wa.prev); /* the net task is idle here: no Wi-Fi change is racing this read */
    post_wifi_add(0, wa.ssid, wa.prev);
    net_try_t t = net_wifi_try(wa.ssid, wa.pass);
    explicit_bzero(wa.pass, sizeof wa.pass);
    if (t == NET_TRY_NOT_RUN) { /* never judged and the link was not touched: no card, the healthy socket stays */
        ESP_LOGW(TAG, "wifi_add: not run (busy)");
        post_wifi_add(3, "", "");
        explicit_bzero(&wa, sizeof wa);
        if (!link_send_ack(id, false, "BUSY")) link_queue_ack(id, false, "BUSY");
        return;
    }
    bool ok = t == NET_TRY_OK;
    ESP_LOGW(TAG, "wifi_add: %s", ok ? "connected and saved" : "could not connect");
    post_wifi_add(ok ? 1 : 2, wa.ssid, wa.prev);
    explicit_bzero(&wa, sizeof wa);
    link_queue_ack(id, ok, ok ? NULL : "WIFI_FAILED");
    link_wifi_switched(); /* the old socket is gone either way: sign in again as soon as a network is up */
}

static void wifi_scan(const char *id)
{
    wifi_seen_t v[10];
    int n = net_wifi_scan(v, 10);
    if (n < 0) n = 0; /* a failed scan still answers with wifi_scan_result (an empty list): that is the only answer wifi_scan has */
    link_send_raw(scan_buf, proto_wifi_scan_result(scan_buf, sizeof scan_buf, id, v, n)); /* this IS the ack of wifi_scan */
}

static void wifi_changed(const char *id, bool ok)
{
    link_send_ack(id, ok, ok ? NULL : "BUSY"); /* BUSY: the list could not be saved and is unchanged */
    if (ok) link_send_wifi_state();
}

static void on_command(const proto_msg_t *m)
{
    const char *id = m->id;
    switch (m->u.cmd.name) {
    case CMD_LOST_MODE: {
        uint32_t prev = lost.rev;
        bool applied = owner_apply_lost(&lost, &owner, &m->u.cmd.a.lost);
        bool ok = !applied || saved("lost", store_save_lost(&lost));
        cmd_ack_t settled = cmd_settle(applied, ok, &lost.rev, prev);
        if (applied) { /* live even when the save failed; attach only the settled revision */
            publish_owner();
            ui_event_t ev = {.type = UI_EV_LOST, .len = 5, .data = {lost.on,
                (uint8_t)lost.rev, (uint8_t)(lost.rev >> 8), (uint8_t)(lost.rev >> 16), (uint8_t)(lost.rev >> 24)}};
            post_ui(ev);
        }
        ack(id, settled);
        break;
    }
    case CMD_ICE_UPDATE: {
        uint32_t prev = owner.ice_rev;
        bool applied = owner_apply_ice(&owner, &lost, &m->u.cmd.a.ice);
        bool ok = true;
        if (applied) { /* what the lost screen shows is saved first; the owner copy only after it, so a failure never leaves the owner newer than the lost screen */
            ok = (!lost.on || saved("lost", store_save_lost(&lost))) && saved("owner", store_save_owner(&owner));
            publish_owner();
        }
        ack(id, cmd_settle(applied, ok, &owner.ice_rev, prev));
        break;
    }
    case CMD_SETTINGS: {
        uint32_t prev = settings.rev;
        bool applied = settings_apply(&settings, m->u.cmd.a.settings.brightness, m->u.cmd.a.settings.rev);
        bool ok = !applied || saved("settings", store_save_settings(&settings));
        if (applied) post_ui((ui_event_t){.type = UI_EV_BRIGHTNESS, .len = 1, .data = {settings.brightness}}); /* the ui task owns the panel's SPI device */
        ack(id, cmd_settle(applied, ok, &settings.rev, prev));
        break;
    }
    case CMD_RESTART:
        link_send_ack(id, true, NULL);
        restart_soon();
        break;
    case CMD_UNPAIR:
        link_send_ack(id, true, NULL); /* before the wipe: the server revokes the board right after sending the command */
        vTaskDelay(pdMS_TO_TICKS(500)); /* the ack leaves before link_unpair closes the socket */
        unpair_board();
        restart_soon(); /* first boot: no pairing, no Wi-Fi, the welcome screen */
        break;
    case CMD_WIFI_ADD:
        wifi_add(id, m->u.cmd.a.blob);
        break;
    case CMD_WIFI_SCAN:
        wifi_scan(id);
        break;
    case CMD_WIFI_REMOVE: {
        net_edit_t r = net_wifi_remove(m->u.cmd.a.ssid);
        if (r == NET_EDIT_IN_USE) link_send_ack(id, false, "IN_USE"); /* nothing changed: the list on the server is still right */
        else wifi_changed(id, r == NET_EDIT_OK);
        break;
    }
    case CMD_WIFI_ORDER:
        wifi_changed(id, net_wifi_reorder((const char(*)[33])m->u.cmd.a.order.ssid, m->u.cmd.a.order.n));
        break;
    case CMD_PLAY_SOUND: /* find: board_audio_beep() starts the beeps (60 s, a tap or key stops them) and posts UI_EV_FIND itself, in step with the sound; works on every screen */
        if (board_audio_beep(BEEP_MAX_MS) != ESP_OK) {
            ESP_LOGW(TAG, "play_sound: the sound did not start");
            link_send_ack(id, false, "BUSY"); /* no task: only this is known synchronously; a codec init failure later is log-only */
        } else {
            link_send_ack(id, true, NULL);
        }
        break;
    default:
        link_send_ack(id, false, "UNSUPPORTED");
        break;
    }
}
/* Lost mode shows no cached data. A session that was running before the power cut is not running now: drop it. */
static bool load_snap(snap_t *s)
{
    uint8_t active_pub[STORE_SNAP_OWNER_LEN];
    if (lost.on || identity_active_pub(active_pub) != ESP_OK || !store_load_snap(s, active_pub)) return false;
    s->focus.status = FOCUS_NONE;
    return true;
}
static void erase_snap(void)
{
    if (store_erase_snap() != ESP_OK) ESP_LOGW(TAG, "cached snapshot not erased"); /* flash may keep the old owner's data */
}
static void save_snap(const snap_t *s)
{
    uint8_t active_pub[STORE_SNAP_OWNER_LEN];
    if (identity_active_pub(active_pub) == ESP_OK) store_save_snap(s, active_pub);
}
static const char *contact_phone(void) { return owner.phone; }
static const char *contact_telegram(void) { return owner.telegram; }
/* A new pairing or a wipe: the next account's rev counters start again, or its lost_mode/ice_update would be dropped as stale. */
static void reset_revs(void)
{
    owner.ice_rev = 0;
    lost.rev = 0;
    settings.rev = 0;
    uint32_t identity = link_character_new_identity();
    post_ui((ui_event_t){.type = UI_EV_LOST, .len = 9, .data = {lost.on, 0, 0, 0, 0,
        (uint8_t)identity, (uint8_t)(identity >> 8), (uint8_t)(identity >> 16), (uint8_t)(identity >> 24)}});
    esp_err_t e1 = store_save_owner(&owner), e2 = store_save_lost(&lost), e3 = store_save_settings(&settings); /* all three are tried */
    if (e1 != ESP_OK || e2 != ESP_OK || e3 != ESP_OK) ESP_LOGW(TAG, "rev reset not fully saved (owner %s, lost %s, settings %s)",
                                                                esp_err_to_name(e1), esp_err_to_name(e2), esp_err_to_name(e3));
}
#endif

/* Every UI event, in the ui task: the brightness one is the only thing that touches the panel's SPI device outside a flush. */
static void on_ui_event(const ui_event_t *ev)
{
    if (ev->type != UI_EV_BRIGHTNESS) { ui_handle_event(ev); return; }
    if (ev->len >= 1 && board_display_set_brightness(ev->data[0]) != ESP_OK) ESP_LOGW(TAG, "brightness %d%% not applied", ev->data[0]);
}

/* Runs in the ui task (LVGL lock held) before the first frame. */
static void boot_ui_setup(void)
{
    ui_setup();
#ifdef CONFIG_AELYS_PERF_PROBE
    lv_port_probe_set_ui(ui_probe_swipe, probe_screen);
#endif
    ui_set_find_stop(board_audio_stop); /* a tap or key while "Here I am!" shows ends the beeps */
#ifndef CONFIG_AELYS_NO_WIFI
    ui_set_lost_revision(lost.rev);
    ui_set_character_status_sink(link_post_character);
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

    lv_port_set_handler(on_ui_event);
    berr = lv_port_start(boot_ui_setup);
    if (berr != ESP_OK) halt("ui start", berr);

    esp_err_t err = board_input_start();
    if (err != ESP_OK) ESP_LOGE(TAG, "input start: %s", esp_err_to_name(err));
    int16_t ax, ay, az; /* one boot sample, so a board log shows the IMU answers and its axis orientation */
    if (board_imu_init() == ESP_OK && board_imu_read(&ax, &ay, &az))
        ESP_LOGW(TAG, "imu: ax=%d ay=%d az=%d", ax, ay, az);

#ifndef CONFIG_AELYS_NO_WIFI
    static const net_store_t nstore = {.load = store_load_wifi, .save = store_save_wifi, .lost_on = lost_is_on};
    err = net_start(&nstore);
    if (err != ESP_OK) ESP_LOGE(TAG, "net start: %s", esp_err_to_name(err));
    ESP_LOGW(TAG, "wifi started: free_internal=%u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    /* after the ui task ran ui_setup (the snapshot buffer exists) and after net_start (Wi-Fi is up or coming up) */
    static const link_deps_t ldeps = {.on_command = on_command, .save_snap = save_snap, .load_snap = load_snap,
                                      .erase_snap = erase_snap, .lost_on = lost_is_on, .lost_rev = lost_revision, .contact_phone = contact_phone, .contact_telegram = contact_telegram,
                                      .current_ssid = net_wifi_current_ssid, .load_wifi = store_load_wifi, .reset_revs = reset_revs};
    err = link_start(&ldeps);
    if (err != ESP_OK) ESP_LOGE(TAG, "link start: %s", esp_err_to_name(err));
#endif

    metrics_start(CONFIG_AELYS_METRICS_PERIOD_S);
}
