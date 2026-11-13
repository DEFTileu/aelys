/* Commands from the server. The link answers the two failures it can judge by itself (bad args, unknown name); a
 * valid known command goes to link_deps.on_command (Task F9 handlers). */
#include "esp_log.h"
#include "link_priv.h"

static const char *TAG = "link";

void link_cmd_handle(const proto_msg_t *m, bool args_ok)
{
    if (!args_ok) {
        link_send_ack(m->id, false, "BAD_ARGS");
        return;
    }
    if (m->u.cmd.name == CMD_UNKNOWN) {
        ESP_LOGW(TAG, "unsupported command (%.15s)", m->u.cmd.raw_name);
        link_send_ack(m->id, false, "UNSUPPORTED");
        return;
    }
    if (link_deps.on_command) link_deps.on_command(m);
    else link_send_ack(m->id, false, "UNSUPPORTED");
}
