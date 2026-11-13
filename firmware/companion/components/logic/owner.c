#include <string.h>
#include "codec_util.h"
#include "owner.h"

#ifndef OWNER_CONTACT_HEADER
#define OWNER_CONTACT_HEADER "owner_contact.local.h"
#endif
#include OWNER_CONTACT_HEADER

/* UTF-8-safe, always terminated; src may be a full array with no terminator. */
static void copy_field(char *dst, size_t cap, const char *src, size_t scap)
{
    const char *z = memchr(src, 0, scap);
    size_t n = z ? (size_t)(z - src) : scap - 1;
    utf8_copy(dst, cap, src, n < cap - 1 ? n : cap - 1);
}
#define CP(d, s) copy_field(d, sizeof d, s, sizeof s)

void owner_defaults(owner_info_t *o)
{
    memset(o, 0, sizeof *o);
    copy_field(o->phone, sizeof o->phone, OWNER_PHONE, sizeof OWNER_PHONE);
    copy_field(o->telegram, sizeof o->telegram, OWNER_TELEGRAM, sizeof OWNER_TELEGRAM);
    copy_field(o->qr_url, sizeof o->qr_url, OWNER_QR_URL, sizeof OWNER_QR_URL);
    copy_field(o->message, sizeof o->message, "If found, please contact", sizeof "If found, please contact");
    o->show = OWNER_SHOW_ICE | OWNER_SHOW_PHONE | OWNER_SHOW_TELEGRAM | OWNER_SHOW_EMAIL;
}

static void put_ice(owner_info_t *o, const ice_cmd_t *c)
{
    CP(o->name, c->owner_name);
    CP(o->med_note, c->med_note);
    for (int i = 0; i < 2; i++) {
        bool use = i < c->n;
        if (use) { CP(o->ice_name[i], c->name[i]); CP(o->ice_rel[i], c->rel[i]); CP(o->ice_phone[i], c->phone[i]); }
        else { o->ice_name[i][0] = o->ice_rel[i][0] = o->ice_phone[i][0] = 0; }
    }
    o->show = (uint8_t)((o->show & ~OWNER_SHOW_ICE) | (c->show_name ? OWNER_SHOW_NAME : 0) |
                        (c->show_contacts ? OWNER_SHOW_CONTACTS : 0) | (c->show_med ? OWNER_SHOW_MED : 0));
}

static bool stale(uint32_t cmd_rev, uint32_t applied) { return cmd_rev != 0 && cmd_rev <= applied; }

bool owner_apply_ice(owner_info_t *owner, lost_state_t *lost, const ice_cmd_t *c)
{
    if (stale(c->rev, owner->ice_rev)) return false;
    put_ice(owner, c);
    if (lost->on) put_ice(&lost->shown, c);
    if (c->rev) owner->ice_rev = c->rev;
    return true;
}

bool owner_apply_lost(lost_state_t *lost, const owner_info_t *owner, const lost_cmd_t *c)
{
    if (stale(c->rev, lost->rev)) return false;
    if (c->rev) lost->rev = c->rev;
    if (!c->on) { lost->on = false; return true; }
    owner_info_t f, *s = &lost->shown;
    owner_defaults(&f); /* lost mode shows the factory contacts, never fields the app did not choose */
    *s = *owner;        /* keeps the ICE fields */
    memset(s->phone, 0, sizeof s->phone);
    memset(s->telegram, 0, sizeof s->telegram);
    memset(s->email, 0, sizeof s->email);
    memset(s->qr_url, 0, sizeof s->qr_url);
    if (c->show_phone) CP(s->phone, f.phone);
    if (c->show_telegram) CP(s->telegram, f.telegram);
    if (c->show_email) CP(s->email, c->email);
    CP(s->message, c->message);
    s->qr = c->qr <= QR_NONE ? c->qr : QR_NONE;
    if (s->qr == QR_TELEGRAM && c->show_telegram) CP(s->qr_url, f.qr_url);
    if (s->qr == QR_PHONE && s->phone[0]) {
        size_t n = 4;
        memcpy(s->qr_url, "tel:", 4);
        for (const char *p = s->phone; *p && n < sizeof s->qr_url - 1; p++) /* a tel: URI has no spaces */
            if ((*p >= '0' && *p <= '9') || *p == '+') s->qr_url[n++] = *p;
    }
    s->show = (uint8_t)((owner->show & OWNER_SHOW_ICE) | (c->show_phone ? OWNER_SHOW_PHONE : 0) |
                        (c->show_telegram ? OWNER_SHOW_TELEGRAM : 0) | (c->show_email ? OWNER_SHOW_EMAIL : 0));
    lost->on = true;
    return true;
}

void settings_defaults(settings_t *s)
{
    s->brightness = BRIGHTNESS_MAX;
    s->rev = 0;
}

bool settings_apply(settings_t *s, uint8_t pct, uint32_t rev)
{
    if (stale(rev, s->rev)) return false;
    s->brightness = pct < BRIGHTNESS_MIN ? BRIGHTNESS_MIN : pct > BRIGHTNESS_MAX ? BRIGHTNESS_MAX : pct;
    if (rev) s->rev = rev;
    return true;
}

uint8_t brightness_raw(uint8_t pct)
{
    uint32_t p = pct < BRIGHTNESS_MIN ? BRIGHTNESS_MIN : pct > BRIGHTNESS_MAX ? BRIGHTNESS_MAX : pct;
    return (uint8_t)((p * 255 + 50) / 100);
}
