#include "action_journal.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static action_journal_binding_t binding(void) {
    action_journal_binding_t b = {0}; b.owner[0] = 4; b.owner[64] = 7;
    strcpy(b.device_id, "device-1"); strcpy(b.api_origin, "https://example.test:443"); return b;
}
static action_journal_t journal(void) {
    action_journal_t j = {0}; j.count = 2;
    strcpy(j.records[0].id, "5f0c2a7e-3b1d-4c8e-9a6f-2d7b1e4c9a10");
    j.records[0].kind = ACTION_JOURNAL_TASK_COMPLETE; strcpy(j.records[0].target, "task-1");
    j.records[0].lost_rev = 0x12345678; j.records[0].epoch = UINT64_C(0x123456789abcdef0);
    strcpy(j.records[1].id, "6f0c2a7e-3b1d-4c8e-8a6f-2d7b1e4c9a10");
    j.records[1].kind = ACTION_JOURNAL_FOCUS_PAUSE; return j;
}
static uint32_t crc(const uint8_t *p, size_t n) {
    uint32_t c = UINT32_MAX; while (n--) { c ^= *p++; for (int i=0;i<8;i++) c = (c >> 1) ^ (0xedb88320u & (0u-(c&1u))); } return ~c;
}
static void seal(uint8_t *b) { uint32_t c=crc(b,ACTION_JOURNAL_BLOB_SIZE-4); for(unsigned i=0;i<4;i++) b[ACTION_JOURNAL_BLOB_SIZE-4+i]=(uint8_t)(c>>(8*i)); }
static void rejected(uint8_t *b, size_t n, action_journal_binding_t *owner) {
    action_journal_t o, before; memset(&o, 0xa5, sizeof o); memcpy(&before,&o,sizeof o);
    assert(!action_journal_decode(b,n,owner,&o)); assert(!memcmp(&o,&before,sizeof o));
}
int main(void) {
    action_journal_binding_t b=binding(), wrong=b; action_journal_t j=journal(), o;
    uint8_t bytes[ACTION_JOURNAL_BLOB_SIZE], copy[sizeof bytes];
    assert(action_journal_encode(&j,&b,bytes,sizeof bytes)==sizeof bytes);
    assert(!memcmp(bytes,"AJNL\1\2",6)); assert(bytes[6]==4);
    assert(bytes[240+77]==0x78 && bytes[240+80]==0x12);
    assert(bytes[240+81]==0xf0 && bytes[240+88]==0x12);
    assert(crc(bytes,sizeof bytes-4)==((uint32_t)bytes[596] | (uint32_t)bytes[597]<<8 | (uint32_t)bytes[598]<<16 | (uint32_t)bytes[599]<<24));
    assert(action_journal_decode(bytes,sizeof bytes,&b,&o));
    assert(o.count==2 && !strcmp(o.records[0].id,j.records[0].id) && !strcmp(o.records[0].target,"task-1"));
    assert(o.records[0].lost_rev==j.records[0].lost_rev && o.records[0].epoch==j.records[0].epoch);
    assert(o.records[1].kind==ACTION_JOURNAL_FOCUS_PAUSE);
    wrong.owner[64]++; rejected(bytes,sizeof bytes,&wrong); wrong=b; strcpy(wrong.device_id,"device-2"); rejected(bytes,sizeof bytes,&wrong);
    wrong=b; strcpy(wrong.api_origin,"https://other.test"); rejected(bytes,sizeof bytes,&wrong);
    rejected(bytes,sizeof bytes-1,&b); memcpy(copy,bytes,sizeof copy); copy[300]^=1; rejected(copy,sizeof copy,&b);
    const size_t offsets[] = {0,4,5, 6, 71+9, 111+24, 240+36, 240+37+6, 240+2*89};
    for(size_t i=0;i<sizeof offsets/sizeof offsets[0];i++) { memcpy(copy,bytes,sizeof copy); copy[offsets[i]]=0xff; seal(copy); rejected(copy,sizeof copy,&b); }
    memcpy(copy,bytes,sizeof copy); memcpy(copy+240+89,copy+240,36); seal(copy); rejected(copy,sizeof copy,&b);
    memcpy(copy,bytes,sizeof copy); memcpy(copy+240+89,copy+240,89); copy[240+89]= '6'; seal(copy); rejected(copy,sizeof copy,&b);
    memcpy(copy,bytes,sizeof copy); copy[240+14]='3'; seal(copy); rejected(copy,sizeof copy,&b);
    memcpy(copy,bytes,sizeof copy); copy[240+19]='7'; seal(copy); rejected(copy,sizeof copy,&b);
    memcpy(copy,bytes,sizeof copy); copy[240+89+37]='x'; seal(copy); rejected(copy,sizeof copy,&b);
    memset(copy,0xa5,sizeof copy); j.count=5; assert(!action_journal_encode(&j,&b,copy,sizeof copy)); for(size_t i=0;i<sizeof copy;i++) assert(copy[i]==0xa5);
    j=journal(); j.records[0].target[0]=0; assert(!action_journal_encode(&j,&b,copy,sizeof copy));
    j=journal(); memset(j.records[0].target,'x',40); assert(!action_journal_encode(&j,&b,copy,sizeof copy));
    j=journal(); assert(!action_journal_encode(&j,&b,copy,sizeof copy-1));
    j.count=0; assert(action_journal_encode(&j,&b,copy,sizeof copy)); assert(action_journal_decode(copy,sizeof copy,&b,&o) && o.count==0);
    j=journal(); j.count=4;
    j.records[2]=j.records[0]; j.records[2].id[0]='7'; memset(j.records[2].target,'x',39); j.records[2].target[39]=0;
    j.records[3]=j.records[1]; j.records[3].id[0]='8'; j.records[3].kind=ACTION_JOURNAL_FOCUS_START;
    assert(action_journal_encode(&j,&b,copy,sizeof copy)); assert(action_journal_decode(copy,sizeof copy,&b,&o));
    assert(o.count==4 && strlen(o.records[2].target)==39);
    j.records[3].kind=ACTION_JOURNAL_FOCUS_PAUSE; assert(!action_journal_encode(&j,&b,copy,sizeof copy));
    j=journal(); b=binding(); strcpy(b.api_origin,"https://user:secret@example.test"); assert(!action_journal_encode(&j,&b,copy,sizeof copy));
    b=binding(); strcpy(b.api_origin,"https://example.test/path"); assert(!action_journal_encode(&j,&b,copy,sizeof copy));
    puts("action journal tests passed"); return 0;
}
