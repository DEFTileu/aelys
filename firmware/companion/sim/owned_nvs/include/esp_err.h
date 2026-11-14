#pragma once
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL 1
#define ESP_ERR_INVALID_SIZE 2
#define ESP_ERR_NO_MEM 3
#define ESP_ERR_NVS_NOT_FOUND 4
#define ESP_ERR_NVS_NO_FREE_PAGES 5
#define ESP_ERR_NVS_NEW_VERSION_FOUND 6
const char *esp_err_to_name(esp_err_t err);
