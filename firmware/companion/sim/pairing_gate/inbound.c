/* Host regression: include the production task so its normal event pump can be stepped. */
#include <assert.h>
#include <stdio.h>
#include <pthread.h>
#include <errno.h>
#include <unistd.h>
#include <setjmp.h>
#include "link.c"

static bool startup_case, fail_task_create, stop_task_at_receive;
static link_pair_result_t startup_pair_result;
static void (*created_task)(void *);
static jmp_buf task_started;
static uint32_t now_ms = 1000, generation;
static char device[40] = "old-device";
static char socket_device[40];
static bool paired = true, send_ok = true;
static bool fake_lost_on(void) { return false; }
static lq_t queue_items[32];
static size_t qhead, qtail;
static char captured[8][1024], captured_owner[8][40];
static size_t capture_n;
static int resets, command_calls, action_events, snapshot_events, freed_slots;
static bool command_parsed;
static snap_t snap_slots[3];
static pthread_mutex_t action_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t send_mutex = PTHREAD_MUTEX_INITIALIZER;
static unsigned mutex_creations;
static pthread_mutex_t queue_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cond = PTHREAD_COND_INITIALIZER;
static bool block_send, send_entered, release_send, commit_done, block_commit, commit_entered, release_commit;
static bool watch_send_wait, send_waiting, watch_action_wait, action_waiting;
static size_t commit_capture_count;
static _Thread_local bool admission_thread;
static bool pause_admission, admission_locked, release_admission;
static void lock(pthread_mutex_t *m) { assert(pthread_mutex_lock(m)==0); }
static void unlock(pthread_mutex_t *m) { assert(pthread_mutex_unlock(m)==0); }
static void signal_gate(void) { assert(pthread_cond_broadcast(&gate_cond)==0); }
static void await_gate(bool *flag) { while (!*flag) assert(pthread_cond_wait(&gate_cond, &gate_mutex)==0); }
tribuf_t ui_snap_tb;

