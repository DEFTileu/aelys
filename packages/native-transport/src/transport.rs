use reqwest::{Client, Method, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;
use tauri::ipc::Channel;
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{State, WebviewWindow};
use tokio::sync::{watch, Mutex};
use url::{Host, Url};

#[cfg(target_os = "macos")]
const SERVICE: &str = "com.aelys.desktop.native-session";
const MAX_JSON: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub struct NativeState(Mutex<Option<Session>>);
#[derive(Default)]
pub struct NativeAIStreams(Mutex<HashMap<String, ActiveAIStream>>);
struct ActiveAIStream {
    origin: String,
    cancel: watch::Sender<bool>,
}
impl NativeAIStreams {
    async fn close_for_origin(&self, origin: Option<&str>) {
        let registry = self.0.lock().await;
        for active in registry
            .values()
            .filter(|active| origin.is_none_or(|value| active.origin == value))
        {
            let _ = active.cancel.send(true);
        }
    }
}
struct Session {
    origin: String,
    access: String,
    record: Record,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    origin: String,
    owner_id: String,
    device_id: String,
    refresh_token: String,
}
#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    owner_id: String,
    device_id: String,
    token_type: String,
    expires_in: u64,
}
#[derive(Serialize)]
pub struct SafeStatus {
    signed_in: bool,
    owner_id: Option<String>,
    device_id: Option<String>,
    can_resume: Option<bool>,
    initialized: Option<bool>,
    biometric_locked: bool,
}
#[derive(Deserialize)]
struct Initialized {
    initialized: bool,
}

