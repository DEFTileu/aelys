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

/* ES8311 codec (DAC only) and the speaker amplifier. Same source as above: BSP_I2S_MCLK / BSP_I2S_SCLK / BSP_I2S_LCLK / BSP_I2S_DOUT,
 * BSP_POWER_AMP_IO (high = amplifier on) and ES8311_CODEC_DEFAULT_ADDR (0x30, esp_codec_dev's 8-bit form = 7-bit 0x18), on the shared I2C bus.
 * GPIO 45 and 46 are strapping pins; they are only driven once a sound plays. The BSP's I2S DIN (GPIO 10, the microphone) is not used. */
#define PIN_I2S_MCLK    GPIO_NUM_16
#define PIN_I2S_BCLK    GPIO_NUM_9
#define PIN_I2S_WS      GPIO_NUM_45
#define PIN_I2S_DOUT    GPIO_NUM_8
#define PIN_PA_EN       GPIO_NUM_46
#define I2C_ADDR_ES8311 0x18

/* CST9217 touch (driven by a later task) */
#define PIN_TOUCH_INT   GPIO_NUM_11
#define PIN_TOUCH_RST   GPIO_NUM_2

/* BOOT key (active low) */
#define PIN_BOOT        GPIO_NUM_0

#define LCD_W           466
#define LCD_H           466
#define LCD_X_GAP       6   /* the panel's column offset, esp_lcd_panel_set_gap(panel, 6, 0) in the BSP */
