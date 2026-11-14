/* Host regression: include the production task so its normal event pump can be stepped. */
#include <assert.h>
#include <stdio.h>
#include <pthread.h>
#include <errno.h>
#include <unistd.h>
#include <setjmp.h>
#include "link.c"
#define PAIR_BUSY_ERROR LINK_PAIR_BUSY
#define PAIR_SUCCESS LINK_PAIR_OK
typedef link_pair_result_t pair_result_t;

static bool startup_case;
static pair_result_t startup_pair_result;
static bool fail_task_create, stop_task_at_receive;
static void (*created_task)(void *);
static jmp_buf task_started;
static uint32_t now_ms = 1000, generation;
static char device[40] = "old-device";
static char socket_device[40];
static bool paired = true, send_ok = true, lost_mode;
static bool fake_lost_on(void) { return lost_mode; }
static lq_t queue_items[32];
static size_t qhead, qtail;
static char captured[8][1024], captured_owner[8][40];
static size_t capture_n;
static int resets;
static pthread_mutex_t action_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t send_mutex = PTHREAD_MUTEX_INITIALIZER;
static unsigned mutex_creations;
static pthread_mutex_t queue_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cond = PTHREAD_COND_INITIALIZER;
static bool block_send, send_entered, release_send, commit_done, block_commit, commit_entered, release_commit;
static bool watch_action_wait, action_waiting;
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
    int r=pthread_mutex_trylock(s);
    if (r == EBUSY) {
        lock(&gate_mutex);
        if (s == &action_mutex && watch_action_wait) { action_waiting=true; signal_gate(); }
        unlock(&gate_mutex);
        if (t==0) return 0;
        assert(t==portMAX_DELAY); lock(s);
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
bool lv_port_post(const ui_event_t *e) { (void)e; return true; }
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
void link_ws_slot_free(int slot) { (void)slot; }
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
void link_cmd_handle(const proto_msg_t *m,bool ok) { (void)m;(void)ok; }
static void reset_revs(void) { resets++; }
static void pump(void) { lq_t e; while(xQueueReceive(q,&e,0)) handle_q(&e); tick(); }
static void ready(void) { char json[128]; snprintf(json,sizeof json,"{\"type\":\"ready\",\"device_id\":\"%s\"}",device); strlcpy(link_mem->rx[0],json,sizeof link_mem->rx[0]); assert(link_q_post(LQ_WS_FRAME,link_ws_gen(),0,(int)strlen(json))); pump(); assert(fsm.st==LS_ONLINE); }
static void result(const char *id) { char json[160]; snprintf(json,sizeof json,"{\"type\":\"action_result\",\"id\":\"%s\",\"ok\":true}",id); strlcpy(link_mem->rx[0],json,sizeof link_mem->rx[0]); assert(link_q_post(LQ_WS_FRAME,link_ws_gen(),0,(int)strlen(json))); pump(); }
/* Real link locks and pair entry point; the identity-store and socket boundaries are fakes. */
static void *send_one(void *arg) { (void)arg; lq_t e; assert(xQueueReceive(q,&e,0)); assert(e.kind==LQ_ACTION); handle_q(&e); return NULL; }
static void *pair_one(void *arg) { (void)arg; assert(link_pair_commit("new-device")==PAIR_SUCCESS); return NULL; }
static void *admit_one(void *arg) { bool *accepted=arg; admission_thread=true; *accepted=link_post_action(ACT_FOCUS_START,NULL); return NULL; }
static void concurrency_case(const char *name) {
    pthread_t a, b;
    alarm(10);
    if (!strcmp(name,"inflight")) {
        assert(link_post_action(ACT_FOCUS_START,NULL));
        lock(&gate_mutex); block_send=true; unlock(&gate_mutex);
        assert(pthread_create(&a,NULL,send_one,NULL)==0);
        lock(&gate_mutex); await_gate(&send_entered); unlock(&gate_mutex);
        pair_result_t busy=link_pair_commit("new-device");
        lock(&gate_mutex);
        assert(busy==PAIR_BUSY_ERROR && !commit_entered && !commit_done && capture_n==0);
        assert(!strcmp(device,"old-device"));
        printf("inflight: old send paused; busy pair refused; identity unchanged\n");
        release_send=true; signal_gate(); unlock(&gate_mutex);
        assert(pthread_join(a,NULL)==0);
        assert(capture_n==1 && !strcmp(captured_owner[0],"old-device"));
        assert(link_pair_commit("new-device")==PAIR_SUCCESS);
        assert(commit_done && commit_capture_count==1);
        printf("inflight: retry committed after old send; old captures at commit=%zu\n",commit_capture_count);
        pump(); assert(fsm.st==LS_CONNECT && acts.n==0); ready(); assert(capture_n==1);
        puts("inflight: no old action on new socket; PASS");
    } else if (!strcmp(name,"admission")) {
        lock(&gate_mutex); block_commit=true; unlock(&gate_mutex);
        assert(pthread_create(&a,NULL,pair_one,NULL)==0);
        lock(&gate_mutex); await_gate(&commit_entered); unlock(&gate_mutex);
        bool accepted=link_post_action(ACT_FOCUS_START,NULL);
        lock(&gate_mutex); assert(!accepted && !commit_done && !strcmp(device,"old-device"));
        printf("admission: identity commit paused; busy admission refused\n");
        release_commit=true; signal_gate(); unlock(&gate_mutex);
        assert(pthread_join(a,NULL)==0);
        assert(commit_done && acts.n==0 && capture_n==0);
        assert(!link_post_action(ACT_FOCUS_START,NULL));
        pump(); assert(fsm.st==LS_CONNECT); ready(); assert(capture_n==0);
        assert(link_post_action(ACT_FOCUS_START,NULL));
        pump(); assert(capture_n==1 && !strcmp(captured_owner[0],"new-device"));
        printf("admission: retry accepted and sent after pair transition and new ready\n");
        puts("admission: no old action on new socket; PASS");
    } else {
        assert(!strcmp(name,"admission-first")); bool accepted=false;
        lock(&gate_mutex); pause_admission=true; watch_action_wait=true; unlock(&gate_mutex);
        assert(pthread_create(&a,NULL,admit_one,&accepted)==0);
        lock(&gate_mutex); await_gate(&admission_locked); unlock(&gate_mutex);
        assert(pthread_create(&b,NULL,pair_one,NULL)==0);
        lock(&gate_mutex); await_gate(&action_waiting); assert(!commit_entered);
        printf("admission-first: admission holds action mutex; pair commit blocked before identity commit\n");
        release_admission=true; signal_gate(); unlock(&gate_mutex);
        assert(pthread_join(a,NULL)==0); assert(pthread_join(b,NULL)==0);
        assert(accepted && commit_done && acts.n==0 && capture_n==0);
        printf("admission-first: admitted=%d before commit; commit discarded pending action\n",accepted);
        pump(); assert(fsm.st==LS_CONNECT); ready(); assert(capture_n==0);
        puts("admission-first: no old action on either socket; PASS");
    }
    alarm(0);
}
int main(int argc,char **argv) {
    assert(argc==2);
    startup_case=!strcmp(argv[1],"startup-pair") || !strcmp(argv[1],"startup-failure");
    if (startup_case) {
        alarm(10);
        fail_task_create=!strcmp(argv[1],"startup-failure");
        link_deps_t deps={.reset_revs=reset_revs, .lost_on=fake_lost_on};
        esp_err_t started=link_start(&deps);
        if (fail_task_create) {
            assert(started!=ESP_OK);
            pair_result_t result=link_pair_commit("new-device");
            printf("startup-failure: start=%d pair=%d identity=%s\n",started,result,device);
            if (result!=PAIR_BUSY_ERROR || strcmp(device,"old-device")) {
                puts("RED: pairing committed after task creation failed"); return 1;
            }
            puts("PASS"); return 0;
        }
        assert(started==ESP_OK && created_task);
        printf("startup-pair: commit at task creation boundary returned %d\n",startup_pair_result);
        if (setjmp(task_started)==0) { stop_task_at_receive=true; created_task(NULL); assert(!"task returned"); }
        if (startup_pair_result!=PAIR_SUCCESS) {
            assert(startup_pair_result==PAIR_BUSY_ERROR && !strcmp(device,"old-device"));
            pair_result_t retry=link_pair_commit("new-device");
            printf("startup-pair: retry after task initialization returned %d\n",retry);
            if (retry!=PAIR_SUCCESS) { puts("RED: pairing could not be retried after startup"); return 1; }

        }
        pump(); assert(fsm.st==LS_CONNECT); ready();
        bool accepted=link_post_action(ACT_FOCUS_START,NULL);
        printf("startup-pair: identity=%s online=%d action accepted=%d\n",device,fsm.st==LS_ONLINE,accepted);
        if (!accepted) { puts("RED: committed startup pairing leaves online action admission blocked"); return 1; }
        puts("PASS"); free(link_mem); return 0;
    }
    if (!strcmp(argv[1],"login-pair-connect")) {
        alarm(10);
        link_deps_t deps={.reset_revs=reset_revs, .lost_on=fake_lost_on};
        assert(link_start(&deps)==ESP_OK && created_task);
        if (setjmp(task_started)==0) { stop_task_at_receive=true; created_task(NULL); assert(!"task returned"); }
        assert(do_login()==LE_LOGIN_OK);
        assert(!strcmp(link_mem->token,"old-device") && generation==0);
        assert(link_pair_commit("new-device")==PAIR_SUCCESS);

        assert(!strcmp(device,"new-device"));
        bool connected=do_connect();
        printf("login-pair-connect: connected=%d opens=%u socket=%s identity=%s\n",
               connected,generation,socket_device,device);
        assert(link_mem->token[0]=='\0');
        if (connected || generation!=0) {
            assert(connected && generation==1 && !strcmp(socket_device,"old-device"));
            puts("RED: old websocket opened after pairing");
            free(link_mem); return 1;
        }
        puts("PASS: old websocket not opened after pairing");
        free(link_mem); return 0;
    }
    bool unsent=!strcmp(argv[1],"unsent"), completed=!strcmp(argv[1],"completed"), expired=!strcmp(argv[1],"expired");
    bool lost_case=!strcmp(argv[1],"lost-on") || !strcmp(argv[1],"lost-missing");
    bool concurrent=!strcmp(argv[1],"inflight") || !strcmp(argv[1],"admission") || !strcmp(argv[1],"admission-first");
    assert(unsent || completed || expired || concurrent || lost_case || !strcmp(argv[1],"sent"));
    link_deps_t deps={.reset_revs=reset_revs, .lost_on=fake_lost_on}; assert(link_start(&deps)==ESP_OK);
    assert(created_task);
    if (setjmp(task_started)==0) { stop_task_at_receive=true; created_task(NULL); assert(!"task returned"); }
    pump(); assert(fsm.st==LS_CONNECT); ready();
    if (lost_case) {
        assert(link_post_action(ACT_FOCUS_START,NULL)); pump(); assert(acts.n==1);
        if (!strcmp(argv[1],"lost-on")) lost_mode=true; else link_deps.lost_on=NULL;
        size_t old_tail=qtail, old_captures=capture_n;
        assert(link_pair_commit("new-device")==LINK_PAIR_LOST);
        assert(!commit_entered && !commit_done && !strcmp(device,"old-device"));
        assert(!pair_transition_pending && acts.n==1 && qtail==old_tail && capture_n==old_captures);
        lost_mode=false; link_deps.lost_on=fake_lost_on;
        assert(link_pair_commit("new-device")==LINK_PAIR_OK);
        assert(commit_done && !strcmp(device,"new-device") && pair_transition_pending && acts.n==0);
        printf("%s: pairing failed closed without side effects; retry succeeded; PASS\n",argv[1]);
        free(link_mem); return 0;
    }
    if (concurrent) {
        concurrency_case(argv[1]); free(link_mem); return 0;
    }
    send_ok=!unsent;
    char id[37];
    assert(link_post_action(ACT_FOCUS_START, NULL));
    pump(); assert(acts.n==1);
    strlcpy(id, acts.a[0].id, sizeof id);
    printf("before re-pair: scenario=%s pending=%zu sent=%d captures=%zu id=%s\n",argv[1],acts.n,acts.a[0].sent,capture_n,id);
    if(completed) { result(id); assert(acts.n==0); }
    if(expired) { now_ms += LINK_ACT_TIMEOUT_MS; pump(); assert(acts.n==0); }
    send_ok=true;
    assert(link_pair_commit("new-device")==PAIR_SUCCESS);
    pump(); assert(fsm.st==LS_CONNECT); assert(resets==1); printf("after pair commit: pending=%zu new_socket=%s\n",acts.n,socket_device);
    ready();
    printf("after new ready: pending=%zu captures=%zu\n",acts.n,capture_n);
    for(size_t i=0;i<capture_n;i++) printf("capture[%zu] identity=%s frame=%s\n",i,captured_owner[i],captured[i]);
    size_t expected=unsent ? 0 : 1; assert(capture_n==expected);
    assert(acts.n==0);
    puts("PASS"); free(link_mem); return 0;
}
