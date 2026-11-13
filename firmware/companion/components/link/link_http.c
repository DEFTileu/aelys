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

/* POST body to {api_url}{path} with the manual open/write/fetch_headers/read flow: esp_http_client_perform would run its
 * 401 handling (esp_http_check_response -> add_auth), which fails with ESP_ERR_NOT_SUPPORTED when the reply has no
 * WWW-Authenticate header (ours never does) and so hides the status and body we need. The reply body goes to
 * link_mem->http (NUL-terminated). False on any transport failure or a body that does not fit. */
static bool post(const char *api_url, const char *path, const char *body, int *status, size_t *len)
{
    char url[160];
    if (snprintf(url, sizeof url, "%s%s", api_url, path) >= (int)sizeof url) return false;
    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = 1024,
        .buffer_size_tx = 512,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return false;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    int blen = (int)strlen(body);
    esp_err_t err = esp_http_client_open(c, blen);
    if (err == ESP_OK && esp_http_client_write(c, body, blen) != blen) err = ESP_FAIL;
    if (err == ESP_OK && esp_http_client_fetch_headers(c) < 0) err = ESP_FAIL;
    size_t n = 0;
    bool ok = false;
    if (err == ESP_OK) {
        *status = esp_http_client_get_status_code(c);
        n = (size_t)esp_http_client_read_response(c, link_mem->http, LINK_HTTP_MAX - 1);
        ok = n < LINK_HTTP_MAX - 1 || esp_http_client_is_complete_data_received(c); /* a longer body is not one of ours */
    } else {
        int tls = 0, flags = 0;
        esp_err_t last = esp_http_client_get_and_clear_last_tls_error(c, &tls, &flags);
        if (tls != 0 || err == ESP_ERR_NO_MEM) link_tls_failed(); /* a handshake or allocation failure, not DNS or TCP */
        ESP_LOGW(TAG, "http %s failed: %s (tls %d/0x%x)", path, esp_err_to_name(err), tls, (unsigned)last);
    }
    esp_http_client_close(c);
    esp_http_client_cleanup(c);
    link_mem->http[n] = '\0';
    *len = n;
    return ok;
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
        else res = link_http_verdict(status, link_mem->http, len);
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
        else res = link_http_verdict(status, link_mem->http, len);
        if (status == 200) ESP_LOGI(TAG, "login: http 200"); else ESP_LOGW(TAG, "login: http %d", status);
    }
    explicit_bzero(link_mem->http, LINK_HTTP_MAX); /* it held the access token (and any refresh token) */
    return res;
}
