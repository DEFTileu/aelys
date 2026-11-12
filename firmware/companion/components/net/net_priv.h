#pragma once
/* Internal to components/net. */
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

/* net_wifi.c */
void net_set_wifi_state(uint8_t state); /* ui_wifi_state_t; posted to the ui by the net task, once per change */
void net_housekeeping(void);  /* clock tick and pending UI posts; cheap, call from any wait loop in the net task */
bool net_wifi_online(void);
/* Blocks up to ~15 s. Pauses the automatic reconnect while it runs. True once an IP is held. */
bool net_wifi_provision(const char *ssid, const char *pass);

/* net_time.c */
void net_time_start(void);   /* SNTP; idempotent */
void net_time_tick(void);    /* posts UI_EV_TIME when the minute changed */

/* net_improv.c */
esp_err_t net_improv_init(void);
void net_improv_poll(void);  /* ~10 ms blocking read, then parses and answers */
