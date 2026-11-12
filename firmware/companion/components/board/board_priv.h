#pragma once
/* Between the board_*.c files and lv_port.c; not part of the public API. */
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_err.h"

esp_err_t board_i2c_init(void);
esp_err_t board_power_init(void);   /* AXP2101 rails the panel needs */
esp_err_t board_display_init(void); /* QSPI bus, panel reset + init; the panel stays off */
esp_lcd_panel_handle_t board_panel(void);
esp_lcd_panel_io_handle_t board_panel_io(void);
