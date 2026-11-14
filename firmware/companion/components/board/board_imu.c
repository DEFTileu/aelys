/* QMI8658 accelerometer for "always level" (level.h). Accel only, gyro off; nothing runs until board_imu_init(). */
#include "board.h"
#include "esp_log.h"

static const char *TAG = "imu";
static i2c_master_dev_handle_t dev;

static esp_err_t wr(uint8_t reg, uint8_t val)
{
    const uint8_t b[2] = {reg, val};
    return i2c_master_transmit(dev, b, 2, 50);
}

esp_err_t board_imu_init(void)
{
    const uint8_t addrs[] = {0x6B, 0x6A};
    for (size_t i = 0; i < sizeof addrs && !dev; i++) {
        const i2c_device_config_t cfg = {.dev_addr_length = I2C_ADDR_BIT_LEN_7, .device_address = addrs[i],
                                         .scl_speed_hz = 400000};
        i2c_master_dev_handle_t d;
        if (i2c_master_probe(board_i2c_bus(), addrs[i], 50) != ESP_OK) continue;
        if (i2c_master_bus_add_device(board_i2c_bus(), &cfg, &d) != ESP_OK) continue;
        uint8_t reg = 0x00, who = 0; /* WHO_AM_I */
        if (i2c_master_transmit_receive(d, &reg, 1, &who, 1, 50) == ESP_OK && who == 0x05) dev = d;
        else i2c_master_bus_rm_device(d);
    }
    if (!dev) {
        ESP_LOGW(TAG, "QMI8658 not found: eyes will not auto-level");
        return ESP_ERR_NOT_FOUND;
    }
    esp_err_t err = wr(0x02, 0x40);           /* CTRL1: register auto-increment, little-endian */
    if (err == ESP_OK) err = wr(0x03, 0x06);  /* CTRL2: accel +-2 g, ~117 Hz */
    if (err == ESP_OK) err = wr(0x08, 0x01);  /* CTRL7: accel on, gyro off */
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "QMI8658 setup failed (%s)", esp_err_to_name(err));
        i2c_master_bus_rm_device(dev);
        dev = NULL;
    }
    return err;
}

bool board_imu_read(int16_t *ax, int16_t *ay, int16_t *az)
{
    if (!dev) return false;
    uint8_t reg = 0x35, b[6]; /* AX_L .. AZ_H */
    if (i2c_master_transmit_receive(dev, &reg, 1, b, sizeof b, 50) != ESP_OK) return false;
    *ax = (int16_t)(b[0] | b[1] << 8);
    *ay = (int16_t)(b[2] | b[3] << 8);
    *az = (int16_t)(b[4] | b[5] << 8);
    return true;
}
