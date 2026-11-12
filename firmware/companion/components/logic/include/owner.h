#pragma once
/* Owner / emergency contact data shown on the lost-mode and ICE screens. Pure C. */
#include <stdbool.h>
#include <stdint.h>

/* owner_info_t.show: what the screens may display. */
#define OWNER_SHOW_NAME     1
#define OWNER_SHOW_CONTACTS 2  /* ICE contacts */
#define OWNER_SHOW_MED      4
#define OWNER_SHOW_PHONE    8
#define OWNER_SHOW_TELEGRAM 16
#define OWNER_SHOW_EMAIL    32
#define OWNER_SHOW_ICE      (OWNER_SHOW_NAME | OWNER_SHOW_CONTACTS | OWNER_SHOW_MED) /* the bits owner_apply_ice() sets */

/* owner_info_t.qr: what the lost-mode QR code points at. */
enum { QR_TELEGRAM = 0, QR_PHONE = 1, QR_NONE = 2 };

typedef struct {
    char name[33];
    char phone[24];
    char telegram[33];
    char email[49];
    char qr_url[97];
    char message[65];
    char med_note[97];
    char ice_name[2][33];
    char ice_rel[2][17];
    char ice_phone[2][24];
    uint8_t show;  /* OWNER_SHOW_* */
    uint8_t qr;    /* QR_* */
} owner_info_t;

/* What the device shows while lost mode is on: shown is what the lost and ICE screens display. */
typedef struct { bool on; owner_info_t shown; } lost_state_t;

/* App commands, already decoded and bounded (every string NUL-terminated). */
typedef struct {
    bool on;
    char message[65];
    bool show_phone, show_telegram, show_email;
    char email[49];
    uint8_t qr; /* QR_* */
} lost_cmd_t;

typedef struct {
    char owner_name[33];
    uint8_t n; /* contacts in use, 0..2 */
    char name[2][33], rel[2][17], phone[2][24];
    char med_note[97];
    bool show_name, show_contacts, show_med;
} ice_cmd_t;

/* Zeroes *o, then fills phone/telegram/qr_url from the owner contact header (truncating safely),
 * message = "If found, please contact", show = everything, qr = QR_TELEGRAM. */
void owner_defaults(owner_info_t *o);

/* Writes the ICE fields (name, med_note, ice_*, the OWNER_SHOW_ICE bits) to *owner, and also to
 * lost->shown while lost->on, so the lost screen and the ICE card never disagree. */
void owner_apply_ice(owner_info_t *owner, lost_state_t *lost, const ice_cmd_t *c);
/* on: shown = owner's ICE fields + the factory phone/telegram that the show_* flags allow + message,
 * email, qr (a QR whose target is hidden is dropped, so it cannot leak it). off: only lost->on = false. */
void owner_apply_lost(lost_state_t *lost, const owner_info_t *owner, const lost_cmd_t *c);
