idf_component_register(SRCS link.c link_http.c link_ws.c link_cmd.c
                       INCLUDE_DIRS include
                       REQUIRES logic
                       PRIV_REQUIRES identity board ui esp_http_client espressif__esp_websocket_client esp-tls mbedtls
                                     esp_netif esp_app_format esp_timer esp_hw_support esp_event freertos)
