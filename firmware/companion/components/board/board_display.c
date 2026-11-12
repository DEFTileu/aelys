#include "board.h"
#include "board_pins.h"
#include "board_priv.h"
#include "driver/spi_master.h"
#include "esp_check.h"
#include "esp_lcd_co5300.h"

#define LCD_SPI_HOST   SPI2_HOST
#define LCD_PCLK_HZ    (80 * 1000 * 1000)
#define LCD_QUEUE      4
/* >= the largest transfer lv_port.c sends in one go (466 x 48 rows x 2 bytes) */
#define LCD_MAX_XFER   (LCD_W * 48 * 2)

static esp_lcd_panel_handle_t panel;
static esp_lcd_panel_io_handle_t io;

/* Waveshare BSP waveshare/esp32_s3_touch_amoled_1_75c 3.0.0 init sequence (0x35 = TE on) */
static const co5300_lcd_init_cmd_t init_cmds[] = {
    {0xFE, (uint8_t[]){0x20}, 1, 0},
    {0x19, (uint8_t[]){0x10}, 1, 0},
    {0x1C, (uint8_t[]){0xA0}, 1, 0},
    {0xFE, (uint8_t[]){0x00}, 1, 0},
    {0xC4, (uint8_t[]){0x80}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 0},
    {0x51, (uint8_t[]){0xFF}, 1, 0},
    {0x63, (uint8_t[]){0xFF}, 1, 0},
    {0x2A, (uint8_t[]){0x00, 0x06, 0x01, 0xD7}, 4, 0},
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xD1}, 4, 600},
    {0x11, NULL, 0, 600},
    {0x29, NULL, 0, 0},
};

esp_err_t board_display_init(void)
{
    const spi_bus_config_t bus = CO5300_PANEL_BUS_QSPI_CONFIG(PIN_LCD_PCLK, PIN_LCD_D0, PIN_LCD_D1, PIN_LCD_D2,
                                                              PIN_LCD_D3, LCD_MAX_XFER);
    ESP_RETURN_ON_ERROR(spi_bus_initialize(LCD_SPI_HOST, &bus, SPI_DMA_CH_AUTO), "board", "spi bus");

    esp_lcd_panel_io_spi_config_t io_cfg = CO5300_PANEL_IO_QSPI_CONFIG(PIN_LCD_CS, NULL, NULL);
    io_cfg.pclk_hz = LCD_PCLK_HZ;
    io_cfg.trans_queue_depth = LCD_QUEUE;
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)LCD_SPI_HOST, &io_cfg, &io), "board", "panel io");

    const co5300_vendor_config_t vendor = {
        .init_cmds = init_cmds,
        .init_cmds_size = sizeof init_cmds / sizeof init_cmds[0],
        .flags.use_qspi_interface = 1,
    };
    const esp_lcd_panel_dev_config_t cfg = {
        .reset_gpio_num = PIN_LCD_RST,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
        .vendor_config = (void *)&vendor,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_co5300(io, &cfg, &panel), "board", "panel");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_set_gap(panel, LCD_X_GAP, 0), "board", "gap");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(panel), "board", "reset");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(panel), "board", "init");
    return ESP_OK; /* 0x29 (display on) is the last init command */
}

esp_lcd_panel_handle_t board_panel(void) { return panel; }
esp_lcd_panel_io_handle_t board_panel_io(void) { return io; }