fn err(code: &str) -> String {
    code.to_owned()
}
fn origin(input: &str) -> Result<String, String> {
    origin_for(input, cfg!(target_os = "android"))
}
fn origin_for(input: &str, android: bool) -> Result<String, String> {
    if input.len() > 2048 || input.trim() != input || input.contains('\\') {
        return Err(err("INVALID_ORIGIN"));
    }
    let parsed = Url::parse(input).map_err(|_| err("INVALID_ORIGIN"))?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(err("INVALID_ORIGIN"));
    }
    // Reject explicit empty userinfo, non-origin paths and URL normalization tricks.
    let authority = input
        .split_once("://")
        .ok_or_else(|| err("INVALID_ORIGIN"))?
        .1;
    if authority.contains('@')
        || authority.contains('?')
        || authority.contains('#')
        || authority.contains('/')
    {
        return Err(err("INVALID_ORIGIN"));
    }
    match (parsed.scheme(), parsed.host()) {
        ("https", Some(_)) => {}
        ("http", Some(Host::Ipv4(ip)))
            if !android
                && ip.octets() == [127, 0, 0, 1]
                && authority.split(':').next() == Some("127.0.0.1") => {}
        ("http", Some(Host::Ipv6(ip)))
            if !android && ip.is_loopback() && authority.starts_with("[::1]") => {}
        _ => return Err(err("INVALID_ORIGIN")),
    }
    Ok(parsed.origin().ascii_serialization())
}
fn authorized_for(label: &str, current: &Url, debug: bool, android: bool) -> bool {
    if label != "main"
        || !current.username().is_empty()
        || current.password().is_some()
        || current.port().is_some_and(|p| p != 5173)
    {
        return false;
    }
    if android {
        current.scheme() == "http"
            && current.host_str() == Some("tauri.localhost")
            && current.port().is_none()
    } else {
        (current.scheme() == "tauri"
            && current.host_str() == Some("localhost")
            && current.port().is_none())
            || (debug
                && current.scheme() == "http"
                && current.host_str() == Some("127.0.0.1")
                && current.port() == Some(5173))
    }
}
fn authorized(label: &str, current: &Url, debug: bool) -> bool {
    authorized_for(label, current, debug, cfg!(target_os = "android"))
}
fn check_window(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| err("FORBIDDEN"))?;
    if authorized(window.label(), &url, cfg!(debug_assertions)) {
        Ok(())
    } else {
        Err(err("FORBIDDEN"))
    }
}
fn client() -> Result<Client, String> {
    client_with_timeout(Duration::from_secs(15))
}
fn stream_client() -> Result<Client, String> {
    client_with_timeout(Duration::from_secs(300))
}
fn client_with_timeout(timeout: Duration) -> Result<Client, String> {
    let builder = Client::builder();
    // Android has no host OpenSSL. Use a standard WebPKI root set with normal
    // chain/hostname validation; no custom verifier or invalid-cert exceptions.
    #[cfg(target_os = "android")]
    let builder = {
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| err("TRANSPORT_UNAVAILABLE"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
        builder.tls_backend_preconfigured(config)
    };
    builder
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .build()
        .map_err(|_| err("TRANSPORT_UNAVAILABLE"))
}
async fn request<T: DeserializeOwned>(
    client: &Client,
    method: Method,
    url: &str,
    body: Option<Value>,
    access: Option<&str>,
) -> Result<T, String> {
    request_with_key(client, method, url, body, None, access).await
}
async fn request_with_key<T: DeserializeOwned>(
    client: &Client,
    method: Method,
    url: &str,
    body: Option<Value>,
    idempotency_key: Option<&str>,
    access: Option<&str>,
) -> Result<T, String> {
    let mut builder = client.request(method, url);
    if let Some(body) = body {
        builder = builder.json(&body);
    }
    if let Some(token) = access {
        builder = builder.bearer_auth(token);
    }
    if let Some(key) = idempotency_key {
        builder = builder.header("Idempotency-Key", key);
    }
    let mut response = builder.send().await.map_err(|_| err("NETWORK_ERROR"))?;
    if !response.status().is_success() {
        return Err(match response.status() {
            StatusCode::UNAUTHORIZED => err("UNAUTHORIZED"),
            StatusCode::FORBIDDEN => err("FORBIDDEN"),
            StatusCode::CONFLICT => err("CONFLICT"),
            StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => err("VALIDATION_ERROR"),
            _ => err("BACKEND_ERROR"),
        });
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_JSON as u64)
    {
        return Err(err("RESPONSE_TOO_LARGE"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| err("NETWORK_ERROR"))? {
        if bytes.len().saturating_add(chunk.len()) > MAX_JSON {
            return Err(err("RESPONSE_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| err("INVALID_RESPONSE"))
}
async fn request_ai_events(
    client: &Client,
    url: &str,
    access: &str,
) -> Result<Vec<AIEvent>, String> {
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let mut events = Vec::new();
    stream_ai_events(client, url, access, cancel_rx, |event| {
        events.push(event);
        std::future::ready(Ok(()))
    })
    .await?;
    Ok(events)
}

async fn stream_ai_events<F, Fut>(
    client: &Client,
    url: &str,
    access: &str,
    mut cancel: watch::Receiver<bool>,
    mut emit: F,
) -> Result<(), String>
where
    F: FnMut(AIEvent) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let request = client
        .get(url)
        .header("Accept", "text/event-stream")
        .bearer_auth(access)
        .send();
    let mut response = tokio::select! {
        _ = cancel.changed() => return Err(err("STREAM_ABORTED")),
        response = request => response.map_err(|_| err("NETWORK_ERROR"))?,
    };
    if !response.status().is_success() {
        return Err(match response.status() {
            StatusCode::UNAUTHORIZED => err("UNAUTHORIZED"),
            StatusCode::FORBIDDEN => err("FORBIDDEN"),
            StatusCode::NOT_FOUND => err("NOT_FOUND"),
            _ => err("BACKEND_ERROR"),
        });
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_JSON as u64)
    {
        return Err(err("RESPONSE_TOO_LARGE"));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if content_type.split(';').next().map(str::trim) != Some("text/event-stream") {
        return Err(err("INVALID_RESPONSE"));
    }
    let mut decoder = AIEventDecoder::default();
    loop {
        let chunk = tokio::select! {
            _ = cancel.changed() => return Err(err("STREAM_ABORTED")),
            chunk = response.chunk() => chunk.map_err(|_| err("NETWORK_ERROR"))?,
        };
        let Some(chunk) = chunk else {
            break;
        };
        for event in decoder.push(&chunk)? {
            if *cancel.borrow() {
                return Err(err("STREAM_ABORTED"));
            }
            emit(event).await?;
        }
    }
    // An interrupted frame must never be reported as successful completion.
    if !decoder.pending.iter().all(u8::is_ascii_whitespace) {
        return Err(err("INVALID_RESPONSE"));
    }
    Ok(())
}

#[derive(Default)]
struct AIEventDecoder {
    pending: Vec<u8>,
    total: usize,
    scanned: usize,
}
impl AIEventDecoder {
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<AIEvent>, String> {
        self.total = self.total.saturating_add(chunk.len());
        if self.total > MAX_JSON {
            return Err(err("RESPONSE_TOO_LARGE"));
        }
        self.pending.extend_from_slice(chunk);
        let mut events = Vec::new();
        let mut consumed = 0;
        while self.scanned < self.pending.len() {
            self.scanned += 1;
            let end = self.scanned;
            let width = if end - consumed >= 2 && &self.pending[end - 2..end] == b"\n\n" {
                2
            } else if end - consumed >= 4 && &self.pending[end - 4..end] == b"\r\n\r\n" {
                4
            } else {
                continue;
            };
            let block = std::str::from_utf8(&self.pending[consumed..end - width])
                .map_err(|_| err("INVALID_RESPONSE"))?;
            events.extend(parse_ai_events(block)?);
            consumed = end;
        }
        if consumed > 0 {
            // Scan each byte once and shift the incomplete tail only once per
            // network chunk, even when a chunk contains many complete events.
            self.pending.drain(..consumed);
            self.scanned -= consumed;
        }
        Ok(events)
    }
}
fn parse_ai_events(source: &str) -> Result<Vec<AIEvent>, String> {
    let allowed = [
        "ai.run.started",
        "ai.run.in_progress",
        "ai.run.completed",
        "ai.run.failed",
        "ai.run.cancelled",
        "ai.text.delta",
        "ai.tool.requested",
        "ai.tool.approved",
        "ai.tool.result",
    ];
    let mut events = Vec::new();
    let normalized = source.replace("\r\n", "\n");
    for block in normalized.split("\n\n") {
        let block = block.trim();
        if block.is_empty()
            || block
                .lines()
                .all(|line| line.is_empty() || line.starts_with(':'))
        {
            continue;
        }
        let event = block
            .lines()
            .find_map(|line| line.strip_prefix("event:"))
            .map(str::trim)
            .ok_or_else(|| err("INVALID_RESPONSE"))?;
        if !allowed.contains(&event) {
            return Err(err("INVALID_RESPONSE"));
        }
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        let mut data: Value = serde_json::from_str(&data).map_err(|_| err("INVALID_RESPONSE"))?;
        redact_json_secrets(&mut data);
        let id = block
            .lines()
            .find_map(|line| line.strip_prefix("id:"))
            .map(|v| v.trim().to_owned());
        events.push(AIEvent {
            id,
            event: event.to_owned(),
            data,
        });
    }
    Ok(events)
}
fn redact_json_secrets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in [
                "api_key",
                "secret",
                "token",
                "access_token",
                "refresh_token",
            ] {
                map.remove(key);
            }
            for child in map.values_mut() {
                redact_json_secrets(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                redact_json_secrets(child);
            }
        }
        _ => {}
    }
}
trait Store {
    async fn read(&self, origin: &str) -> Result<Option<Record>, String>;
    async fn exists(&self, origin: &str) -> Result<bool, String> {
        self.read(origin).await.map(|record| record.is_some())
    }
    async fn write(&self, origin: &str, record: &Record) -> Result<(), String>;
    async fn delete(&self, origin: &str) -> Result<(), String>;
}
pub struct NativeStorage {
    #[cfg(target_os = "android")]
    android: tauri_plugin_aelys_session_store::AndroidSessionStore<tauri::Wry>,
}
impl NativeStorage {
    pub fn new(_app: &tauri::AppHandle) -> Self {
        Self {
            #[cfg(target_os = "android")]
            android: _app
                .state::<tauri_plugin_aelys_session_store::AndroidSessionStore<tauri::Wry>>()
                .inner()
                .clone(),
        }
    }
}
#[cfg(target_os = "macos")]
impl Store for NativeStorage {
    async fn exists(&self, origin: &str) -> Result<bool, String> {
        let origin = origin.to_owned();
        tauri::async_runtime::spawn_blocking(move || crate::keychain::exists(SERVICE, &origin))
            .await
            .map_err(|_| err("STORAGE_ERROR"))?
    }
    async fn read(&self, origin: &str) -> Result<Option<Record>, String> {
        let owned_origin = origin.to_owned();
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            crate::keychain::read(SERVICE, &owned_origin)
        })
        .await
        .map_err(|_| err("STORAGE_ERROR"))??;
        match bytes {
            Some(bytes) => {
                let record: Record =
                    serde_json::from_slice(&bytes).map_err(|_| err("STORAGE_ERROR"))?;
                if record.origin != origin {
                    return Err(err("STORAGE_ERROR"));
                }
                Ok(Some(record))
            }
            None => Ok(None),
        }
    }
    async fn write(&self, origin: &str, record: &Record) -> Result<(), String> {
        let bytes = serde_json::to_vec(record).map_err(|_| err("STORAGE_ERROR"))?;
        crate::keychain::write(SERVICE, origin, &bytes)
    }
    async fn delete(&self, origin: &str) -> Result<(), String> {
        crate::keychain::delete(SERVICE, origin)
    }
}
#[cfg(not(any(target_os = "macos", target_os = "android")))]
impl Store for NativeStorage {
    async fn read(&self, _: &str) -> Result<Option<Record>, String> {
        Err(err("STORAGE_UNAVAILABLE"))
    }
    async fn write(&self, _: &str, _: &Record) -> Result<(), String> {
        Err(err("STORAGE_UNAVAILABLE"))
    }
    async fn delete(&self, _: &str) -> Result<(), String> {
        Err(err("STORAGE_UNAVAILABLE"))
    }
}
#[cfg(target_os = "android")]
impl Store for NativeStorage {
    async fn read(&self, origin: &str) -> Result<Option<Record>, String> {
        self.android
            .read(origin)
            .await
            .map_err(|_| err("STORAGE_ERROR"))?
            .map(|value| {
                let record: Record =
                    serde_json::from_str(&value).map_err(|_| err("STORAGE_ERROR"))?;
                if record.origin != origin {
                    return Err(err("STORAGE_ERROR"));
                }
                Ok(record)
            })
            .transpose()
    }
    async fn write(&self, origin: &str, record: &Record) -> Result<(), String> {
        let value = serde_json::to_string(record).map_err(|_| err("STORAGE_ERROR"))?;
        self.android
            .write(origin, &value)
            .await
            .map_err(|_| err("STORAGE_ERROR"))
    }
    async fn delete(&self, origin: &str) -> Result<(), String> {
        self.android
            .delete(origin)
            .await
            .map_err(|_| err("STORAGE_ERROR"))
    }
}
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn session_from(origin: &str, token: Tokens) -> Result<Session, String> {
    if token.token_type != "bearer"
        || token.expires_in == 0
        || token.access_token.is_empty()
        || token.refresh_token.is_empty()
        || !valid_id(&token.owner_id)
        || !valid_id(&token.device_id)
    {
        return Err(err("INVALID_RESPONSE"));
    }
    Ok(Session {
        origin: origin.into(),
        access: token.access_token,
        record: Record {
            origin: origin.into(),
            owner_id: token.owner_id,
            device_id: token.device_id,
            refresh_token: token.refresh_token,
        },
    })
}
async fn persist(store: &impl Store, session: &Session) -> Result<(), String> {
    store.write(&session.origin, &session.record).await
}
async fn take_record(store: &impl Store, origin: &str) -> Result<Record, String> {
    let record = store
        .read(origin)
        .await?
        .ok_or_else(|| err("SIGN_IN_REQUIRED"))?;
    store.delete(origin).await?;
    Ok(record)
}
async fn prepare_resume(
    state: &mut Option<Session>,
    streams: &NativeAIStreams,
    store: &impl Store,
    origin: &str,
    authorize: impl Future<Output = Result<(), String>>,
) -> Result<Record, String> {
    // Never consume a rotating credential or cancel a live session on a denied
    // local authentication attempt. Keep all state transitions after the gate.
    authorize.await?;
    // OS denial while reading/consuming the credential must also leave any
    // live in-memory session and subscriptions intact.
    let record = take_record(store, origin).await?;
    streams.close_for_origin(None).await;
    *state = None;
    Ok(record)
}
async fn persist_or_revoke(
    client: &Client,
    store: &impl Store,
    session: Session,
) -> Result<Session, String> {
    if let Err(error) = persist(store, &session).await {
        let _: Result<Value, _> = request(
            client,
            Method::POST,
            &format!("{}/api/v1/auth/native/logout", session.origin),
            Some(json!({"refresh_token": session.record.refresh_token})),
            None,
        )
        .await;
        return Err(err(if error == "KEYCHAIN_ACCESS_REQUIRED" {
            "KEYCHAIN_ACCESS_REQUIRED"
        } else {
            "STORAGE_ERROR"
        }));
    }
    Ok(session)
}
fn status(
    session: Option<&Session>,
    origin: &str,
    resume: Option<bool>,
    initialized: Option<bool>,
) -> SafeStatus {
    let s = session.filter(|s| s.origin == origin);
    SafeStatus {
        signed_in: s.is_some(),
        owner_id: s.map(|s| s.record.owner_id.clone()),
        device_id: s.map(|s| s.record.device_id.clone()),
        can_resume: resume,
        initialized,
        biometric_locked: false,
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskInput {
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    parent_task_id: Option<String>,
    #[serde(default = "todo")]
    status: String,
    #[serde(default)]
    priority: i32,
    #[serde(default)]
    due_at: Option<String>,
    #[serde(default)]
    due_timezone: Option<String>,
    #[serde(default)]
    rrule: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NoteInput {
    title: String,
    #[serde(default)]
    markdown_body: String,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectInput {
    name: String,
    #[serde(default)]
    description: String,
}
fn valid_project(project: &ProjectInput) -> bool {
    !project.name.trim().is_empty()
        && project.name.len() <= 200
        && project.description.len() <= 500_000
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectPatchInput {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<String>,
}
fn valid_project_patch(project: &ProjectPatchInput) -> bool {
    project
        .name
        .as_deref()
        .is_none_or(|value| !value.trim().is_empty() && value.len() <= 200)
        && project
            .description
            .as_deref()
            .is_none_or(|value| value.len() <= 500_000)
        && project
            .status
            .as_deref()
            .is_none_or(|value| value.len() <= 20)
}
fn valid_note(note: &NoteInput) -> bool {
    !note.title.trim().is_empty()
        && note.title.len() <= 300
        && note.markdown_body.len() <= 500_000
        && note.parent_id.as_deref().is_none_or(valid_id)
        && note.project_id.as_deref().is_none_or(valid_id)
}
fn todo() -> String {
    "todo".into()
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskUpdate {
    title: String,
    description: String,
    #[serde(deserialize_with = "required_optional")]
    project_id: Option<String>,
    #[serde(deserialize_with = "required_optional")]
    parent_task_id: Option<String>,
    status: String,
    priority: i32,
    #[serde(deserialize_with = "required_optional")]
    due_at: Option<String>,
    #[serde(deserialize_with = "required_optional")]
    due_timezone: Option<String>,
    #[serde(deserialize_with = "required_optional")]
    rrule: Option<String>,
}
fn required_optional<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
impl From<TaskUpdate> for TaskInput {
    fn from(t: TaskUpdate) -> Self {
        Self {
            title: t.title,
            description: t.description,
            project_id: t.project_id,
            parent_task_id: t.parent_task_id,
            status: t.status,
            priority: t.priority,
            due_at: t.due_at,
            due_timezone: t.due_timezone,
            rrule: t.rrule,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Me {},
    Projects {},
    ProjectCreate {
        project: ProjectInput,
    },
    ProjectPatch {
        id: String,
        version: u64,
        project: ProjectPatchInput,
    },
    ProjectDelete {
        id: String,
    },
    Tasks {
        project_id: Option<String>,
    },
    Notes {},
    NoteCreate {
        note: NoteInput,
    },
    NotePatch {
        id: String,
        version: u64,
        note: NoteInput,
    },
    NoteDelete {
        id: String,
    },
    CalendarOccurrences {
        starts_at: String,
        ends_at: String,
    },
    CalendarEvents {},
    CalendarEventCreate {
        event: CalendarEventInput,
    },
    CalendarEventPatch {
        id: String,
        version: u64,
        event: CalendarEventInput,
    },
    CalendarEventDelete {
        id: String,
        version: u64,
    },
    CalendarReminders {
        event_id: String,
    },
    CalendarReminderCreate {
        event_id: String,
        reminder: CalendarReminderInput,
    },
    CalendarReminderDelete {
        event_id: String,
        reminder_id: String,
        version: u64,
    },
    CalendarReminderDispatch {},
    FinanceTransactions {},
    FinanceAccounts {},
    FinanceCategories {},
    FinanceBudgets {},
    FinanceSummary {},
    FinanceAccountCreate {
        account: FinanceAccountInput,
    },
    FinanceCategoryCreate {
        category: FinanceCategoryInput,
    },
    FinanceTransactionCreate {
        transaction: FinanceTransactionInput,
    },
    FinanceBudgetCreate {
        budget: FinanceBudgetInput,
    },
    FinanceTransferCreate {
        transfer: FinanceTransferInput,
    },
    FocusSessions {},
    FocusStart {
        focus: FocusInput,
        idempotency_key: Option<String>,
    },
    FocusStop {
        id: String,
        version: u64,
    },
    MailMessages {},
    MailAccounts {},
    GmailStatus {},
    #[serde(rename = "ai_providers")]
    AIProviders {},
    #[serde(rename = "ai_conversations")]
    AIConversations {},
    #[serde(rename = "ai_messages")]
    AIMessages {
        conversation_id: String,
    },
    #[serde(rename = "ai_conversation_create")]
    AIConversationCreate {
        conversation: AIConversationInput,
    },
    #[serde(rename = "ai_message_create")]
    AIMessageCreate {
        conversation_id: String,
        message: AIMessageInput,
    },
    #[serde(rename = "ai_run_create")]
    AIRunCreate {
        run: AIRunInput,
    },
    #[serde(rename = "ai_run_get")]
    AIRunGet {
        id: String,
    },
    #[serde(rename = "ai_run_cancel")]
    AIRunCancel {
        id: String,
    },
    #[serde(rename = "ai_run_events")]
    AIRunEvents {
        id: String,
    },
    MailDrafts {},
    MailDraftCreate {
        draft: MailDraftInput,
    },
    MailDraftPatch {
        id: String,
        version: u64,
        draft: MailDraftInput,
    },
    MailDraftDelete {
        id: String,
        version: u64,
    },
    Activity {},
    Notifications {},
    NotificationRead {
        id: String,
    },
    TaskCreate {
        task: TaskInput,
    },
    TaskPatch {
        id: String,
        version: u64,
        task: TaskUpdate,
    },
    TaskDelete {
        id: String,
    },
}
fn valid_task(t: &TaskInput) -> bool {
    !t.title.trim().is_empty()
        && t.title.len() <= 1000
        && t.description.len() <= 100_000
        && t.status.len() <= 100
        && t.project_id.as_deref().is_none_or(valid_id)
        && t.parent_task_id.as_deref().is_none_or(valid_id)
        && t.due_at.as_ref().is_none_or(|s| s.len() <= 100)
        && t.due_timezone.as_ref().is_none_or(|s| s.len() <= 100)
        && t.rrule.as_ref().is_none_or(|s| s.len() <= 1000)
}
fn route(op: Operation) -> Result<(Method, String, Option<Value>), String> {
    match op {
        Operation::Me {} => Ok((Method::GET, "/api/v1/me".into(), None)),
        Operation::Projects {} => Ok((Method::GET, "/api/v1/projects".into(), None)),
        Operation::ProjectCreate { project } if valid_project(&project) => Ok((
            Method::POST,
            "/api/v1/projects".into(),
            Some(json!(project)),
        )),
        Operation::ProjectPatch {
            id,
            version,
            project,
        } if valid_id(&id) && version > 0 && valid_project_patch(&project) => {
            let mut body = json!(project);
            body["version"] = json!(version);
            Ok((Method::PATCH, format!("/api/v1/projects/{id}"), Some(body)))
        }
        Operation::ProjectDelete { id } if valid_id(&id) => {
            Ok((Method::DELETE, format!("/api/v1/projects/{id}"), None))
        }
        Operation::Tasks { project_id } => {
            let path = match project_id {
                Some(id) if valid_id(&id) => format!("/api/v1/tasks?project_id={id}"),
                Some(_) => return Err(err("VALIDATION_ERROR")),
                None => "/api/v1/tasks".into(),
            };
            Ok((Method::GET, path, None))
        }
        Operation::Notes {} => Ok((Method::GET, "/api/v1/notes".into(), None)),
        Operation::NoteCreate { note } if valid_note(&note) => {
            Ok((Method::POST, "/api/v1/notes".into(), Some(json!(note))))
        }
        Operation::NotePatch { id, version, note }
            if valid_id(&id) && version > 0 && valid_note(&note) =>
        {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("version", &version.to_string())
                .finish();
            Ok((
                Method::PATCH,
                format!("/api/v1/notes/{id}?{query}"),
                Some(json!(note)),
            ))
        }
        Operation::NoteDelete { id } if valid_id(&id) => {
            Ok((Method::DELETE, format!("/api/v1/notes/{id}"), None))
        }
        Operation::CalendarOccurrences { starts_at, ends_at }
            if starts_at.len() <= 64 && ends_at.len() <= 64 =>
        {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("starts_at", &starts_at)
                .append_pair("ends_at", &ends_at)
                .finish();
            Ok((
                Method::GET,
                format!("/api/v1/calendar/occurrences?{query}"),
                None,
            ))
        }
        Operation::CalendarEvents {} => Ok((Method::GET, "/api/v1/calendar/events".into(), None)),
        Operation::CalendarEventCreate { event } if valid_calendar_event(&event) => Ok((
            Method::POST,
            "/api/v1/calendar/events".into(),
            Some(json!(event)),
        )),
        Operation::CalendarEventPatch { id, version, event }
            if valid_id(&id) && version > 0 && valid_calendar_event(&event) =>
        {
            let mut body = json!(event);
            body["version"] = json!(version);
            Ok((
                Method::PATCH,
                format!("/api/v1/calendar/events/{id}"),
                Some(body),
            ))
        }
        Operation::CalendarEventDelete { id, version } if valid_id(&id) && version > 0 => {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("version", &version.to_string())
                .finish();
            Ok((
                Method::DELETE,
                format!("/api/v1/calendar/events/{id}?{query}"),
                None,
            ))
        }
        Operation::CalendarReminders { event_id } if valid_id(&event_id) => Ok((
            Method::GET,
            format!("/api/v1/calendar/events/{event_id}/reminders"),
            None,
        )),
        Operation::CalendarReminderCreate { event_id, reminder }
            if valid_id(&event_id) && valid_calendar_reminder(&event_id, &reminder) =>
        {
            Ok((
                Method::POST,
                format!("/api/v1/calendar/events/{event_id}/reminders"),
                Some(json!(reminder)),
            ))
        }
        Operation::CalendarReminderDelete {
            event_id,
            reminder_id,
            version,
        } if valid_id(&event_id) && valid_id(&reminder_id) && version > 0 => {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("version", &version.to_string())
                .finish();
            Ok((
                Method::DELETE,
                format!("/api/v1/calendar/events/{event_id}/reminders/{reminder_id}?{query}"),
                None,
            ))
        }
        Operation::CalendarReminderDispatch {} => Ok((
            Method::POST,
            "/api/v1/calendar/reminders/dispatch".into(),
            None,
        )),
        Operation::FinanceTransactions {} => {
            Ok((Method::GET, "/api/v1/finance/transactions".into(), None))
        }
        Operation::FinanceAccounts {} => Ok((Method::GET, "/api/v1/finance/accounts".into(), None)),
        Operation::FinanceCategories {} => {
            Ok((Method::GET, "/api/v1/finance/categories".into(), None))
        }
        Operation::FinanceBudgets {} => Ok((Method::GET, "/api/v1/finance/budgets".into(), None)),
        Operation::FinanceSummary {} => Ok((Method::GET, "/api/v1/finance/summary".into(), None)),
        Operation::FinanceAccountCreate { account } if valid_finance_account(&account) => Ok((
            Method::POST,
            "/api/v1/finance/accounts".into(),
            Some(json!(account)),
        )),
        Operation::FinanceCategoryCreate { category } if valid_finance_category(&category) => Ok((
            Method::POST,
            "/api/v1/finance/categories".into(),
            Some(json!(category)),
        )),
        Operation::FinanceTransactionCreate { transaction }
            if valid_finance_transaction(&transaction) =>
        {
            Ok((
                Method::POST,
                "/api/v1/finance/transactions".into(),
                Some(json!(transaction)),
            ))
        }
        Operation::FinanceBudgetCreate { budget } if valid_finance_budget(&budget) => Ok((
            Method::POST,
            "/api/v1/finance/budgets".into(),
            Some(json!(budget)),
        )),
        Operation::FinanceTransferCreate { transfer } if valid_finance_transfer(&transfer) => Ok((
            Method::POST,
            "/api/v1/finance/transfers".into(),
            Some(json!(transfer)),
        )),
        Operation::FocusSessions {} => Ok((Method::GET, "/api/v1/focus/sessions".into(), None)),
        Operation::FocusStart { focus, .. } if valid_focus(&focus) => Ok((
            Method::POST,
            "/api/v1/focus/sessions".into(),
            Some(json!(focus)),
        )),
        Operation::FocusStop { id, version } if valid_id(&id) && version > 0 => {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("version", &version.to_string())
                .finish();
            Ok((
                Method::POST,
                format!("/api/v1/focus/sessions/{id}/stop?{query}"),
                None,
            ))
        }
        Operation::MailMessages {} => Ok((Method::GET, "/api/v1/mail/messages".into(), None)),
        Operation::MailAccounts {} => Ok((Method::GET, "/api/v1/mail/accounts".into(), None)),
        Operation::GmailStatus {} => Ok((Method::GET, "/api/v1/mail/gmail/status".into(), None)),
        Operation::AIProviders {} => Ok((Method::GET, "/api/v1/ai/providers".into(), None)),
        Operation::AIConversations {} => Ok((Method::GET, "/api/v1/ai/conversations".into(), None)),
        Operation::AIMessages { conversation_id } if valid_id(&conversation_id) => Ok((
            Method::GET,
            format!("/api/v1/ai/conversations/{conversation_id}/messages"),
            None,
        )),
        Operation::AIConversationCreate { conversation }
            if valid_ai_conversation(&conversation) =>
        {
            Ok((
                Method::POST,
                "/api/v1/ai/conversations".into(),
                Some(json!(conversation)),
            ))
        }
        Operation::AIMessageCreate {
            conversation_id,
            message,
        } if valid_id(&conversation_id) && valid_ai_message(&message) => Ok((
            Method::POST,
            format!("/api/v1/ai/conversations/{conversation_id}/messages"),
            Some(json!(message)),
        )),
        Operation::AIRunCreate { run } if valid_ai_run(&run) => {
            Ok((Method::POST, "/api/v1/ai/runs".into(), Some(json!(run))))
        }
        Operation::AIRunGet { id } if valid_id(&id) => {
            Ok((Method::GET, format!("/api/v1/ai/runs/{id}"), None))
        }
        Operation::AIRunCancel { id } if valid_id(&id) => {
            Ok((Method::POST, format!("/api/v1/ai/runs/{id}/cancel"), None))
        }
        Operation::AIRunEvents { id } if valid_id(&id) => {
            Ok((Method::GET, format!("/api/v1/ai/runs/{id}/events"), None))
        }
        Operation::MailDrafts {} => Ok((Method::GET, "/api/v1/mail/drafts".into(), None)),
        Operation::MailDraftCreate { draft } if valid_mail_draft(&draft) => Ok((
            Method::POST,
            "/api/v1/mail/drafts".into(),
            Some(json!(draft)),
        )),
        Operation::MailDraftPatch { id, version, draft }
            if valid_id(&id) && version > 0 && valid_mail_draft(&draft) =>
        {
            let mut body = json!(draft);
            body["version"] = json!(version);
            Ok((
                Method::PATCH,
                format!("/api/v1/mail/drafts/{id}"),
                Some(body),
            ))
        }
        Operation::MailDraftDelete { id, version } if valid_id(&id) && version > 0 => {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .append_pair("version", &version.to_string())
                .finish();
            Ok((
                Method::DELETE,
                format!("/api/v1/mail/drafts/{id}?{query}"),
                None,
            ))
        }
        Operation::Activity {} => Ok((Method::GET, "/api/v1/activity".into(), None)),
        Operation::Notifications {} => Ok((Method::GET, "/api/v1/notifications".into(), None)),
        Operation::NotificationRead { id } if valid_id(&id) => Ok((
            Method::POST,
            format!("/api/v1/notifications/{id}/read"),
            None,
        )),
        Operation::TaskCreate { task } if valid_task(&task) => {
            Ok((Method::POST, "/api/v1/tasks".into(), Some(json!(task))))
        }
        Operation::TaskPatch { id, version, task } if valid_id(&id) && version > 0 => {
            let task: TaskInput = task.into();
            if !valid_task(&task) {
                return Err(err("VALIDATION_ERROR"));
            }
            let mut body = json!(task);
            body["version"] = json!(version);
            Ok((Method::PATCH, format!("/api/v1/tasks/{id}"), Some(body)))
        }
        Operation::TaskDelete { id } if valid_id(&id) => {
            Ok((Method::DELETE, format!("/api/v1/tasks/{id}"), None))
        }
        _ => Err(err("VALIDATION_ERROR")),
    }
}
async fn resume_flags(
    store: &impl Store,
    origin: &str,
    signed_in: bool,
    policy_enabled: bool,
) -> Result<(bool, bool), String> {
    if signed_in {
        return Ok((false, true));
    }
    let exists = store.exists(origin).await?;
    Ok((policy_enabled && exists, exists))
}
#[tauri::command]
pub async fn native_status(
    window: WebviewWindow,
    storage: State<'_, NativeStorage>,
    state: State<'_, NativeState>,
    origin: String,
) -> Result<SafeStatus, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    let guard = state.0.lock().await;
    let initialized: Initialized = request(
        &client()?,
        Method::GET,
        &format!("{origin}/api/v1/auth/native/status"),
        None,
        None,
    )
    .await?;
    // Status must never read the refresh credential behind the biometric gate.
    let matching_session = guard
        .as_ref()
        .is_some_and(|session| session.origin == origin);
    let policy_enabled = if matching_session {
        false
    } else {
        let policy_origin = origin.clone();
        tauri::async_runtime::spawn_blocking(move || crate::biometric::enabled(&policy_origin))
            .await
            .map_err(|_| err("STORAGE_ERROR"))??
    };
    let (locked, can_resume) =
        resume_flags(storage.inner(), &origin, matching_session, policy_enabled).await?;
    let mut result = status(
        guard.as_ref(),
        &origin,
        Some(can_resume),
        Some(initialized.initialized),
    );
    result.biometric_locked = locked;
    Ok(result)
}

#[derive(Serialize)]
pub struct BiometricStatus {
    supported: bool,
    available: bool,
    enabled: bool,
}
fn biometric_status(origin: &str) -> Result<BiometricStatus, String> {
    Ok(BiometricStatus {
        supported: cfg!(target_os = "macos"),
        available: crate::biometric::available(),
        enabled: crate::biometric::enabled(origin)?,
    })
}
#[tauri::command]
pub async fn native_biometric_status(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    origin: String,
) -> Result<BiometricStatus, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    // A settings remount must observe a pending toggle's committed result.
    let guard = state.0.lock().await;
    let result = tauri::async_runtime::spawn_blocking(move || biometric_status(&origin))
        .await
        .map_err(|_| err("BIOMETRIC_UNAVAILABLE"))?;
    drop(guard);
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeychainScope {
    Session,
    TouchIdPolicy,
}
#[cfg(target_os = "macos")]
fn keychain_service(scope: KeychainScope) -> &'static str {
    match scope {
        KeychainScope::Session => SERVICE,
        KeychainScope::TouchIdPolicy => "com.aelys.desktop.touch-id",
    }
}
/// Explicit OS permission recovery only: never signs in, rotates credentials,
/// disables biometrics or returns the Keychain payload. Not an automatic retry.
#[tauri::command]
pub async fn native_keychain_authorize(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    origin: String,
    scope: KeychainScope,
) -> Result<bool, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    let _guard = state.0.lock().await;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            crate::keychain::authorize(keychain_service(scope), &origin)
        })
        .await
        .map_err(|_| err("STORAGE_ERROR"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (origin, scope);
        Err(err("BIOMETRIC_UNSUPPORTED"))
    }
}
#[tauri::command]
pub async fn native_biometric_set(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    origin: String,
    enabled: bool,
) -> Result<BiometricStatus, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    // Serialize with logout/login/resume. A frontend flag never grants a session.
    let guard = state.0.lock().await;
    if !guard
        .as_ref()
        .is_some_and(|session| session.origin == origin)
    {
        return Err(err("SIGN_IN_REQUIRED"));
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Enabling verifies user presence. An already authenticated owner can
        // disable the option even after losing biometric enrollment; recovery
        // via the server-verified account password must remain possible.
        if enabled {
            crate::biometric::authenticate()?;
        }
        crate::biometric::set_enabled(&origin, enabled)?;
        biometric_status(&origin)
    })
    .await
    .map_err(|_| err("BIOMETRIC_UNAVAILABLE"))?;
    drop(guard);
    result
}
fn origin_fn(input: &str) -> Result<String, String> {
    origin(input)
}
#[tauri::command]
pub async fn native_health(window: WebviewWindow, origin: String) -> Result<bool, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    let value: Value = request(
        &client()?,
        Method::GET,
        &format!("{origin}/healthz"),
        None,
        None,
    )
    .await?;
    Ok(value.get("status").and_then(Value::as_str) == Some("ok"))
}
fn native_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "macos"
    }
}
fn native_display_name() -> &'static str {
    if cfg!(target_os = "android") {
        "Aelys Android"
    } else {
        "Aelys Mac"
    }
}
async fn establish_login(
    client: &Client,
    store: &impl Store,
    origin: &str,
    email: &str,
    password: &str,
    bootstrap: bool,
) -> Result<Session, String> {
    let action = if bootstrap { "bootstrap" } else { "login" };
    let token: Tokens = request(client, Method::POST, &format!("{origin}/api/v1/auth/native/{action}"), Some(json!({"email":email,"password":password,"platform":native_platform(),"display_name":native_display_name()})), None).await?;
    persist_or_revoke(client, store, session_from(origin, token)?).await
}
#[tauri::command]
// The IPC contract keeps credentials as separate arguments; three state/window
// parameters are injected by Tauri and cannot be selected by the frontend.
#[allow(clippy::too_many_arguments)]
pub async fn native_login(
    window: WebviewWindow,
    storage: State<'_, NativeStorage>,
    state: State<'_, NativeState>,
    streams: State<'_, NativeAIStreams>,
    origin: String,
    email: String,
    password: String,
    bootstrap: bool,
) -> Result<SafeStatus, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    if email.len() > 320 || email.is_empty() || password.len() < 8 || password.len() > 1024 {
        return Err(err("VALIDATION_ERROR"));
    }
    let mut guard = state.0.lock().await;
    let client = client()?;
    // Do not destroy a resumable session until replacement credentials are
    // verified and persisted. A typo/offline fallback must preserve Touch ID.
    let session = establish_login(
        &client,
        storage.inner(),
        &origin,
        &email,
        &password,
        bootstrap,
    )
    .await?;
    streams.close_for_origin(None).await;
    *guard = Some(session);
    Ok(status(guard.as_ref(), &origin, Some(true), None))
}
#[tauri::command]
pub async fn native_resume(
    window: WebviewWindow,
    storage: State<'_, NativeStorage>,
    state: State<'_, NativeState>,
    streams: State<'_, NativeAIStreams>,
    origin: String,
) -> Result<SafeStatus, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    let mut guard = state.0.lock().await;
    // Cancellation must leave both the current session and stored refresh token
    // untouched. The policy is read from Keychain, never a WebView preference.
    let biometric_origin = origin.clone();
    let authorize = async move {
        tauri::async_runtime::spawn_blocking(move || {
            if crate::biometric::enabled(&biometric_origin)? {
                crate::biometric::authenticate()?;
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| err("BIOMETRIC_UNAVAILABLE"))?
    };
    let old = prepare_resume(
        &mut guard,
        streams.inner(),
        storage.inner(),
        &origin,
        authorize,
    )
    .await?;
    let client = client()?;
    let tokens: Tokens = request(
        &client,
        Method::POST,
        &format!("{origin}/api/v1/auth/native/refresh"),
        Some(json!({"refresh_token":old.refresh_token})),
        None,
    )
    .await
    .map_err(|_| err("SIGN_IN_REQUIRED"))?;
    let session = session_from(&origin, tokens)?;
    if session.record.owner_id != old.owner_id || session.record.device_id != old.device_id {
        return Err(err("INVALID_RESPONSE"));
    }
    *guard = Some(persist_or_revoke(&client, storage.inner(), session).await?);
    Ok(status(guard.as_ref(), &origin, Some(true), None))
}
#[tauri::command]
pub async fn native_logout(
    window: WebviewWindow,
    storage: State<'_, NativeStorage>,
    state: State<'_, NativeState>,
    streams: State<'_, NativeAIStreams>,
    origin: String,
) -> Result<SafeStatus, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    let mut guard = state.0.lock().await;
    streams.close_for_origin(Some(&origin)).await;
    let record = storage.read(&origin).await?;
    storage.delete(&origin).await?;
    if guard.as_ref().is_some_and(|s| s.origin == origin) {
        *guard = None;
    }
    if let Some(record) = record {
        let value: Value = request(
            &client()?,
            Method::POST,
            &format!("{origin}/api/v1/auth/native/logout"),
            Some(json!({"refresh_token":record.refresh_token})),
            None,
        )
        .await
        .map_err(|_| err("LOCAL_LOGOUT_ONLY"))?;
        if value.get("logged_out").and_then(Value::as_bool) != Some(true) {
            return Err(err("LOCAL_LOGOUT_ONLY"));
        }
    }
    Ok(status(None, &origin, Some(false), None))
}
#[tauri::command]
pub async fn native_operation(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    origin: String,
    operation: Operation,
) -> Result<Value, String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    execute_operation(state.inner(), &origin, operation).await
}

