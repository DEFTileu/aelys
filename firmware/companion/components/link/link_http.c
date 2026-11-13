/* Device sign-in over HTTPS: POST /auth/device/challenge, POST /auth/device/login. The body of a response is never
 * logged (it holds the access token); only status codes are. */
#include <stdio.h>
#include <string.h>
#include "codec_util.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "link_priv.h"

#define HTTP_TIMEOUT_MS 10000

static const char *TAG = "link";

typedef struct { size_t len; bool over; } resp_t;

static esp_err_t on_http(esp_http_client_event_t *e)
{
    if (e->event_id != HTTP_EVENT_ON_DATA) return ESP_OK;
    resp_t *r = e->user_data;
    if (r->len + (size_t)e->data_len < LINK_HTTP_MAX) {
        memcpy(link_mem->http + r->len, e->data, (size_t)e->data_len);
        r->len += (size_t)e->data_len;
    } else {
        r->over = true;
    }
    return ESP_OK;
}

/* POST body to {api_url}{path}; the response is in link_mem->http (NUL-terminated). False on any transport failure. */
static bool post(const char *api_url, const char *path, const char *body, int *status, size_t *len)
{
    char url[160];
    if (snprintf(url, sizeof url, "%s%s", api_url, path) >= (int)sizeof url) return false;
    resp_t r = {0};
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .event_handler = on_http,
        .user_data = &r,
        .disable_auto_redirect = true,
        .buffer_size = 1024,
        .buffer_size_tx = 512,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return false;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    esp_http_client_set_post_field(c, body, (int)strlen(body));
    esp_err_t err = esp_http_client_perform(c);
    bool ok = err == ESP_OK && !r.over;
    if (err != ESP_OK) {
        int tls = 0, flags = 0;
        esp_err_t last = esp_http_client_get_and_clear_last_tls_error(c, &tls, &flags);
        if (tls != 0 || err == ESP_ERR_NO_MEM) link_tls_failed(); /* a handshake or allocation failure, not DNS or TCP */
        ESP_LOGW(TAG, "http %s failed: %s (tls %d/0x%x)", path, esp_err_to_name(err), tls, (unsigned)last);
    } else {
        *status = esp_http_client_get_status_code(c);
    }
    esp_http_client_cleanup(c);
    link_mem->http[r.len] = '\0';
    *len = r.len;
    return ok;
}

static link_http_t verdict(int status, size_t len)
{
    char code[32];
    if (status == 401) {
        bool known = proto_error_code(link_mem->http, len, code) && strcmp(code, "UNAUTHORIZED") == 0;
        return known ? LH_UNAUTHORIZED : LH_DENIED;
    }
    return status == 403 ? LH_DENIED : LH_FAIL;
}

link_http_t link_http_challenge(const char *api_url, const char *device_id, char id[40], char nonce[80])
{
    char body[96], esc[48];
    if (!json_escape(device_id, esc, sizeof esc)) return LH_FAIL;
    snprintf(body, sizeof body, "{\"device_id\":\"%s\"}", esc);
    int status = 0;
    size_t len = 0;
    link_http_t res = LH_FAIL;
    if (post(api_url, "/auth/device/challenge", body, &status, &len)) {
        if (status == 200) res = proto_parse_challenge(link_mem->http, len, id, nonce) ? LH_OK : LH_FAIL;
        else res = verdict(status, len);
        if (status == 200) ESP_LOGI(TAG, "challenge: http 200"); else ESP_LOGW(TAG, "challenge: http %d", status);
    }
    explicit_bzero(link_mem->http, LINK_HTTP_MAX);
    return res;
}

link_http_t link_http_login(const char *api_url, const char *challenge_id, const char *sig, char *token, size_t cap)
{
    char body[256], eid[48], esig[96];
    if (!json_escape(challenge_id, eid, sizeof eid) || !json_escape(sig, esig, sizeof esig)) return LH_FAIL;
    snprintf(body, sizeof body, "{\"challenge_id\":\"%s\",\"signature\":\"%s\"}", eid, esig);
    int status = 0;
    size_t len = 0;
    link_http_t res = LH_FAIL;
    if (post(api_url, "/auth/device/login", body, &status, &len)) {
        if (status == 200) res = proto_parse_login(link_mem->http, len, token, cap) ? LH_OK : LH_FAIL; /* a refresh token, if any, is never read */
        else res = verdict(status, len);
        if (status == 200) ESP_LOGI(TAG, "login: http 200"); else ESP_LOGW(TAG, "login: http %d", status);
    }
    explicit_bzero(link_mem->http, LINK_HTTP_MAX); /* it held the access token (and any refresh token) */
    return res;
}
