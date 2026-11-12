#include <string.h>
#include "owner.h"

#ifndef OWNER_CONTACT_HEADER
#define OWNER_CONTACT_HEADER "owner_contact.local.h"
#endif
#include OWNER_CONTACT_HEADER

static void copy_trunc(char *dst, size_t cap, const char *src)
{
    size_t n = strlen(src);
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

void owner_defaults(owner_info_t *o)
{
    memset(o, 0, sizeof *o);
    copy_trunc(o->phone, sizeof o->phone, OWNER_PHONE);
    copy_trunc(o->telegram, sizeof o->telegram, OWNER_TELEGRAM);
    copy_trunc(o->qr_url, sizeof o->qr_url, OWNER_QR_URL);
    copy_trunc(o->message, sizeof o->message, "If found, please contact");
}
