#pragma once
#include <stddef.h>
void owned_nvs_explicit_bzero(void *p, size_t n);
#define ESP_LOGW(tag, ...) ((void)(tag))
#define ESP_LOGE(tag, ...) ((void)(tag))
