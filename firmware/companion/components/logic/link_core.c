#include <string.h>
#include "link_core.h"

void link_acts_init(link_acts_t *t) { memset(t, 0, sizeof *t); }
void link_acts_discard_all(link_acts_t *t) { memset(t, 0, sizeof *t); }

bool link_acts_add(link_acts_t *t, const char id[37], act_kind_t k, const char *target, uint32_t now_ms)
{
    if (!target) target = "";
    if (t->n >= LINK_ACT_MAX || !id || strlen(id) != 36 || strlen(target) >= sizeof t->a[0].target) return false;
    for (size_t i = 0; i < t->n; i++) if (strcmp(t->a[i].id, id) == 0) return false;
    link_act_t *a = &t->a[t->n];
    memset(a, 0, sizeof *a);
    strcpy(a->id, id);
    strcpy(a->target, target);
    a->kind = k;
    a->t_ms = now_ms;
    t->n++;
    return true;
}

const link_act_t *link_acts_next_unsent(const link_acts_t *t)
{
    for (size_t i = 0; i < t->n; i++)
        if (!t->a[i].ever_sent && !t->a[i].result_pending) return &t->a[i];
    return NULL;
}

void link_acts_attempted(link_acts_t *t, const char *id)
{
    for (size_t i = 0; i < t->n; i++)
        if (strcmp(t->a[i].id, id) == 0) { t->a[i].ever_sent = true; return; }
}

void link_acts_sent(link_acts_t *t, const char *id, uint32_t now_ms)
{
    for (size_t i = 0; i < t->n; i++)
        if (strcmp(t->a[i].id, id) == 0) { t->a[i].sent = true; t->a[i].ever_sent = true; t->a[i].t_ms = now_ms; }
}

static void stage_result(link_act_t *a, bool ok, const char *error);

void link_acts_unsend_all(link_acts_t *t, uint32_t now_ms)
{
    (void)now_ms;
    for (size_t i = 0; i < t->n; i++) {
        link_act_t *a = &t->a[i];
        if (a->result_pending) continue;
        a->sent = false;
        if (!a->ever_sent) { stage_result(a, false, "OFFLINE"); a->timeout_staged = true; }
    }
}

static void drop(link_acts_t *t, size_t i)
{
    memmove(&t->a[i], &t->a[i + 1], (t->n - i - 1) * sizeof t->a[0]);
    t->n--;
}

bool link_acts_done(link_acts_t *t, const char *id, act_kind_t *kind)
{
    for (size_t i = 0; i < t->n; i++)
        if (strcmp(t->a[i].id, id) == 0) {
            *kind = t->a[i].kind;
            drop(t, i);
            return true;
        }
    return false;
}

size_t link_acts_expire(link_acts_t *t, uint32_t now_ms, link_act_t out[LINK_ACT_MAX])
{
    size_t k = 0;
    for (size_t i = 0; i < t->n;) {
        if ((uint32_t)(now_ms - t->a[i].t_ms) >= LINK_ACT_TIMEOUT_MS) {
            out[k++] = t->a[i];
            drop(t, i);
        } else {
            i++;
        }
    }
    return k;
}

static void stage_result(link_act_t *a, bool ok, const char *error)
{
    ui_event_t *e = &a->result;
    memset(e, 0, sizeof *e);
    e->type = UI_EV_ACTION; e->len = 62;
    e->data[0] = (uint8_t)a->kind; e->data[1] = ok;
    if (!ok) {
        const char *msg = error && *error ? error : "ACTION_FAILED";
        size_t n = strlen(msg); if (n > 23) n = 23;
        memcpy(&e->data[2], msg, n);
    }
    memcpy(&e->data[26], a->id, 36);
    a->result_pending = true;
}

bool link_acts_result(link_acts_t *t, const char *id, bool ok, const char *error)
{
    if (!id) return false;
    for (size_t i = 0; i < t->n; i++)
        if (strcmp(t->a[i].id, id) == 0 && !t->a[i].final_pending) {
            link_act_t *a = &t->a[i];
            if (a->result_pending) {
                if (!a->timeout_staged) return false;
                ui_event_t timeout = a->result;
                stage_result(a, ok, error);
                a->final_result = a->result;
                a->result = timeout;
                a->final_pending = true;
            } else { stage_result(a, ok, error); a->final_pending = true; }
            return true;
        }
    return false;
}

void link_acts_stage_expired(link_acts_t *t, uint32_t now_ms)
{
    for (size_t i = 0; i < t->n; i++)
        if (!t->a[i].result_pending && !t->a[i].timeout_staged && !t->a[i].timeout_delivered &&
            (uint32_t)(now_ms - t->a[i].t_ms) >= LINK_ACT_TIMEOUT_MS) {
            stage_result(&t->a[i], false, t->a[i].ever_sent ? "TIMEOUT" : "OFFLINE");
            t->a[i].timeout_staged = true;
        }
}

const ui_event_t *link_acts_pending_result(const link_acts_t *t)
{
    for (size_t i = 0; i < t->n; i++) if (t->a[i].result_pending) return &t->a[i].result;
    return NULL;
}

bool link_acts_delivered(link_acts_t *t, const char *id)
{
    for (size_t i = 0; i < t->n; i++)
        if (t->a[i].result_pending && strcmp(t->a[i].id, id) == 0) {
            link_act_t *a = &t->a[i];
            if (a->timeout_staged) {
                a->timeout_staged = false; a->timeout_delivered = true;
                if (a->final_pending) { a->result = a->final_result; }
                else if (a->ever_sent) a->result_pending = false;
                else drop(t, i);
            } else drop(t, i);
            return true;
        }
    return false;
}

const link_act_t *link_acts_next_lookup(const link_acts_t *t, uint32_t now_ms)
{
    for (size_t i = 0; i < t->n; i++) {
        const link_act_t *a = &t->a[i];
        if (a->ever_sent && (a->timeout_staged || a->timeout_delivered) && !a->final_pending &&
            (!a->lookup_attempts || (uint32_t)(now_ms - a->lookup_ms) >= LINK_ACT_TIMEOUT_MS)) return a;
    }
    return NULL;
}

void link_acts_lookup_attempted(link_acts_t *t, const char *id, uint32_t now_ms)
{
    for (size_t i = 0; i < t->n; i++) if (!strcmp(t->a[i].id, id)) {
        t->a[i].lookup_attempts = 1; t->a[i].lookup_ms = now_ms; return;
    }
}

link_http_t link_http_verdict(int status, const char *body, size_t len)
{
    char code[32];
    if (status == 200) return LH_OK;
    if (status == 401) return proto_error_code(body, len, code) && strcmp(code, "UNAUTHORIZED") == 0 ? LH_UNAUTHORIZED : LH_DENIED;
    return status == 403 ? LH_DENIED : LH_FAIL;
}

bool link_snap_save_due(bool dirty, bool lost_on, bool never_saved, uint32_t since_last_ms)
{
    return dirty && (lost_on || never_saved || since_last_ms >= LINK_SNAP_SAVE_MS);
}