void explicit_bzero(void *p, size_t n) { volatile unsigned char *q = p; while (n--) *q++ = 0; }
int64_t esp_timer_get_time(void) { return (int64_t)now_ms * 1000; }
void esp_fill_random(void *p, size_t n) { memset(p, 0x42, n); }
uint32_t esp_random(void) { return 0; }
size_t heap_caps_get_largest_free_block(int c) { (void)c; return 65536; }
size_t heap_caps_get_free_size(int c) { (void)c; return 65536; }
size_t heap_caps_get_minimum_free_size(int c) { (void)c; return 65536; }
void *heap_caps_calloc(size_t n,size_t s,int c) { (void)c; return calloc(n,s); }
void vTaskDelay(unsigned n) { now_ms += n; }
int xTaskCreatePinnedToCore(void (*fn)(void *), const char *name, unsigned stack, void *arg, int p, void *out, int core) {
    (void)name;(void)stack;(void)arg;(void)p;(void)out;(void)core;
    created_task=fn;
    if (startup_case && !fail_task_create) {
        startup_pair_result=link_pair_commit("new-device");
    }
    return fail_task_create ? 0 : pdPASS;
}
QueueHandle_t xQueueCreate(unsigned n, unsigned s) { assert(n <= 32 && s == sizeof(lq_t)); return queue_items; }
int xQueueSend(QueueHandle_t qh, const void *p, unsigned t) { (void)qh;(void)t; lock(&queue_mutex); assert(qtail < 32); queue_items[qtail++] = *(const lq_t *)p; unlock(&queue_mutex); return pdTRUE; }
int xQueueReceive(QueueHandle_t qh, void *p, unsigned t) { if (stop_task_at_receive) { stop_task_at_receive=false; longjmp(task_started,1); } (void)qh;(void)t; lock(&queue_mutex); if (qhead == qtail) { unlock(&queue_mutex); return 0; } *(lq_t *)p = queue_items[qhead++]; unlock(&queue_mutex); return pdTRUE; }
SemaphoreHandle_t xSemaphoreCreateMutex(void) { return mutex_creations++ == 0 ? &action_mutex : &send_mutex; }
int xSemaphoreTake(SemaphoreHandle_t s, unsigned t) {
    (void)t; int r=pthread_mutex_trylock(s);
    if (r == EBUSY) {
        lock(&gate_mutex);
        if (s == &send_mutex && watch_send_wait) { send_waiting=true; signal_gate(); }
        if (s == &action_mutex && watch_action_wait) { action_waiting=true; signal_gate(); }
        unlock(&gate_mutex); lock(s);
    } else assert(r==0);
    if (s == &action_mutex && admission_thread && pause_admission) {
        lock(&gate_mutex); admission_locked=true; signal_gate(); await_gate(&release_admission); unlock(&gate_mutex);
    }
    return 1;
}
int xSemaphoreGive(SemaphoreHandle_t s) { unlock(s); return 1; }
esp_netif_t *esp_netif_get_handle_from_ifkey(const char *s) { static esp_netif_t net; (void)s; return &net; }
bool esp_netif_is_netif_up(esp_netif_t *n) { (void)n; return true; }
esp_err_t esp_netif_get_ip_info(esp_netif_t *n, esp_netif_ip_info_t *i) { (void)n; i->ip.addr=1; return ESP_OK; }
const esp_app_desc_t *esp_app_get_description(void) { static esp_app_desc_t d={"host"}; return &d; }
const char *esp_err_to_name(esp_err_t e) { (void)e; return "stub"; }
#if !defined(__APPLE__)
size_t strlcpy(char *d,const char *s,size_t cap) { size_t n=strlen(s); if(cap){size_t k=n<cap-1?n:cap-1; memcpy(d,s,k); d[k]=0;} return n; }
#endif
bool lv_port_post(const ui_event_t *e) { if (e->type == UI_EV_ACTION) action_events++; if (e->type == UI_EV_SNAPSHOT) snapshot_events++; return true; }
bool board_battery(uint8_t *p, bool *c) { (void)p;(void)c; return false; }
bool identity_paired(void) { return paired; }
esp_err_t identity_pair_commit(const char *id) {
    lock(&gate_mutex);
    commit_entered=true; signal_gate();
    if (block_commit) await_gate(&release_commit);
    strlcpy(device,id,sizeof device); commit_capture_count=capture_n; commit_done=true; signal_gate();
    unlock(&gate_mutex); return ESP_OK;
}
esp_err_t identity_ids(char d[40], char u[129]) { if(!paired) return ESP_ERR_INVALID_STATE; strlcpy(d,device,40); strlcpy(u,"https://host.invalid",129); return ESP_OK; }
esp_err_t identity_sign(const char *m, char s[87]) { (void)m; strlcpy(s,"fake-signature",87); return ESP_OK; }
esp_err_t identity_wipe_if(const char *d) { if(!paired) return ESP_ERR_INVALID_STATE; if(strcmp(d,device)) return ESP_ERR_NOT_FOUND; paired=false; return ESP_OK; }
link_http_t link_http_challenge(const char *u,const char *d,char id[40],char nonce[80]) { (void)u; assert(!strcmp(d,device)); strlcpy(id,"challenge",40); strlcpy(nonce,"nonce",80); return LH_OK; }
link_http_t link_http_login(const char *u,const char *id,const char *sig,char *token,size_t cap) { (void)u;(void)id;(void)sig; strlcpy(token,device,cap); return LH_OK; }
uint32_t link_ws_open(const char *u,const char *token) { (void)u; strlcpy(socket_device,token,sizeof socket_device); return ++generation; }
void link_ws_close(void) { ++generation; socket_device[0]=0; }
uint32_t link_ws_gen(void) { return generation; }
uint32_t link_ws_last_rx_ms(void) { return now_ms; }
bool link_ws_lost_frame(void) { return false; }
void link_ws_slot_free(int slot) { (void)slot; freed_slots++; }
bool link_ws_send(const char *json,size_t n) {
    if(!send_ok) return false;
    if(strstr(json,"\"type\":\"action\"")) {
        lock(&gate_mutex);
        if (block_send) { send_entered=true; signal_gate(); await_gate(&release_send); }
        assert(capture_n<8 && n<sizeof captured[0]); memcpy(captured[capture_n],json,n); captured[capture_n][n]=0; strlcpy(captured_owner[capture_n],socket_device,40); capture_n++;
        unlock(&gate_mutex);
    }
    return true;
}
void link_cmd_handle(const proto_msg_t *m,bool ok) { assert(m->type == MSG_COMMAND); command_calls++; command_parsed=ok; }
static void reset_revs(void) { resets++; }
static void pump(void) { lq_t e; while(xQueueReceive(q,&e,0)) handle_q(&e); tick(); }
static void ready(void) { char json[128]; snprintf(json,sizeof json,"{\"type\":\"ready\",\"device_id\":\"%s\"}",device); strlcpy(link_mem->rx[0],json,sizeof link_mem->rx[0]); assert(link_q_post(LQ_WS_FRAME,link_ws_gen(),0,(int)strlen(json))); pump(); assert(fsm.st==LS_ONLINE); }
static void result(const char *id) { char json[160]; snprintf(json,sizeof json,"{\"type\":\"action_result\",\"id\":\"%s\",\"ok\":true}",id); strlcpy(link_mem->rx[0],json,sizeof link_mem->rx[0]); assert(link_q_post(LQ_WS_FRAME,link_ws_gen(),0,(int)strlen(json))); pump(); }
static void queue_frame(int slot, uint32_t gen, const char *json) {
    assert(strlen(json) < sizeof link_mem->rx[slot]);
    strlcpy(link_mem->rx[slot], json, sizeof link_mem->rx[slot]);
    assert(link_q_post(LQ_WS_FRAME, gen, slot, (int)strlen(json)));
}
static void one_event(int kind) {
    lq_t e; assert(xQueueReceive(q,&e,0)); assert(e.kind == kind); handle_q(&e);
}
int main(int argc,char **argv) {
    assert(argc==2);
    bool cmd=!strcmp(argv[1],"command"), result_case=!strcmp(argv[1],"result"), snap=!strcmp(argv[1],"snapshot");
    assert(cmd || result_case || snap);
    tribuf_init(&ui_snap_tb,&snap_slots[0],&snap_slots[1],&snap_slots[2]);
    link_deps_t deps={.reset_revs=reset_revs, .lost_on=fake_lost_on}; assert(link_start(&deps)==ESP_OK);
    seen_seq=paired_seq; link_fsm_init(&fsm,identity_paired()); ui_posted=LINK_UI_OFFLINE;
    atomic_store(&link_task_ready, true); /* Explicitly model the initialized task boundary. */
    pump(); assert(fsm.st==LS_CONNECT); ready(); assert(!strcmp(socket_device,"old-device"));
    char frame[512], id[40]="";
    if (result_case) {
        assert(link_post_action(ACT_FOCUS_START,NULL)); pump(); assert(acts.n==1);
        strlcpy(id,acts.a[0].id,sizeof id);
        snprintf(frame,sizeof frame,"{\"type\":\"action_result\",\"id\":\"%s\",\"ok\":true}",id);
    } else if (cmd) {
        strlcpy(frame,"{\"type\":\"command\",\"id\":\"fake-command\",\"name\":\"play_sound\",\"args\":{}}",sizeof frame);
    } else {
        strlcpy(frame,"{\"type\":\"snapshot\",\"snapshot\":{\"generated_at\":\"2026-11-13T09:30:00Z\",\"unread_count\":37}}",sizeof frame);
    }
    proto_msg_t parsed; assert(proto_parse(frame,strlen(frame),&parsed));
    assert(parsed.type == (cmd ? MSG_COMMAND : result_case ? MSG_ACTION_RESULT : MSG_SNAPSHOT));
    uint32_t old_gen=link_ws_gen();
    /* Positive control: the exact valid payload reaches its ordinary effect before pairing. */
    queue_frame(0,old_gen,frame); one_event(LQ_WS_FRAME);
    if (cmd) { assert(command_calls==1 && command_parsed); command_calls=0; }
    if (result_case) {
        assert(action_events==1 && acts.n==0); action_events=0;
        assert(link_post_action(ACT_FOCUS_START,NULL)); pump(); assert(acts.n==1 && !strcmp(id,acts.a[0].id));
    }
    if (snap) {
        bool fresh=false; const snap_t *shown=tribuf_latest(&ui_snap_tb,&fresh);
        assert(fresh && shown->unread==37 && snapshot_events==1 && snap_dirty);
        memset(snap_slots,0,sizeof snap_slots); tribuf_init(&ui_snap_tb,&snap_slots[0],&snap_slots[1],&snap_slots[2]);
        memset(&link_mem->snap,0,sizeof link_mem->snap); snapshot_events=0; snap_dirty=false;
    }
    freed_slots=0;
    queue_frame(0,old_gen,frame); /* Old frame already queued on the old socket. */
    assert(link_pair_commit("new-device")==LINK_PAIR_OK);
    assert(commit_done && !strcmp(device,"new-device") && pair_transition_pending);
    assert(link_ws_gen()==old_gen && fsm.st==LS_ONLINE && !strcmp(socket_device,"old-device"));
    if (result_case) assert(acts.n==0);
    /* Commit queued LQ_PAIRED behind the existing frame. No tick between them. */
    queue_frame(1,old_gen,frame); /* Control: same old generation behind notification. */
    printf("%s: positive control passed; old frame queued -> identity commit -> paired notification queued; old_gen=%u pending=%d\n",argv[1],old_gen,pair_transition_pending);
    one_event(LQ_WS_FRAME); assert(freed_slots==1);
    if (cmd) { assert(command_calls==0); printf("command: valid play_sound frame, fake handler calls=%d\n",command_calls); }
    if (result_case) { assert(action_events==0 && acts.n==0); printf("result: old action discarded at commit; UI action events=%d\n",action_events); }
    if (snap) { bool fresh=false; const snap_t *shown=tribuf_latest(&ui_snap_tb,&fresh); assert(!fresh && shown->unread==0 && snapshot_events==0 && !snap_dirty); printf("snapshot: valid unread=37 frame; UI publishes=%d dirty=%d\n",snapshot_events,snap_dirty); }
    one_event(LQ_PAIRED); assert(link_ws_gen()!=old_gen && resets==1);
    int c=command_calls,a=action_events,s=snapshot_events; int unread=link_mem->snap.unread;
    one_event(LQ_WS_FRAME);
    assert(command_calls==c && action_events==a && snapshot_events==s && link_mem->snap.unread==unread);
    printf("%s: old frame after paired handling dropped (generation changed); PASS\n",argv[1]);
    free(link_mem); return 0;
}
