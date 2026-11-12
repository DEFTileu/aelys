#pragma once
#include <stdint.h>

typedef enum {
    UI_EV_TOUCH = 1,
    UI_EV_BTN,
    UI_EV_COMBO_PROGRESS,
    UI_EV_COMBO_FIRE,
    UI_EV_TIME,
    UI_EV_WIFI,
    UI_EV_OWNER,
    UI_EV_LOST,
    UI_EV_TICK,
} ui_event_type_t;

typedef struct {
    uint8_t type;
    uint8_t len;
    uint8_t data[62];
} ui_event_t;

_Static_assert(sizeof(ui_event_t) == 64, "ui_event_t");

/* UI_EV_WIFI data[0] */
typedef enum { UI_WIFI_OFFLINE, UI_WIFI_CONNECTING, UI_WIFI_ONLINE, UI_WIFI_BAD_PASSWORD } ui_wifi_state_t;
