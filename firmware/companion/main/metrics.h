#pragma once
#include <stdint.h>

/* Starts the `metrics` task: one WARN line every period_s seconds (heap, frames, stack high-water
 * marks, boot time, Wi-Fi IP). Read-only, so it never blocks the ui task. */
void metrics_start(uint32_t period_s);
