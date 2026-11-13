idf_component_register(SRCS net_wifi.c net_time.c net_improv.c
                       INCLUDE_DIRS include
                       REQUIRES logic
                       PRIV_REQUIRES board identity link esp_wifi esp_netif esp_event esp_driver_usb_serial_jtag
                                     esp_app_format esp_timer esp_hw_support)
