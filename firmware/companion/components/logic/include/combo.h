#pragma once
/* Two-button hold detector. Pure C, no IDF. */
#include <stdbool.h>
#include <stdint.h>

typedef enum { COMBO_IDLE, COMBO_HOLDING, COMBO_FIRED } combo_state_t;
typedef struct { combo_state_t state; uint32_t since_ms; bool a, b; } combo_t;

#define COMBO_HOLD_MS 2000

void combo_reset(combo_t *c);
/* returns progress 0..100 while holding, 100 exactly once when it fires, -1 otherwise */
int combo_update(combo_t *c, bool a_down, bool b_down, uint32_t now_ms);
