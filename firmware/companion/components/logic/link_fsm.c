#include "link_fsm.h"

#define MAX_EARLY_REJECTS 3 /* 3rd consecutive rejection backs off instead of retrying at once */

void link_fsm_init(link_fsm_t *f, bool paired)
{
    f->st = paired ? LS_WAIT_NET : LS_UNPAIRED;
    f->backoff_ms = 0;
    f->login_rejects = 0;
}

/* 1 s x 2^n capped at 60 s, +-20 % jitter (80..120 %) taken from rnd. */
static link_action_t backoff(link_fsm_t *f, uint32_t rnd, uint32_t *wait_ms)
{
    uint32_t b = f->backoff_ms ? f->backoff_ms * 2 : LINK_BACKOFF_MIN_MS;
    if (b > LINK_BACKOFF_MAX_MS) b = LINK_BACKOFF_MAX_MS;
    f->backoff_ms = b;
    *wait_ms = (uint32_t)((uint64_t)b * (800 + rnd % 401) / 1000);
    f->st = LS_BACKOFF;
    return LA_NONE;
}

static link_action_t go(link_fsm_t *f, link_state_t st, link_action_t a)
{
    f->st = st;
    return a;
}

/* A login that keeps being refused, or a socket refused before it ever opened, must not spin. */
static link_action_t early_reject(link_fsm_t *f, link_state_t st, link_action_t a, uint32_t rnd, uint32_t *wait_ms)
{
    if (f->login_rejects < 255) f->login_rejects++;
    return f->login_rejects >= MAX_EARLY_REJECTS ? backoff(f, rnd, wait_ms) : go(f, st, a);
}

link_action_t link_next(link_fsm_t *f, link_event_t ev, int close_code, uint32_t rnd, uint32_t *wait_ms)
{
    uint32_t dummy;
    if (!wait_ms) wait_ms = &dummy;
    *wait_ms = 0;
    link_state_t s = f->st;

    switch (ev) {
    case LE_UNPAIR:           /* the only unconditional wipe */
        return go(f, LS_UNPAIRED, LA_WIPE_PAIRING);
    case LE_CHALLENGE_UNKNOWN: /* the only server verdict that wipes, and only for a challenge we asked for */
        return s == LS_CHECK ? go(f, LS_UNPAIRED, LA_WIPE_PAIRING) : LA_NONE;
    case LE_PAIRED:
        return s == LS_UNPAIRED ? go(f, LS_LOGIN, LA_LOGIN) : LA_NONE;
    case LE_NET_DOWN:
        if (s == LS_UNPAIRED || s == LS_WAIT_NET) return LA_NONE;
        f->st = LS_WAIT_NET;
        return (s == LS_CONNECT || s == LS_ONLINE) ? LA_CLOSE : LA_NONE;
    case LE_NET_UP:
        return s == LS_WAIT_NET ? go(f, LS_LOGIN, LA_LOGIN) : LA_NONE;
    case LE_LOGIN_OK:
        return s == LS_LOGIN ? go(f, LS_CONNECT, LA_CONNECT) : LA_NONE;
    case LE_LOGIN_REJECTED:
        return s == LS_LOGIN ? early_reject(f, LS_CHECK, LA_CHECK, rnd, wait_ms) : LA_NONE;
    case LE_LOGIN_FAIL:
    case LE_CHALLENGE_FAIL:
        return (s == LS_LOGIN || s == LS_CHECK) ? backoff(f, rnd, wait_ms) : LA_NONE;
    case LE_CHALLENGE_OK:
        return s == LS_CHECK ? go(f, LS_LOGIN, LA_LOGIN) : LA_NONE;
    case LE_WS_OPEN:
        if (s != LS_CONNECT) return LA_NONE;
        f->backoff_ms = 0;
        f->login_rejects = 0;
        return go(f, LS_ONLINE, LA_NONE);
    case LE_WS_CLOSED:
        if (s != LS_CONNECT && s != LS_ONLINE) return LA_NONE;
        if (close_code == 4000) return go(f, LS_REPLACED, LA_NONE);
        if (close_code == 4401 || close_code == 4403) {
            link_state_t next = close_code == 4401 ? LS_LOGIN : LS_CHECK;
            link_action_t act = close_code == 4401 ? LA_LOGIN : LA_CHECK;
            return s == LS_CONNECT ? early_reject(f, next, act, rnd, wait_ms) : go(f, next, act);
        }
        return backoff(f, rnd, wait_ms);
    case LE_TIMER:
        return s == LS_BACKOFF ? go(f, LS_LOGIN, LA_LOGIN) : LA_NONE;
    }
    return LA_NONE;
}
