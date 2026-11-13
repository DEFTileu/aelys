#include <string.h>
#include "link_core.h"

void link_acts_init(link_acts_t *t) { memset(t, 0, sizeof *t); }

bool link_acts_add(link_acts_t *t, const char id[37], act_kind_t k, const char *target, uint32_t now_ms)
{
    if (!target) target = "";
    link_act_t *a = &t->a[t->n];
    if (t->n >= LINK_ACT_MAX || !id || strlen(id) >= sizeof a->id || strlen(target) >= sizeof a->target) return false;
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
        if (!t->a[i].sent) return &t->a[i];
    return NULL;
}

void link_acts_sent(link_acts_t *t, const char *id, uint32_t now_ms)
{
    for (size_t i = 0; i < t->n; i++)
        if (strcmp(t->a[i].id, id) == 0) { t->a[i].sent = true; t->a[i].t_ms = now_ms; }
}

void link_acts_unsend_all(link_acts_t *t, uint32_t now_ms)
{
    for (size_t i = 0; i < t->n; i++) { t->a[i].sent = false; t->a[i].t_ms = now_ms; }
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
