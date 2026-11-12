#pragma once
/* Waveshare ESP32-S3-Touch-AMOLED-1.75C. Pins from the Waveshare BSP
 * waveshare/esp32_s3_touch_amoled_1_75c 3.0.0 (include/bsp/esp32_s3_touch_amoled_1_75c.h);
 * the TE line is not used by the BSP: GPIO 13, probed by the Pip firmware (60 Hz pulse). */
#include "driver/gpio.h"

/* CO5300 AMOLED over QSPI */
#define PIN_LCD_CS      GPIO_NUM_12
#define PIN_LCD_PCLK    GPIO_NUM_38
#define PIN_LCD_D0      GPIO_NUM_4
#define PIN_LCD_D1      GPIO_NUM_5
#define PIN_LCD_D2      GPIO_NUM_6
#define PIN_LCD_D3      GPIO_NUM_7
#define PIN_LCD_RST     GPIO_NUM_1
#define PIN_LCD_TE      GPIO_NUM_13

/* Shared I2C bus: AXP2101 0x34, QMI8658 0x6B (or 0x6A), CST9217 touch, codecs, RTC */
#define PIN_I2C_SDA     GPIO_NUM_15
#define PIN_I2C_SCL     GPIO_NUM_14
#define I2C_ADDR_AXP2101 0x34
#define I2C_ADDR_QMI8658 0x6B

/* CST9217 touch (driven by a later task) */
#define PIN_TOUCH_INT   GPIO_NUM_11
#define PIN_TOUCH_RST   GPIO_NUM_2

/* BOOT key (active low) */
#define PIN_BOOT        GPIO_NUM_0

#define LCD_W           466
#define LCD_H           466
#define LCD_X_GAP       6   /* the panel's column offset, esp_lcd_panel_set_gap(panel, 6, 0) in the BSP */