async fn execute_operation(
    state: &NativeState,
    origin: &str,
    operation: Operation,
) -> Result<Value, String> {
    let ai_events = matches!(&operation, Operation::AIRunEvents { .. });
    let idempotency_key = match &operation {
        Operation::FocusStart {
            idempotency_key, ..
        } => idempotency_key.clone(),
        _ => None,
    };
    let (method, path, body) = route(operation)?;
    // Copy only the in-memory access credential. Network waits must not hold the
    // session lock: cancellation and logout need to proceed during an AI run.
    let access = {
        let guard = state.0.lock().await;
        guard
            .as_ref()
            .filter(|s| s.origin == origin)
            .map(|s| s.access.clone())
            .ok_or_else(|| err("SIGN_IN_REQUIRED"))?
    };
    if ai_events {
        let events = session_response(
            state,
            origin,
            &access,
            request_ai_events(&stream_client()?, &format!("{origin}{path}"), &access).await,
        )
        .await?;
        ensure_operation_session(state, origin, &access, false).await?;
        return serde_json::to_value(events).map_err(|_| err("INVALID_RESPONSE"));
    }
    // No automatic retries: a rejected/ambiguous mutation is never replayed.
    let kind = if path == "/api/v1/me" {
        "me"
    } else if path == "/api/v1/projects" {
        if method == Method::GET {
            "projects"
        } else {
            "project"
        }
    } else if path.starts_with("/api/v1/projects/") && method == Method::DELETE {
        "deleted"
    } else if path.starts_with("/api/v1/projects/") {
        "project"
    } else if path == "/api/v1/notes" && method == Method::GET {
        "notes"
    } else if path == "/api/v1/notes" {
        "note"
    } else if path.starts_with("/api/v1/notes/") && method == Method::DELETE {
        "deleted"
    } else if path.starts_with("/api/v1/notes/") {
        "note"
    } else if path.starts_with("/api/v1/calendar/occurrences?") {
        "calendar-occurrences"
    } else if path == "/api/v1/calendar/events" && method == Method::GET {
        "calendar-events"
    } else if path == "/api/v1/calendar/events" {
        "calendar-event"
    } else if (path.starts_with("/api/v1/calendar/events/") || path.contains("/reminders/"))
        && method == Method::DELETE
    {
        "deleted"
    } else if path == "/api/v1/calendar/reminders/dispatch" {
        "reminder-dispatch"
    } else if path.ends_with("/reminders") && method == Method::GET {
        "calendar-reminders"
    } else if path.ends_with("/reminders") {
        "calendar-reminder"
    } else if path.starts_with("/api/v1/calendar/events/") {
        "calendar-event"
    } else if path == "/api/v1/finance/transactions" {
        if method == Method::GET {
            "finance-transactions"
        } else {
            "finance-transaction"
        }
    } else if path == "/api/v1/finance/accounts" {
        if method == Method::GET {
            "finance-accounts"
        } else {
            "finance-account"
        }
    } else if path == "/api/v1/finance/categories" {
        if method == Method::GET {
            "finance-categories"
        } else {
            "finance-category"
        }
    } else if path == "/api/v1/finance/budgets" {
        if method == Method::GET {
            "finance-budgets"
        } else {
            "finance-budget"
        }
    } else if path == "/api/v1/finance/transfers" {
        "finance-transfer"
    } else if path == "/api/v1/finance/summary" {
        "finance-summary"
    } else if path.starts_with("/api/v1/focus/sessions") {
        if method == Method::GET {
            "focus-sessions"
        } else {
            "focus-session"
        }
    } else if path == "/api/v1/mail/messages" {
        "mail-messages"
    } else if path == "/api/v1/mail/accounts" {
        "mail-accounts"
    } else if path == "/api/v1/mail/gmail/status" {
        "gmail-status"
    } else if path == "/api/v1/ai/providers" {
        "ai-providers"
    } else if path == "/api/v1/ai/conversations" {
        if method == Method::GET {
            "ai-conversations"
        } else {
            "ai-conversation"
        }
    } else if path.starts_with("/api/v1/ai/conversations/") {
        if method == Method::POST {
            "ai-message"
        } else {
            "ai-messages"
        }
    } else if path == "/api/v1/ai/runs" {
        "ai-run"
    } else if path.ends_with("/events") && path.starts_with("/api/v1/ai/runs/") {
        "ai-events"
    } else if path.starts_with("/api/v1/ai/runs/") {
        "ai-run"
    } else if path == "/api/v1/mail/drafts" && method == Method::GET {
        "mail-drafts"
    } else if path == "/api/v1/mail/drafts" {
        "mail-draft"
    } else if path.starts_with("/api/v1/mail/drafts/") && method == Method::DELETE {
        "deleted"
    } else if path.starts_with("/api/v1/mail/drafts/") {
        "mail-draft"
    } else if path == "/api/v1/activity" {
        "activity"
    } else if path == "/api/v1/notifications" && method == Method::GET {
        "notifications"
    } else if path.starts_with("/api/v1/notifications/") {
        "notification"
    } else if method == Method::GET {
        "tasks"
    } else if method == Method::DELETE {
        "deleted"
    } else {
        "task"
    };
    let is_mutation = method != Method::GET;
    let response: Result<Value, String> = request_with_key(
        &client()?,
        method,
        &format!("{origin}{path}"),
        body,
        idempotency_key.as_deref(),
        Some(&access),
    )
    .await;
    let value = session_response(state, origin, &access, response)
        .await
        .map_err(|e| {
            if is_mutation
                && matches!(
                    e.as_str(),
                    "NETWORK_ERROR" | "INVALID_RESPONSE" | "RESPONSE_TOO_LARGE" | "BACKEND_ERROR"
                )
            {
                err("MUTATION_OUTCOME_UNKNOWN")
            } else {
                e
            }
        })?;
    ensure_operation_session(state, origin, &access, is_mutation).await?;
    sanitize_response(kind, value).map_err(|e| {
        if is_mutation {
            err("MUTATION_OUTCOME_UNKNOWN")
        } else {
            e
        }
    })
}

