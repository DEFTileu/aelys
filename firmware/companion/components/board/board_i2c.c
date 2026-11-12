#include "board.h"
#include "board_pins.h"
#include "board_priv.h"

static i2c_master_bus_handle_t bus;

esp_err_t board_i2c_init(void)
{
    const i2c_master_bus_config_t cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = PIN_I2C_SDA,
        .scl_io_num = PIN_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    return i2c_new_master_bus(&cfg, &bus);
}

i2c_master_bus_handle_t board_i2c_bus(void) { return bus; }
