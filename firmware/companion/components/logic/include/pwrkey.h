#pragma once
/* PWR key state from the AXP2101's latched press/release edges (the level itself is not readable). Pure C. */
#include <stdbool.h>
#include <stdint.h>

/* The PMIC powers off after 10 s of press, so a key "down" for longer is stale (lost release edge). */
#define PWRKEY_STALE_MS 10500

typedef struct { bool down; uint32_t since_ms; } pwrkey_t;

void pwrkey_reset(pwrkey_t *k);
/* neg/pos: the press / release edge bits seen since the last call. Both at once cannot be ordered, so
 * it counts as a tap (pressed, then released). Returns whether the key is down now. */
bool pwrkey_update(pwrkey_t *k, bool neg, bool pos, uint32_t now_ms);