async fn session_response<T>(
    state: &NativeState,
    origin: &str,
    access: &str,
    result: Result<T, String>,
) -> Result<T, String> {
    if result.as_ref().is_err_and(|error| error == "UNAUTHORIZED") {
        // Only invalidate the credential that received the 401. A late request
        // cannot clear a newer login. Preserve the rotating Keychain record so
        // the owner can explicitly resume with Touch ID or their password.
        let mut guard = state.0.lock().await;
        if guard
            .as_ref()
            .is_some_and(|session| session.origin == origin && session.access == access)
        {
            *guard = None;
            return Err(err("SIGN_IN_REQUIRED"));
        }
        return Err(err("SESSION_CHANGED"));
    }
    result
}

async fn ensure_operation_session(
    state: &NativeState,
    origin: &str,
    access: &str,
    is_mutation: bool,
) -> Result<(), String> {
    let guard = state.0.lock().await;
    if guard
        .as_ref()
        .is_some_and(|session| session.origin == origin && session.access == access)
    {
        Ok(())
    } else {
        // A logout/server/session change must not publish the previous owner's
        // late data. A completed mutation may already have committed remotely.
        Err(err(if is_mutation {
            "MUTATION_OUTCOME_UNKNOWN"
        } else {
            "SIGN_IN_REQUIRED"
        }))
    }
}

