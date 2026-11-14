if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/owner_contact.local.h")
    message(FATAL_ERROR "Copy main/owner_contact.example.h to main/owner_contact.local.h and fill in the owner's contacts")
endif()

set(AELYS_LDFRAGMENTS)
if(CONFIG_AELYS_ARC_IRAM_BENCH)
    list(APPEND AELYS_LDFRAGMENTS "aelys_lvgl_hot.lf")
endif()

idf_component_register(SRCS "app_main.c" "store_nvs.c" "metrics.c"
                       LDFRAGMENTS ${AELYS_LDFRAGMENTS}
                       INCLUDE_DIRS "."
                       REQUIRES board logic ui net identity link
                       PRIV_REQUIRES lvgl__lvgl esp_psram nvs_flash esp_netif esp_timer)
