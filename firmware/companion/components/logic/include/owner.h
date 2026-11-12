#pragma once
/* Owner / emergency contact data shown on the lost-mode and ICE screens. Pure C. */
typedef struct {
    char name[33];
    char phone[24];
    char telegram[33];
    char qr_url[97];
    char message[65];
    char med_note[97];
    char ice_name[2][33];
    char ice_phone[2][24];
} owner_info_t;

/* Zeroes *o, then fills phone/telegram/qr_url from the owner contact header
 * (truncating safely) and message = "If found, please contact". */
void owner_defaults(owner_info_t *o);