#[tauri::command]
pub async fn native_ai_events(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    streams: State<'_, NativeAIStreams>,
    origin: String,
    id: String,
    request_id: String,
    on_event: Channel<AIStreamMessage>,
) -> Result<(), String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    if !valid_id(&id) || !valid_id(&request_id) {
        return Err(err("VALIDATION_ERROR"));
    }
    let (cancel, cancel_rx) = watch::channel(false);
    let access = {
        // Register under the same lock order as session changes so logout
        // cannot miss a subscription created from its former credentials.
        let guard = state.0.lock().await;
        let access = guard
            .as_ref()
            .filter(|session| session.origin == origin)
            .map(|session| session.access.clone())
            .ok_or_else(|| err("SIGN_IN_REQUIRED"))?;
        let mut registry = streams.0.lock().await;
        if registry.len() >= 4 || registry.contains_key(&request_id) {
            return Err(err("STREAM_LIMIT"));
        }
        registry.insert(
            request_id.clone(),
            ActiveAIStream {
                origin: origin.clone(),
                cancel,
            },
        );
        access
    };
    let result = async {
        // Acknowledge registration before waiting on backend headers so an abort
        // arriving immediately after invoke can close this exact subscription.
        on_event
            .send(AIStreamMessage::Opened)
            .map_err(|_| err("STREAM_CLOSED"))?;
        let client = stream_client()?;
        stream_ai_events(
            &client,
            &format!("{origin}/api/v1/ai/runs/{id}/events"),
            &access,
            cancel_rx,
            |event| {
                let origin = &origin;
                let access = &access;
                let state = state.inner();
                let on_event = &on_event;
                async move {
                    // Channel send is synchronous; keep the session check and
                    // publication together without holding the lock over I/O.
                    let guard = state.0.lock().await;
                    if !guard.as_ref().is_some_and(|session| {
                        session.origin == *origin && session.access == *access
                    }) {
                        return Err(err("SIGN_IN_REQUIRED"));
                    }
                    on_event
                        .send(AIStreamMessage::Event { event })
                        .map_err(|_| err("STREAM_CLOSED"))
                }
            },
        )
        .await
    }
    .await;
    streams.0.lock().await.remove(&request_id);
    let result = session_response(state.inner(), &origin, &access, result).await;
    let message = match result {
        Ok(()) => AIStreamMessage::End,
        Err(code) => AIStreamMessage::Error { code },
    };
    on_event.send(message).map_err(|_| err("STREAM_CLOSED"))
}

