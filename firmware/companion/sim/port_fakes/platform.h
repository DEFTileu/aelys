#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define IRAM_ATTR
#define ESP_OK 0
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_TIMEOUT 0x107
typedef int esp_err_t;
typedef void *i2c_master_bus_handle_t;
typedef void *esp_lcd_panel_handle_t;
typedef void *esp_lcd_panel_io_handle_t;
typedef struct { int unused; } esp_lcd_panel_io_event_data_t;
typedef struct { bool (*on_color_trans_done)(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t *, void *); } esp_lcd_panel_io_callbacks_t;
esp_err_t esp_lcd_panel_draw_bitmap(esp_lcd_panel_handle_t, int, int, int, int, const void *);
esp_err_t esp_lcd_panel_io_register_event_callbacks(esp_lcd_panel_io_handle_t, const esp_lcd_panel_io_callbacks_t *, void *);
void esp_restart(void);

#define GPIO_NUM_13 13
#define GPIO_MODE_INPUT 0
#define GPIO_INTR_POSEDGE 1
typedef struct { uint64_t pin_bit_mask; int mode; int intr_type; } gpio_config_t;
esp_err_t gpio_config(const gpio_config_t *);
esp_err_t gpio_install_isr_service(int);
esp_err_t gpio_isr_handler_add(int, void (*)(void *), void *);

#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_8BIT 2
#define MALLOC_CAP_DMA 4
#define MALLOC_CAP_INTERNAL 8
typedef struct { size_t total_free_bytes, total_allocated_bytes, largest_free_block; } multi_heap_info_t;
void *heap_caps_malloc(size_t, int);
void *heap_caps_realloc(void *, size_t, int);
void heap_caps_free(void *);
void *heap_caps_aligned_alloc(size_t, size_t, int);
void heap_caps_get_info(multi_heap_info_t *, int);
int64_t esp_timer_get_time(void);
void fake_log_warning(const char *tag);
#define ESP_LOGW(tag, ...) fake_log_warning(tag)

typedef int BaseType_t;
typedef unsigned TickType_t;
typedef void *SemaphoreHandle_t;
typedef void *QueueHandle_t;
typedef void *TaskHandle_t;
#define pdFALSE 0
#define pdTRUE 1
#define pdPASS 1
#define pdMS_TO_TICKS(ms) (ms)
#define portYIELD_FROM_ISR() ((void)0)
SemaphoreHandle_t xSemaphoreCreateBinary(void);
BaseType_t xSemaphoreTake(SemaphoreHandle_t, TickType_t);
BaseType_t xSemaphoreGiveFromISR(SemaphoreHandle_t, BaseType_t *);
QueueHandle_t xQueueCreate(unsigned, size_t);
BaseType_t xQueueReceive(QueueHandle_t, void *, TickType_t);
BaseType_t xQueueSend(QueueHandle_t, const void *, TickType_t);
TaskHandle_t xTaskGetCurrentTaskHandle(void);
BaseType_t xTaskCreatePinnedToCore(void (*)(void *), const char *, unsigned, void *, unsigned, TaskHandle_t *, int);
BaseType_t xTaskNotifyWait(uint32_t, uint32_t, uint32_t *, TickType_t);
#define eSetValueWithOverwrite 0
BaseType_t xTaskNotify(TaskHandle_t, uint32_t, int);
void vTaskDelete(TaskHandle_t);
