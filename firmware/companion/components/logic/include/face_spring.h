#pragma once
#include <stdint.h>

/* A critically damped, bounded fixed-point spring. Values are face-space
 * integer units. The current state is Q16 and velocity is Q16 units/second. */
typedef struct { int64_t value_q16, velocity_q16; } face_spring_t;
void face_spring_init(face_spring_t *spring, int32_t value);
void face_spring_step(face_spring_t *spring, int32_t target, uint32_t elapsed_ms);
int32_t face_spring_value(const face_spring_t *spring);
