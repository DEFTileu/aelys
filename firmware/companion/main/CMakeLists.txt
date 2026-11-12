if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/owner_contact.local.h")
    message(FATAL_ERROR "Copy main/owner_contact.example.h to main/owner_contact.local.h and fill in the owner's contacts")
endif()

idf_component_register(SRCS "app_main.c" "store_nvs.c" "metrics.c"
                       INCLUDE_DIRS "."
                       REQUIRES board logic ui net identity
                       PRIV_REQUIRES lvgl__lvgl esp_psram nvs_flash esp_netif esp_timer)
