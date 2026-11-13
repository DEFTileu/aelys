#include "board.h"
#include "board_pins.h"
#include "board_priv.h"
#include "esp_log.h"

static const char *TAG = "board";

/* The AXP2101 powers the panel from its power-on defaults: the Waveshare BSP does not write any rail
 * register. So this only checks that the PMIC answers (chip id, reg 0x03) and logs the rail state;
 * the PWR key / battery gauge are configured by a later task. */
esp_err_t board_power_init(void)
{
    i2c_master_bus_handle_t bus = board_i2c_bus();
    esp_err_t err = i2c_master_probe(bus, I2C_ADDR_AXP2101, 50);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "AXP2101 not answering at 0x%02X (%s)", I2C_ADDR_AXP2101, esp_err_to_name(err));
        return err;
    }
    i2c_master_dev_handle_t dev;
    const i2c_device_config_t cfg = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = I2C_ADDR_AXP2101,
                                     .scl_speed_hz = 400000};
    err = i2c_master_bus_add_device(bus, &cfg, &dev);
    if (err != ESP_OK) return err;
    const uint8_t regs[] = {0x03, 0x80, 0x90, 0x91}; /* chip id, DCDC on/off, LDO on/off 0, LDO on/off 1 */
    uint8_t val[sizeof regs] = {0};
    for (size_t i = 0; i < sizeof regs; i++) {
        err = i2c_master_transmit_receive(dev, &regs[i], 1, &val[i], 1, 50);
        if (err != ESP_OK) break;
    }
    if (err == ESP_OK)
        ESP_LOGI(TAG, "AXP2101 id=0x%02X dcdc=0x%02X ldo0=0x%02X ldo1=0x%02X", val[0], val[1], val[2], val[3]);
    i2c_master_bus_rm_device(dev);
    return err;
}

esp_err_t board_init(void)
{
    esp_err_t err = board_i2c_init();
    if (err != ESP_OK) return err;
    board_power_init(); /* a silent PMIC is not fatal: the rails default to on */
    return board_display_init();
}

/* AXP2101 fuel gauge (datasheet / XPowersLib): 0x00 bit3 = battery present, 0x01 bits 7:5 = 001 charging,
 * 0xA4 = state of charge in percent. A second device handle of its own: the input task keeps the first one. */
#define AXP_STATUS1 0x00
#define AXP_STATUS2 0x01
#define AXP_SOC     0xA4

bool board_battery(uint8_t *pct, bool *charging)
{
    static i2c_master_dev_handle_t dev;
    if (!dev) {
        const i2c_device_config_t cfg = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = I2C_ADDR_AXP2101,
                                         .scl_speed_hz = 400000};
        if (i2c_master_bus_add_device(board_i2c_bus(), &cfg, &dev) != ESP_OK) { dev = NULL; return false; }
    }
    const uint8_t regs[] = {AXP_STATUS1, AXP_STATUS2, AXP_SOC};
    uint8_t v[sizeof regs];
    for (size_t i = 0; i < sizeof regs; i++)
        if (i2c_master_transmit_receive(dev, &regs[i], 1, &v[i], 1, 50) != ESP_OK) return false;
    if (!(v[0] & (1u << 3)) || v[2] > 100) return false; /* no battery, or a gauge that has not settled */
    *pct = v[2];
    *charging = (v[1] >> 5) == 0x01;
    return true;
}
