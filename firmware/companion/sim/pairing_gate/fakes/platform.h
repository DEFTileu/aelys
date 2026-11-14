#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_ERR_INVALID_STATE 1
#define ESP_ERR_NOT_FOUND 2
#define ESP_ERR_NO_MEM 3
#define ESP_ERR_TIMEOUT 4
#define MALLOC_CAP_INTERNAL 1
#define MALLOC_CAP_SPIRAM 2
#define MALLOC_CAP_8BIT 4
#define pdTRUE 1
#define pdPASS 1
#define pdMS_TO_TICKS(x) (x)
#define portMAX_DELAY UINT32_MAX
#define ESP_LOGI(tag, ...) do { (void)(tag); if (0) fprintf(stderr, __VA_ARGS__); } while (0)
#define ESP_LOGW(tag, ...) do { (void)(tag); if (0) fprintf(stderr, __VA_ARGS__); } while (0)
#define ESP_LOGE(tag, ...) do { (void)(tag); if (0) fprintf(stderr, __VA_ARGS__); } while (0)
typedef void *QueueHandle_t;
typedef void *SemaphoreHandle_t;
typedef struct { struct { uint32_t addr; } ip; } esp_netif_ip_info_t;
typedef struct { int dummy; } esp_netif_t;
typedef struct { const char *version; } esp_app_desc_t;
int64_t esp_timer_get_time(void);
void esp_fill_random(void *, size_t);
uint32_t esp_random(void);
size_t heap_caps_get_largest_free_block(int);
size_t heap_caps_get_free_size(int);
size_t heap_caps_get_minimum_free_size(int);
void *heap_caps_calloc(size_t,size_t,int);
void vTaskDelay(unsigned);
int xTaskCreatePinnedToCore(void (*)(void *), const char *, unsigned, void *, int, void *, int);
QueueHandle_t xQueueCreate(unsigned, unsigned);
int xQueueSend(QueueHandle_t, const void *, unsigned);
int xQueueReceive(QueueHandle_t, void *, unsigned);
SemaphoreHandle_t xSemaphoreCreateMutex(void);
int xSemaphoreTake(SemaphoreHandle_t, unsigned);
int xSemaphoreGive(SemaphoreHandle_t);
esp_netif_t *esp_netif_get_handle_from_ifkey(const char *);
bool esp_netif_is_netif_up(esp_netif_t *);
esp_err_t esp_netif_get_ip_info(esp_netif_t *, esp_netif_ip_info_t *);
const esp_app_desc_t *esp_app_get_description(void);
const char *esp_err_to_name(esp_err_t);
#if !defined(__APPLE__)
size_t strlcpy(char *, const char *, size_t);
#endif

void explicit_bzero(void *, size_t);
