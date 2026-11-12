idf_component_register(SRCS board_i2c.c board_power.c board_display.c board_input.c lv_port.c
                       INCLUDE_DIRS include
                       REQUIRES logic esp_driver_i2c esp_driver_gpio
                       PRIV_REQUIRES lvgl__lvgl espressif__esp_lcd_co5300 espressif__esp_lcd_touch
                                     waveshare__esp_lcd_touch_cst9217 esp_lcd esp_timer esp_driver_spi)