#[tauri::command]
pub async fn native_ai_events_close(
    window: WebviewWindow,
    streams: State<'_, NativeAIStreams>,
    origin: String,
    request_id: String,
) -> Result<(), String> {
    check_window(&window)?;
    let origin = origin_fn(&origin)?;
    if !valid_id(&request_id) {
        return Err(err("VALIDATION_ERROR"));
    }
    let registry = streams.0.lock().await;
    if let Some(active) = registry
        .get(&request_id)
        .filter(|active| active.origin == origin)
    {
        let _ = active.cancel.send(true);
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct Me {
    id: String,
    email: String,
    device_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Project {
    id: String,
    name: String,
    description: String,
    status: String,
    version: u64,
}
#[derive(Serialize, Deserialize)]
struct Task {
    id: String,
    version: u64,
    title: String,
    description: String,
    project_id: Option<String>,
    parent_task_id: Option<String>,
    status: String,
    priority: i32,
    due_at: Option<String>,
    due_timezone: Option<String>,
    rrule: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Deleted {
    deleted: bool,
}
#[derive(Serialize, Deserialize)]
struct Note {
    id: String,
    version: u64,
    title: String,
    markdown_body: String,
    parent_id: Option<String>,
    project_id: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Event {
    id: String,
    version: u64,
    title: String,
    description: String,
    starts_at: String,
    ends_at: String,
    timezone: String,
    all_day: bool,
    project_id: Option<String>,
    linked_task_id: Option<String>,
    rrule: Option<String>,
    reminder_at: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarEventInput {
    title: String,
    #[serde(default)]
    description: String,
    starts_at: String,
    ends_at: String,
    #[serde(default = "utc_timezone")]
    timezone: String,
    #[serde(default)]
    all_day: bool,
    project_id: Option<String>,
    linked_task_id: Option<String>,
    rrule: Option<String>,
    reminder_at: Option<String>,
}
fn utc_timezone() -> String {
    "UTC".into()
}
fn valid_calendar_event(event: &CalendarEventInput) -> bool {
    !event.title.trim().is_empty()
        && event.title.len() <= 300
        && event.description.len() <= 100_000
        && !event.starts_at.is_empty()
        && event.starts_at.len() <= 64
        && !event.ends_at.is_empty()
        && event.ends_at.len() <= 64
        && !event.timezone.is_empty()
        && event.timezone.len() <= 64
        && event.project_id.as_deref().is_none_or(valid_id)
        && event.linked_task_id.as_deref().is_none_or(valid_id)
        && event.rrule.as_ref().is_none_or(|rule| rule.len() <= 500)
        && event
            .reminder_at
            .as_ref()
            .is_none_or(|reminder| reminder.len() <= 64)
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CalendarReminderInput {
    event_id: String,
    notify_at: String,
    #[serde(default = "in_app")]
    channel: String,
    idempotency_key: String,
}
fn in_app() -> String {
    "in_app".into()
}
fn valid_calendar_reminder(event_id: &str, reminder: &CalendarReminderInput) -> bool {
    reminder.event_id == event_id
        && !reminder.notify_at.is_empty()
        && reminder.notify_at.len() <= 64
        && reminder.channel == "in_app"
        && !reminder.idempotency_key.is_empty()
        && reminder.idempotency_key.len() <= 100
}
#[derive(Serialize, Deserialize)]
struct EventOccurrence {
    #[serde(flatten)]
    event: Event,
    occurrence_id: String,
    series_starts_at: String,
    series_ends_at: String,
}
#[derive(Serialize, Deserialize)]
struct CalendarReminder {
    id: String,
    owner_id: String,
    event_id: String,
    notify_at: String,
    channel: String,
    reminder_status: String,
    version: u64,
}
#[derive(Serialize, Deserialize)]
struct FinanceTransaction {
    id: String,
    owner_id: String,
    account_id: String,
    category_id: Option<String>,
    amount: String,
    currency: String,
    r#type: String,
    occurred_at: String,
    notes: String,
    idempotency_key: Option<String>,
    related_transfer_id: Option<String>,
    version: u64,
}
#[derive(Serialize, Deserialize)]
struct FinanceTransfer {
    transfer_id: String,
    debit: FinanceTransaction,
    credit: FinanceTransaction,
}
#[derive(Serialize, Deserialize)]
struct FinanceAccount {
    id: String,
    owner_id: String,
    name: String,
    currency: String,
    r#type: String,
    version: u64,
}
#[derive(Serialize, Deserialize)]
struct FinanceCategory {
    id: String,
    owner_id: String,
    name: String,
    kind: String,
    version: u64,
}
#[derive(Serialize, Deserialize)]
struct FinanceBudget {
    id: String,
    owner_id: String,
    category_id: Option<String>,
    currency: String,
    period_start: String,
    period_end: String,
    limit_amount: String,
    version: u64,
}
#[derive(Serialize, Deserialize)]
struct FinanceCurrencySummary {
    currency: String,
    balance: String,
    income: String,
    expense: String,
}
#[derive(Serialize, Deserialize)]
struct FinanceSummary {
    total: Option<String>,
    count: u64,
    currencies: Vec<FinanceCurrencySummary>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FinanceAccountInput {
    name: String,
    currency: String,
    #[serde(default = "cash")]
    r#type: String,
}
fn cash() -> String {
    "cash".into()
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FinanceCategoryInput {
    name: String,
    #[serde(default = "expense")]
    kind: String,
}
fn expense() -> String {
    "expense".into()
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FinanceTransactionInput {
    account_id: String,
    category_id: Option<String>,
    amount: String,
    currency: String,
    r#type: String,
    occurred_at: String,
    #[serde(default)]
    notes: String,
    idempotency_key: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FinanceBudgetInput {
    category_id: Option<String>,
    currency: String,
    period_start: String,
    period_end: String,
    limit_amount: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FinanceTransferInput {
    from_account_id: String,
    to_account_id: String,
    amount: String,
    currency: String,
    occurred_at: String,
    #[serde(default)]
    notes: String,
    idempotency_key: String,
}
fn valid_decimal(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && value.bytes().filter(|byte| *byte == b'.').count() <= 1
}
fn valid_currency(value: &str) -> bool {
    value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_alphabetic())
}
fn valid_finance_account(value: &FinanceAccountInput) -> bool {
    !value.name.trim().is_empty() && value.name.len() <= 200 && valid_currency(&value.currency)
}
fn valid_finance_category(value: &FinanceCategoryInput) -> bool {
    !value.name.trim().is_empty() && value.name.len() <= 200 && value.kind.len() <= 30
}
fn valid_finance_transaction(value: &FinanceTransactionInput) -> bool {
    valid_id(&value.account_id)
        && value.category_id.as_deref().is_none_or(valid_id)
        && valid_decimal(&value.amount)
        && valid_currency(&value.currency)
        && matches!(value.r#type.as_str(), "income" | "expense")
        && !value.occurred_at.is_empty()
        && value.occurred_at.len() <= 64
        && value.notes.len() <= 20_000
        && value
            .idempotency_key
            .as_deref()
            .is_none_or(|key| !key.is_empty() && key.len() <= 100)
}
fn valid_finance_budget(value: &FinanceBudgetInput) -> bool {
    value.category_id.as_deref().is_none_or(valid_id)
        && valid_currency(&value.currency)
        && !value.period_start.is_empty()
        && value.period_start.len() <= 64
        && !value.period_end.is_empty()
        && value.period_end.len() <= 64
        && valid_decimal(&value.limit_amount)
}
fn valid_finance_transfer(value: &FinanceTransferInput) -> bool {
    valid_id(&value.from_account_id)
        && valid_id(&value.to_account_id)
        && value.from_account_id != value.to_account_id
        && valid_decimal(&value.amount)
        && valid_currency(&value.currency)
        && !value.occurred_at.is_empty()
        && value.occurred_at.len() <= 64
        && value.notes.len() <= 20_000
        && !value.idempotency_key.is_empty()
        && value.idempotency_key.len() <= 100
}
#[derive(Serialize, Deserialize)]
struct Focus {
    id: String,
    owner_id: String,
    task_id: Option<String>,
    project_id: Option<String>,
    started_at: String,
    mode: String,
    ended_at: Option<String>,
    elapsed_seconds: i64,
    status: String,
    version: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FocusInput {
    task_id: Option<String>,
    project_id: Option<String>,
    started_at: String,
    #[serde(default = "pomodoro")]
    mode: String,
}
fn pomodoro() -> String {
    "pomodoro".into()
}
fn valid_focus(focus: &FocusInput) -> bool {
    focus.task_id.as_deref().is_none_or(valid_id)
        && focus.project_id.as_deref().is_none_or(valid_id)
        && !focus.started_at.is_empty()
        && focus.started_at.len() <= 64
        && matches!(focus.mode.as_str(), "pomodoro" | "stopwatch" | "custom")
}
#[derive(Serialize, Deserialize)]
struct MailMessage {
    id: String,
    owner_id: String,
    account_id: Option<String>,
    thread_id: Option<String>,
    sender: String,
    recipients: Vec<String>,
    subject: String,
    body: String,
    received_at: String,
    sync_origin: String,
}
#[derive(Serialize, Deserialize)]
struct MailAccount {
    id: String,
    owner_id: String,
    provider: String,
    external_id: Option<String>,
    connection_status: String,
    version: u64,
}
#[derive(Serialize, Deserialize)]
struct GmailStatus {
    configured: bool,
}
#[derive(Serialize, Deserialize)]
struct AIProvider {
    id: String,
    kind: String,
    base_url: Option<String>,
    enabled: bool,
    model_policy: Value,
    has_secret: bool,
}
#[derive(Serialize, Deserialize)]
struct AIConversation {
    id: String,
    owner_id: String,
    project_id: Option<String>,
    title: String,
    version: u64,
}
#[derive(Serialize, Deserialize)]
struct AIMessage {
    id: String,
    conversation_id: String,
    role: String,
    content: String,
    source_refs: Vec<Value>,
    created_at: String,
}
#[derive(Serialize, Deserialize)]
struct AIRun {
    id: String,
    owner_id: String,
    conversation_id: String,
    provider: String,
    model: String,
    status: String,
    idempotency_key: Option<String>,
    token_counts: HashMap<String, Value>,
    cost_estimate: String,
    started_at: Option<String>,
    completed_at: Option<String>,
}
#[derive(Serialize, Deserialize)]
pub struct AIEvent {
    id: Option<String>,
    event: String,
    data: Value,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AIStreamMessage {
    Opened,
    Event { event: AIEvent },
    End,
    Error { code: String },
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AIConversationInput {
    #[serde(default = "default_conversation_title")]
    title: String,
    project_id: Option<String>,
    #[serde(default)]
    tool_scope: HashMap<String, Value>,
}
fn default_conversation_title() -> String {
    "Conversation".into()
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AIMessageInput {
    role: String,
    content: String,
    #[serde(default)]
    source_refs: Vec<Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AIRunInput {
    conversation_id: String,
    message: String,
    #[serde(default)]
    routing: HashMap<String, Value>,
    #[serde(default)]
    tool_scope: HashMap<String, Value>,
    idempotency_key: String,
}
fn valid_ai_run(value: &AIRunInput) -> bool {
    valid_id(&value.conversation_id)
        && !value.message.trim().is_empty()
        && value.message.len() <= 500_000
        && !value.idempotency_key.is_empty()
        && value.idempotency_key.len() <= 150
        && value.routing.len() <= 20
        && value.tool_scope.len() <= 20
}
fn valid_ai_conversation(value: &AIConversationInput) -> bool {
    value.title.len() <= 300
        && value.project_id.as_deref().is_none_or(valid_id)
        && value.tool_scope.len() <= 20
}
fn valid_ai_message(value: &AIMessageInput) -> bool {
    matches!(
        value.role.as_str(),
        "user" | "assistant" | "system" | "tool"
    ) && !value.content.is_empty()
        && value.content.len() <= 500_000
        && value.source_refs.len() <= 100
        && serde_json::to_vec(&value.source_refs).is_ok_and(|bytes| bytes.len() <= 100_000)
}
#[derive(Serialize, Deserialize)]
struct MailDraft {
    id: String,
    owner_id: String,
    account_id: Option<String>,
    thread_id: Option<String>,
    recipients: Vec<String>,
    subject: String,
    content: String,
    status: String,
    version: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MailDraftInput {
    account_id: Option<String>,
    thread_id: Option<String>,
    #[serde(default)]
    recipients: Vec<String>,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    content: String,
}
fn valid_mail_draft(draft: &MailDraftInput) -> bool {
    draft.account_id.as_deref().is_none_or(valid_id)
        && draft
            .thread_id
            .as_ref()
            .is_none_or(|id| !id.is_empty() && id.len() <= 100)
        && draft.recipients.len() <= 100
        && draft
            .recipients
            .iter()
            .all(|item| !item.is_empty() && item.len() <= 320)
        && draft.subject.len() <= 500
        && draft.content.len() <= 500_000
}
#[derive(Serialize, Deserialize)]
struct Activity {
    id: String,
    owner_id: String,
    resource_id: Option<String>,
    event_kind: String,
    actor_kind: String,
    actor_id: Option<String>,
    occurred_at: String,
    non_sensitive_metadata: HashMap<String, Value>,
}
#[derive(Serialize, Deserialize)]
struct Notification {
    id: String,
    owner_id: String,
    kind: String,
    title: String,
    body: Option<String>,
    data_json: HashMap<String, Value>,
    read_at: Option<String>,
    created_at: String,
}
#[derive(Serialize, Deserialize)]
struct Delivered {
    delivered: u64,
}
fn sanitize_response(kind: &str, value: Value) -> Result<Value, String> {
    fn convert<T: DeserializeOwned + Serialize>(value: Value) -> Result<Value, String> {
        let parsed: T = serde_json::from_value(value).map_err(|_| err("INVALID_RESPONSE"))?;
        serde_json::to_value(parsed).map_err(|_| err("INVALID_RESPONSE"))
    }
    match kind {
        "me" => convert::<Me>(value),
        "projects" => convert::<Vec<Project>>(value),
        "project" => convert::<Project>(value),
        "tasks" => convert::<Vec<Task>>(value),
        "notes" => convert::<Vec<Note>>(value),
        "note" => convert::<Note>(value),
        "calendar-occurrences" => convert::<Vec<EventOccurrence>>(value),
        "calendar-events" => convert::<Vec<Event>>(value),
        "calendar-event" => convert::<Event>(value),
        "calendar-reminders" => convert::<Vec<CalendarReminder>>(value),
        "calendar-reminder" => convert::<CalendarReminder>(value),
        "finance-transactions" => convert::<Vec<FinanceTransaction>>(value),
        "finance-accounts" => convert::<Vec<FinanceAccount>>(value),
        "finance-categories" => convert::<Vec<FinanceCategory>>(value),
        "finance-budgets" => convert::<Vec<FinanceBudget>>(value),
        "finance-budget" => convert::<FinanceBudget>(value),
        "finance-summary" => convert::<FinanceSummary>(value),
        "finance-account" => convert::<FinanceAccount>(value),
        "finance-category" => convert::<FinanceCategory>(value),
        "finance-transaction" => convert::<FinanceTransaction>(value),
        "finance-transfer" => convert::<FinanceTransfer>(value),
        "focus-sessions" => convert::<Vec<Focus>>(value),
        "focus-session" => convert::<Focus>(value),
        "mail-messages" => convert::<Vec<MailMessage>>(value),
        "mail-accounts" => convert::<Vec<MailAccount>>(value),
        "gmail-status" => convert::<GmailStatus>(value),
        "ai-providers" => convert::<Vec<AIProvider>>(value),
        "ai-conversations" => convert::<Vec<AIConversation>>(value),
        "ai-messages" => convert::<Vec<AIMessage>>(value),
        "ai-conversation" => convert::<AIConversation>(value),
        "ai-message" => convert::<AIMessage>(value),
        "ai-run" => convert::<AIRun>(value),
        "ai-events" => convert::<Vec<AIEvent>>(value),
        "mail-drafts" => convert::<Vec<MailDraft>>(value),
        "mail-draft" => convert::<MailDraft>(value),
        "activity" => convert::<Vec<Activity>>(value),
        "notifications" => convert::<Vec<Notification>>(value),
        "notification" => convert::<Notification>(value),
        "reminder-dispatch" => convert::<Delivered>(value),
        "task" => convert::<Task>(value),
        "deleted" => convert::<Deleted>(value),
        _ => Err(err("INVALID_RESPONSE")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn rejected_access_token_clears_only_its_own_session() {
        tauri::async_runtime::block_on(async {
            let origin = "https://example.test";
            let state = NativeState::default();
            *state.0.lock().await = Some(session_from(origin, tokens("retained-refresh")).unwrap());
            let result: Result<(), String> =
                session_response(&state, origin, "access-secret", Err("UNAUTHORIZED".into())).await;
            assert_eq!(result, Err("SIGN_IN_REQUIRED".into()));
            assert!(state.0.lock().await.is_none());
            let mut newer = session_from(origin, tokens("newer-refresh")).unwrap();
            newer.access = "newer-access".into();
            *state.0.lock().await = Some(newer);
            let _: Result<(), String> =
                session_response(&state, origin, "access-secret", Err("UNAUTHORIZED".into())).await;
            assert_eq!(
                state.0.lock().await.as_ref().unwrap().access,
                "newer-access"
            );
            let _: Result<(), String> =
                session_response(&state, origin, "newer-access", Err("NETWORK_ERROR".into())).await;
            assert!(state.0.lock().await.is_some());
        });
    }
    #[test]
    fn keychain_recovery_scope_cannot_select_arbitrary_items() {
        assert!(matches!(
            serde_json::from_value::<KeychainScope>(json!("session")).unwrap(),
            KeychainScope::Session
        ));
        assert!(matches!(
            serde_json::from_value::<KeychainScope>(json!("touch_id_policy")).unwrap(),
            KeychainScope::TouchIdPolicy
        ));
        for value in [
            json!("other-secret"),
            json!({"service":"arbitrary"}),
            json!(null),
            json!("com.aelys.desktop.native-session"),
        ] {
            assert!(serde_json::from_value::<KeychainScope>(value).is_err());
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(
                keychain_service(KeychainScope::Session),
                "com.aelys.desktop.native-session"
            );
            assert_eq!(
                keychain_service(KeychainScope::TouchIdPolicy),
                "com.aelys.desktop.touch-id"
            );
        }
    }
    struct FakeStore {
        value: RefCell<Option<String>>,
        fail: bool,
    }
    impl Store for FakeStore {
        async fn read(&self, _: &str) -> Result<Option<Record>, String> {
            self.value
                .borrow()
                .as_ref()
                .map(|s| serde_json::from_str(s).map_err(|_| err("STORAGE_ERROR")))
                .transpose()
        }
        async fn write(&self, _: &str, r: &Record) -> Result<(), String> {
            if self.fail {
                return Err(err("STORAGE_ERROR"));
            }
            *self.value.borrow_mut() = Some(serde_json::to_string(r).unwrap());
            Ok(())
        }
        async fn delete(&self, _: &str) -> Result<(), String> {
            *self.value.borrow_mut() = None;
            Ok(())
        }
    }
    fn tokens(refresh: &str) -> Tokens {
        Tokens {
            access_token: "access-secret".into(),
            refresh_token: refresh.into(),
            owner_id: "owner-1".into(),
            device_id: "device-1".into(),
            token_type: "bearer".into(),
            expires_in: 60,
        }
    }
    struct MetadataStore {
        present: Result<bool, String>,
        checked: std::cell::Cell<usize>,
    }
    impl Store for MetadataStore {
        async fn exists(&self, _: &str) -> Result<bool, String> {
            self.checked.set(self.checked.get() + 1);
            self.present.clone()
        }
        async fn read(&self, _: &str) -> Result<Option<Record>, String> {
            Err("KEYCHAIN_ACCESS_REQUIRED".into())
        }
        async fn write(&self, _: &str, _: &Record) -> Result<(), String> {
            panic!("metadata checks cannot write credentials")
        }
        async fn delete(&self, _: &str) -> Result<(), String> {
            panic!("denied reads cannot delete credentials")
        }
    }
    #[test]
    fn status_uses_presence_without_reading_secrets() {
        tauri::async_runtime::block_on(async {
            for policy in [true, false] {
                for present in [true, false] {
                    let store = MetadataStore {
                        present: Ok(present),
                        checked: 0.into(),
                    };
                    assert_eq!(
                        resume_flags(&store, "https://example.test", false, policy)
                            .await
                            .unwrap(),
                        (policy && present, present)
                    );
                    assert_eq!(store.checked.get(), 1);
                }
            }
            let store = MetadataStore {
                present: Err("KEYCHAIN_ACCESS_REQUIRED".into()),
                checked: 0.into(),
            };
            assert_eq!(
                resume_flags(&store, "https://example.test", true, true)
                    .await
                    .unwrap(),
                (false, true)
            );
            assert_eq!(store.checked.get(), 0);
            assert_eq!(
                resume_flags(&store, "https://example.test", false, true).await,
                Err("KEYCHAIN_ACCESS_REQUIRED".into())
            );
        });
    }
    #[test]
    fn keychain_denial_after_biometrics_preserves_live_session_and_streams() {
        tauri::async_runtime::block_on(async {
            let origin = "https://example.test";
            let store = MetadataStore {
                present: Ok(true),
                checked: 0.into(),
            };
            let mut session = Some(session_from(origin, tokens("retained-refresh")).unwrap());
            let streams = NativeAIStreams::default();
            let (cancel, receiver) = watch::channel(false);
            streams.0.lock().await.insert(
                "active".into(),
                ActiveAIStream {
                    origin: origin.into(),
                    cancel,
                },
            );
            let result = prepare_resume(
                &mut session,
                &streams,
                &store,
                origin,
                std::future::ready(Ok(())),
            )
            .await;
            assert!(matches!(result, Err(code) if code == "KEYCHAIN_ACCESS_REQUIRED"));
            assert_eq!(session.unwrap().record.refresh_token, "retained-refresh");
            assert!(!*receiver.borrow());
        });
    }
    #[test]
    fn biometric_denial_preserves_refresh_session_and_streams() {
        tauri::async_runtime::block_on(async {
            let origin = "https://example.test";
            for denial in [
                "BIOMETRIC_CANCELLED",
                "BIOMETRIC_UNAVAILABLE",
                "BIOMETRIC_POLICY_ERROR",
            ] {
                let store = FakeStore {
                    value: RefCell::new(None),
                    fail: false,
                };
                let mut session = Some(session_from(origin, tokens("retained-refresh")).unwrap());
                persist(&store, session.as_ref().unwrap()).await.unwrap();
                let streams = NativeAIStreams::default();
                let (cancel, receiver) = watch::channel(false);
                streams.0.lock().await.insert(
                    "active".into(),
                    ActiveAIStream {
                        origin: origin.into(),
                        cancel,
                    },
                );
                let before = store.value.borrow().clone();
                let result = prepare_resume(
                    &mut session,
                    &streams,
                    &store,
                    origin,
                    std::future::ready(Err(denial.into())),
                )
                .await;
                assert!(matches!(result, Err(code) if code == denial));
                assert!(session.is_some());
                assert_eq!(*store.value.borrow(), before);
                assert!(!*receiver.borrow());
            }
        });
    }
    #[test]
    fn biometric_success_consumes_old_refresh_before_rotation() {
        tauri::async_runtime::block_on(async {
            let origin = "https://example.test";
            let store = FakeStore {
                value: RefCell::new(None),
                fail: false,
            };
            let mut session = Some(session_from(origin, tokens("rotate-once")).unwrap());
            persist(&store, session.as_ref().unwrap()).await.unwrap();
            let streams = NativeAIStreams::default();
            let (cancel, receiver) = watch::channel(false);
            streams.0.lock().await.insert(
                "active".into(),
                ActiveAIStream {
                    origin: origin.into(),
                    cancel,
                },
            );
            let record = prepare_resume(
                &mut session,
                &streams,
                &store,
                origin,
                std::future::ready(Ok(())),
            )
            .await
            .unwrap();
            assert_eq!(record.refresh_token, "rotate-once");
            assert!(session.is_none());
            assert!(store.read(origin).await.unwrap().is_none());
            assert!(*receiver.borrow());
            assert!(take_record(&store, origin).await.is_err());
        });
    }
    #[test]
    fn rejected_password_fallback_preserves_saved_refresh() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count])
                .starts_with("POST /api/v1/auth/native/login "));
            write!(
                stream,
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        tauri::async_runtime::block_on(async {
            let store = FakeStore {
                value: RefCell::new(None),
                fail: false,
            };
            let session = session_from(&origin, tokens("saved-refresh")).unwrap();
            persist(&store, &session).await.unwrap();
            let before = store.value.borrow().clone();
            let result = establish_login(
                &client().unwrap(),
                &store,
                &origin,
                "owner@example.test",
                "wrong-password",
                false,
            )
            .await;
            assert!(result.is_err());
            assert_eq!(*store.value.borrow(), before);
            assert_eq!(
                take_record(&store, &origin).await.unwrap().refresh_token,
                "saved-refresh"
            );
        });
        server.join().unwrap();
    }
    fn assert_domain_http_response(
        operation: Value,
        expected_request: &str,
        response: Value,
        expected: Value,
    ) {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let expected_request = expected_request.to_owned();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = [0; 4096];
            let count = socket.read(&mut bytes).unwrap();
            assert!(String::from_utf8_lossy(&bytes[..count]).starts_with(&expected_request));
            let body = response.to_string();
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let operation = serde_json::from_value(operation).unwrap();
        let result = tauri::async_runtime::block_on(async {
            let state = NativeState(Mutex::new(Some(
                session_from(&origin, tokens("synthetic-refresh")).unwrap(),
            )));
            execute_operation(&state, &origin, operation).await
        });
        server.join().unwrap();
        assert_eq!(result, Ok(expected));
    }

    #[test]
    fn project_mutation_http_responses_are_single_objects() {
        let project =
            json!({"id":"project-1","name":"Plan","description":"","status":"active","version":1});
        let mut backend_response = project.clone();
        backend_response["server_only"] = json!("excluded");
        assert_domain_http_response(
            json!({"type":"project_create","project":{"name":"Plan"}}),
            "POST /api/v1/projects ",
            backend_response.clone(),
            project.clone(),
        );
        assert_domain_http_response(
            json!({"type":"project_patch","id":"project-1","version":1,"project":{"name":"Plan"}}),
            "PATCH /api/v1/projects/project-1 ",
            backend_response,
            project.clone(),
        );
        assert_domain_http_response(
            json!({"type":"projects"}),
            "GET /api/v1/projects ",
            json!([project.clone()]),
            json!([project]),
        );
    }

    #[test]
    fn note_mutation_http_responses_are_single_objects() {
        let note = json!({"id":"note-1","title":"Note","markdown_body":"Body","parent_id":null,"project_id":null,"version":1});
        let mut backend_response = note.clone();
        backend_response["server_only"] = json!("excluded");
        assert_domain_http_response(
            json!({"type":"note_create","note":{"title":"Note","markdown_body":"Body"}}),
            "POST /api/v1/notes ",
            backend_response.clone(),
            note.clone(),
        );
        assert_domain_http_response(
            json!({"type":"note_patch","id":"note-1","version":1,"note":{"title":"Note","markdown_body":"Body"}}),
            "PATCH /api/v1/notes/note-1?version=1 ",
            backend_response,
            note.clone(),
        );
        assert_domain_http_response(
            json!({"type":"notes"}),
            "GET /api/v1/notes ",
            json!([note.clone()]),
            json!([note]),
        );
    }

    #[test]
    fn focus_start_and_stop_http_responses_are_single_objects() {
        let focus = json!({"id":"focus-1","owner_id":"owner-1","task_id":null,"project_id":null,"started_at":"2026-10-30T00:00:00Z","mode":"pomodoro","ended_at":null,"elapsed_seconds":0,"status":"active","version":1});
        let mut backend_response = focus.clone();
        backend_response["server_only"] = json!("excluded");
        assert_domain_http_response(
            json!({"type":"focus_start","focus":{"started_at":"2026-10-30T00:00:00Z"},"idempotency_key":"focus-key"}),
            "POST /api/v1/focus/sessions ",
            backend_response,
            focus.clone(),
        );
        let mut stopped = focus.clone();
        stopped["status"] = json!("completed");
        stopped["version"] = json!(2);
        stopped["elapsed_seconds"] = json!(60);
        stopped["ended_at"] = json!("2026-10-30T00:01:00Z");
        assert_domain_http_response(
            json!({"type":"focus_stop","id":"focus-1","version":1}),
            "POST /api/v1/focus/sessions/focus-1/stop?version=1 ",
            stopped.clone(),
            stopped,
        );
        assert_domain_http_response(
            json!({"type":"focus_sessions"}),
            "GET /api/v1/focus/sessions ",
            json!([focus.clone()]),
            json!([focus]),
        );
    }
    #[test]
    fn origins_are_bounded() {
        for ok in [
            "https://example.org",
            "https://example.org:8443",
            "http://127.0.0.1:8000",
            "http://[::1]:8000",
        ] {
            assert!(origin(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://localhost:8000",
            "http://127.1:8000",
            "http://127.0.0.2",
            "http://example.org",
            "https://u:p@example.org",
            "https://@example.org",
            "https://example.org/path",
            "https://example.org/",
            "https://example.org?x=1",
            "https://example.org#x",
            "https://example.org\\evil",
        ] {
            assert!(origin(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn window_restrictions() {
        let local = Url::parse("tauri://localhost/tasks").unwrap();
        let dev = Url::parse("http://127.0.0.1:5173/tasks").unwrap();
        let remote = Url::parse("https://example.org").unwrap();
        assert!(authorized("main", &local, false));
        assert!(!authorized("other", &local, true));
        assert!(!authorized("main", &remote, true));
        assert!(authorized("main", &dev, true));
        assert!(!authorized("main", &dev, false));
    }
    #[test]
    fn android_window_and_backend_origins_are_exact_and_https_only() {
        let local = Url::parse("http://tauri.localhost/tasks").unwrap();
        assert!(authorized_for("main", &local, false, true));
        assert!(!authorized_for("other", &local, true, true));
        for address in [
            "http://tauri.localhost:5173",
            "http://tauri.localhost.evil",
            "http://user@tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
            "http://127.0.0.1:5173",
            "https://example.org",
        ] {
            assert!(
                !authorized_for("main", &Url::parse(address).unwrap(), true, true),
                "{address}"
            );
        }
        assert!(origin_for("https://example.org", true).is_ok());
        assert!(origin_for("http://127.0.0.1:8000", true).is_err());
        assert!(origin_for("http://[::1]:8000", true).is_err());
        assert!(origin_for("http://127.0.0.1:8000", false).is_ok());
    }
    #[test]
    fn capability_is_main_window_only() {
        let capability: Value = serde_json::from_str(include_str!(
            "../../../apps/desktop/src-tauri/capabilities/default.json"
        ))
        .unwrap();
        assert_eq!(capability["windows"], json!(["main"]));
        assert!(capability.get("remote").is_none());
        assert_eq!(capability["permissions"], json!(["core:default"]));
    }
    #[test]
    fn http_errors_do_not_return_server_content_and_redirects_are_denied() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        fn serve(response: &'static str) -> String {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut buf = [0; 4096];
                let _ = socket.read(&mut buf);
                socket.write_all(response.as_bytes()).unwrap();
            });
            format!("http://{address}/api/v1/auth/native/status")
        }
        tauri::async_runtime::block_on(async {
            let url = serve(
                "HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret",
            );
            let result: Result<Value, _> =
                request(&client().unwrap(), Method::GET, &url, None, None).await;
            assert_eq!(result.unwrap_err(), "FORBIDDEN");
            let url = serve("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let result: Result<Value, _> =
                request(&client().unwrap(), Method::GET, &url, None, None).await;
            assert_eq!(result.unwrap_err(), "BACKEND_ERROR");
        });
    }
    #[test]
    fn allowlist_and_strict_input() {
        let (method, path, _) = route(Operation::Tasks {
            project_id: Some("abc-1".into()),
        })
        .unwrap();
        assert_eq!(method, Method::GET);
        assert_eq!(path, "/api/v1/tasks?project_id=abc-1");
        assert!(route(Operation::TaskDelete {
            id: "../grants".into()
        })
        .is_err());
        assert!(route(Operation::Tasks {
            project_id: Some("a&foo=x".into())
        })
        .is_err());
        assert!(
            serde_json::from_value::<Operation>(json!({"type":"me","url":"https://evil"})).is_err()
        );
        assert!(
            serde_json::from_value::<Operation>(json!({"type":"arbitrary","path":"/"})).is_err()
        );
        assert!(serde_json::from_value::<Operation>(
            json!({"type":"task_patch","id":"id-1","version":2,"task":{"title":"Task"}})
        )
        .is_err());
        let operation: Operation = serde_json::from_value(
            json!({"type":"task_patch","id":"id-1","version":2,"task":{"title":"Task","description":"","project_id":null,"parent_task_id":null,"status":"todo","priority":0,"due_at":null,"due_timezone":null,"rrule":null}}),
        )
        .unwrap();
        let (method, path, body) = route(operation).unwrap();
        assert_eq!(method, Method::PATCH);
        assert_eq!(path, "/api/v1/tasks/id-1");
        assert_eq!(body.unwrap()["version"], 2);
    }
    #[test]
    fn ai_conversation_writes_are_typed_and_bounded() {
        let conversation: Operation = serde_json::from_value(json!({
            "type": "ai_conversation_create",
            "conversation": {"title": "Plan", "project_id": null, "tool_scope": {"scopes": ["tasks.write"]}}
        })).unwrap();
        let (method, path, body) = route(conversation).unwrap();
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/api/v1/ai/conversations");
        assert_eq!(body.unwrap()["title"], "Plan");
        let message: Operation = serde_json::from_value(json!({
            "type": "ai_message_create",
            "conversation_id": "conversation-1",
            "message": {"role": "user", "content": "Hello", "source_refs": []}
        }))
        .unwrap();
        let (method, path, body) = route(message).unwrap();
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/api/v1/ai/conversations/conversation-1/messages");
        assert_eq!(body.unwrap()["content"], "Hello");
        assert!(serde_json::from_value::<Operation>(json!({
            "type": "ai_message_create", "conversation_id": "conversation-1",
            "message": {"role": "user", "content": "Hello", "api_key": "must-not-pass"}
        }))
        .is_err());
    }
    #[test]
    fn projects_and_notifications_are_typed_owner_operations() {
        let project: Operation = serde_json::from_value(json!({
            "type": "project_create",
            "project": {"name": "Plan", "description": ""}
        }))
        .unwrap();
        let (method, path, body) = route(project).unwrap();
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/api/v1/projects");
        assert_eq!(body.unwrap()["name"], "Plan");
        let notification: Operation = serde_json::from_value(json!({
            "type": "notification_read",
            "id": "notification-1"
        }))
        .unwrap();
        let (method, path, body) = route(notification).unwrap();
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/api/v1/notifications/notification-1/read");
        assert!(body.is_none());
    }
    #[test]
    fn ai_run_lifecycle_is_typed_without_provider_secrets() {
        let run: Operation = serde_json::from_value(json!({
            "type": "ai_run_create",
            "run": {"conversation_id":"conversation-1","message":"Hello","routing":{},"tool_scope":{},"idempotency_key":"run-1"}
        })).unwrap();
        let (method, path, body) = route(run).unwrap();
        assert_eq!(method, Method::POST);
        assert_eq!(path, "/api/v1/ai/runs");
        assert!(body.unwrap().get("api_key").is_none());
        let events: Operation = serde_json::from_value(json!({
            "type": "ai_run_events", "id": "run-1"
        }))
        .unwrap();
        let (method, path, body) = route(events).unwrap();
        assert_eq!(method, Method::GET);
        assert_eq!(path, "/api/v1/ai/runs/run-1/events");
        assert!(body.is_none());
    }
    #[test]
    fn ai_cancel_reaches_backend_while_event_response_is_open() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::Arc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let server = std::thread::spawn(move || {
            let (mut events, _) = listener.accept().unwrap();
            events
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            let size = events.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..size])
                .starts_with("GET /api/v1/ai/runs/run-1/events "));
            events.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: ai.run.started\ndata: {}\n\n").unwrap();
            started_tx.send(()).unwrap();

            // Complete the stream only after the cancel endpoint is reached.
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((mut cancel, _)) => {
                        cancel
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let size = cancel.read(&mut request).unwrap();
                        assert!(String::from_utf8_lossy(&request[..size])
                            .starts_with("POST /api/v1/ai/runs/run-1/cancel "));
                        let body = json!({"id":"run-1","owner_id":"owner-1","conversation_id":"conversation-1","provider":"configured","model":"auto","status":"cancelled","idempotency_key":"run-key","token_counts":{},"cost_estimate":"0.0000","started_at":null,"completed_at":null}).to_string();
                        write!(cancel, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
                        events
                            .write_all(b"event: ai.run.cancelled\ndata: {}\n\n")
                            .unwrap();
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() >= deadline {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            }
        });
        tauri::async_runtime::block_on(async {
            let state = Arc::new(NativeState(Mutex::new(Some(
                session_from(&origin, tokens("refresh-fixture")).unwrap(),
            ))));
            let event_state = Arc::clone(&state);
            let event_origin = origin.clone();
            let pending = tokio::spawn(async move {
                execute_operation(
                    &event_state,
                    &event_origin,
                    Operation::AIRunEvents { id: "run-1".into() },
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(3), started_rx)
                .await
                .unwrap()
                .unwrap();
            let cancelled = tokio::time::timeout(
                Duration::from_secs(1),
                execute_operation(
                    &state,
                    &origin,
                    Operation::AIRunCancel { id: "run-1".into() },
                ),
            )
            .await;
            if cancelled.is_err() {
                pending.abort();
            }
            assert!(
                cancelled.is_ok(),
                "cancel waited for the still-open AI event response"
            );
            assert_eq!(cancelled.unwrap().unwrap()["status"], "cancelled");
            let events = tokio::time::timeout(Duration::from_secs(3), pending)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(events[1]["event"], "ai.run.cancelled");
        });
        server.join().unwrap();
    }
    #[test]
    fn late_operation_results_do_not_cross_logout_or_session_replacement() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::{mpsc, Arc};

        for (replace_session, mutate) in [(false, false), (true, false), (false, true)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).unwrap() > 0);
                started_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
                let body = if mutate {
                    json!({"id":"note-1","version":1,"title":"Private note","markdown_body":"private","parent_id":null,"project_id":null})
                } else {
                    json!({"id":"owner-1","email":"owner@example.test","device_id":"device-1"})
                }.to_string();
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            });
            tauri::async_runtime::block_on(async {
                let state = Arc::new(NativeState(Mutex::new(Some(
                    session_from(&origin, tokens("refresh-fixture")).unwrap(),
                ))));
                let request_state = Arc::clone(&state);
                let request_origin = origin.clone();
                let operation = if mutate {
                    serde_json::from_value(json!({"type":"note_create","note":{"title":"Private note","markdown_body":"private"}})).unwrap()
                } else {
                    Operation::Me {}
                };
                let pending = tokio::spawn(async move {
                    execute_operation(&request_state, &request_origin, operation).await
                });
                tokio::time::timeout(Duration::from_secs(3), started_rx)
                    .await
                    .unwrap()
                    .unwrap();
                let mut guard = tokio::time::timeout(Duration::from_secs(1), state.0.lock())
                    .await
                    .unwrap();
                *guard = if replace_session {
                    let mut replacement = tokens("new-refresh");
                    replacement.access_token = "new-session-access".into();
                    Some(session_from(&origin, replacement).unwrap())
                } else {
                    None
                };
                drop(guard);
                release_tx.send(()).unwrap();
                let result = tokio::time::timeout(Duration::from_secs(3), pending)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    result.unwrap_err(),
                    if mutate {
                        "MUTATION_OUTCOME_UNKNOWN"
                    } else {
                        "SIGN_IN_REQUIRED"
                    }
                );
            });
            server.join().unwrap();
        }
    }
    #[test]
    fn ai_event_parser_allowlists_events_and_redacts_nested_secrets() {
        let events = parse_ai_events(
            "id: 1\nevent: ai.text.delta\ndata: {\"text\":\"Hello\",\"nested\":{\"token\":\"secret\"}}\n\n",
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data["text"], "Hello");
        assert!(events[0].data["nested"].get("token").is_none());
        assert!(parse_ai_events("event: provider.secret\ndata: {}\n\n").is_err());
    }
    #[test]
    fn ai_stream_decoder_handles_split_utf8_crlf_and_keepalives() {
        let mut decoder = AIEventDecoder::default();
        let mut events = Vec::new();
        let wire = ": heartbeat\r\n\r\nid: 1\r\nevent: ai.text.delta\r\ndata: {\"text\":\"Привет 🌙\",\"api_key\":\"excluded\"}\r\n\r\nevent: ai.run.completed\ndata: {}\n\n";
        for byte in wire.as_bytes() {
            events.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data["text"], "Привет 🌙");
        assert!(events[0].data.get("api_key").is_none());
        assert_eq!(events[1].event, "ai.run.completed");
        assert!(decoder.pending.is_empty());
    }
    #[test]
    fn ai_stream_delivers_before_eof_and_abort_closes_subscription() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/api/v1/ai/runs/run-1/events",
            listener.local_addr().unwrap()
        );
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            let count = socket.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count])
                .starts_with("GET /api/v1/ai/runs/run-1/events "));
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: ai.text.delta\ndata: {\"text\":\"First chunk\"}\n\n").unwrap();
            // No EOF or terminal event until the consumer closes the HTTP read.
            match socket.read(&mut request) {
                Ok(0) => {}
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                other => panic!("subscription did not close on abort: {other:?}"),
            }
        });
        tauri::async_runtime::block_on(async {
            let (cancel, cancel_rx) = watch::channel(false);
            let (first_tx, first_rx) = tokio::sync::oneshot::channel();
            let pending = tokio::spawn(async move {
                let mut first_tx = Some(first_tx);
                stream_ai_events(
                    &stream_client().unwrap(),
                    &url,
                    "synthetic-access",
                    cancel_rx,
                    move |event| {
                        if let Some(sender) = first_tx.take() {
                            sender.send(event.data).unwrap();
                        }
                        std::future::ready(Ok(()))
                    },
                )
                .await
            });
            let first = tokio::time::timeout(Duration::from_secs(1), first_rx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(first["text"], "First chunk");
            cancel.send(true).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result.unwrap_err(), "STREAM_ABORTED");
        });
        server.join().unwrap();
    }
    #[test]
    fn ai_subscriptions_close_only_for_the_selected_origin() {
        tauri::async_runtime::block_on(async {
            let streams = NativeAIStreams::default();
            let (first, first_rx) = watch::channel(false);
            let (second, second_rx) = watch::channel(false);
            streams.0.lock().await.insert(
                "first".into(),
                ActiveAIStream {
                    origin: "https://first.example".into(),
                    cancel: first,
                },
            );
            streams.0.lock().await.insert(
                "second".into(),
                ActiveAIStream {
                    origin: "https://second.example".into(),
                    cancel: second,
                },
            );
            streams
                .close_for_origin(Some("https://first.example"))
                .await;
            assert!(*first_rx.borrow());
            assert!(!*second_rx.borrow());
            streams.close_for_origin(None).await;
            assert!(*second_rx.borrow());
        });
    }
    #[test]
    fn ai_stream_abort_cancels_the_wait_for_http_headers() {
        use std::io::Read;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/api/v1/ai/runs/run-1/events",
            listener.local_addr().unwrap()
        );
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(socket.read(&mut request).unwrap() > 0);
            started_tx.send(()).unwrap();
            // Deliberately never send headers: cancelling must drop send().
            match socket.read(&mut request) {
                Ok(0) => {}
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
                other => panic!("request did not close before headers: {other:?}"),
            }
        });
        tauri::async_runtime::block_on(async {
            let (cancel, cancel_rx) = watch::channel(false);
            let pending = tokio::spawn(async move {
                stream_ai_events(
                    &stream_client().unwrap(),
                    &url,
                    "synthetic-access",
                    cancel_rx,
                    |_| std::future::ready(Ok(())),
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(1), started_rx)
                .await
                .unwrap()
                .unwrap();
            cancel.send(true).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result.unwrap_err(), "STREAM_ABORTED");
        });
        server.join().unwrap();
    }
    #[test]
    fn ai_stream_rejects_wrong_content_type_and_truncated_frames() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        for (content_type, body) in [
            ("application/json", "event: ai.text.delta\ndata: {}\n\n"),
            ("text/event-stream", "event: ai.text.delta\ndata: {}"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!(
                "http://{}/api/v1/ai/runs/run-1/events",
                listener.local_addr().unwrap()
            );
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                assert!(socket.read(&mut request).unwrap() > 0);
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            let result = tauri::async_runtime::block_on(async {
                request_ai_events(&stream_client().unwrap(), &url, "synthetic-access").await
            });
            assert_eq!(result.err().as_deref(), Some("INVALID_RESPONSE"));
            server.join().unwrap();
        }
        let mut decoder = AIEventDecoder::default();
        assert_eq!(
            decoder.push(&vec![b' '; MAX_JSON + 1]).err().as_deref(),
            Some("RESPONSE_TOO_LARGE")
        );
    }
    #[test]
    fn redacts_secrets_from_status_and_responses() {
        let session = session_from("https://example.org", tokens("refresh-secret")).unwrap();
        let safe = serde_json::to_string(&status(
            Some(&session),
            "https://example.org",
            Some(true),
            None,
        ))
        .unwrap();
        assert!(!safe.contains("secret"));
        let clean = sanitize_response(
            "me",
            json!({"id":"id","email":"x","device_id":"d","refresh_token":"leaked"}),
        )
        .unwrap();
        assert!(!clean.to_string().contains("leaked"));
        assert!(sanitize_response("tasks", json!({"refresh_token":"leaked"})).is_err());
    }
    #[tokio::test]
    async fn storage_failure_never_returns_live_session_and_rotation_replaces_record() {
        let bad = FakeStore {
            value: RefCell::new(None),
            fail: true,
        };
        assert!(persist(
            &bad,
            &session_from("https://example.org", tokens("old")).unwrap()
        )
        .await
        .is_err());
        let store = FakeStore {
            value: RefCell::new(None),
            fail: false,
        };
        persist(
            &store,
            &session_from("https://example.org", tokens("old")).unwrap(),
        )
        .await
        .unwrap();
        let old = store.read("https://example.org").await.unwrap().unwrap();
        assert_eq!(old.refresh_token, "old");
        assert_eq!(
            take_record(&store, "https://example.org")
                .await
                .unwrap()
                .refresh_token,
            "old"
        );
        assert!(store.read("https://example.org").await.unwrap().is_none());
        persist(
            &store,
            &session_from("https://example.org", tokens("rotated")).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(
            store
                .read("https://example.org")
                .await
                .unwrap()
                .unwrap()
                .refresh_token,
            "rotated"
        );
    }
}
