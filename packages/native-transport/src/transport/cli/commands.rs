//! Full domain transport for the owner CLI. Uses the GUI's validated operations.
use super::*;
use std::collections::BTreeMap;
use std::io::IsTerminal;

pub(super) const HELP: &str = "\nDomain commands:\n\
  aelys operations                           # offline catalogue and examples\n\
  aelys --origin URL tasks|notes|projects|calendar|mail|focus list\n\
  aelys --origin URL finance accounts|categories|transactions|budgets|summary\n\
  aelys --origin URL ai providers|conversations\n\
  aelys --origin URL notifications|activity|automations|telegram|agents|devices list\n\
  aelys --origin URL DOMAIN get ID\n\
  aelys --origin URL DOMAIN create BODY.json [--apply]\n\
  aelys --origin URL exec OPERATION.json [--apply] [--unlock-keychain]\n\
  aelys --origin URL batch BATCH.json [--apply] [--unlock-keychain]\n\
  aelys --origin URL api METHOD /api/v1/PATH [--body FILE] [--query FILE] [--apply]\n\
  aelys --origin URL connect gmail|calendar --receipt FILE [--apply]\n\
  aelys --origin URL devices revoke ID --receipt FILE [--apply]\n\
  aelys --origin URL receipt FILE             # local operation receipt\n\
Use '-' as input for secret-bearing operations; --receipt PATH is required when\n\
applying stdin mutations. File mutations default to preview; reads execute.\n\
Batch format: {\"version\":2,\"operations\":[{\"type\":\"notes\"},...]}\n\
All domains use the existing owner API, policy engine and version checks.\n\
Local appearance/preferences and utilities are client-local, outside this API.";

pub(super) fn catalogue() -> &'static str {
    include_str!("operations.json")
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchInput {
    version: u8,
    operations: Vec<Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    operation: Value,
    state: String,
    result: Option<Value>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    origin: String,
    owner_id: String,
    digest: String,
    entries: Vec<Entry>,
}
pub(super) struct Invocation {
    operations: Vec<Value>,
    receipt: Option<PathBuf>,
    digest: String,
    pub(super) preview: bool,
    pub(super) unlock_keychain: bool,
}
impl Invocation {
    pub(super) fn preview_value(&self) -> Value {
        json!({"preview":true,"operation_count":self.operations.len(),"operations":self.operations.iter().map(|value| {
            let (method,path,_) = describe(value).expect("validated operation");
            json!({"type":value["type"],"method":method.as_str(),"path":path,"mutation":mutates(&method,&path),"secret_input":has_secret(value)})
        }).collect::<Vec<_>>()})
    }
}
fn sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace('-', "_");
    matches!(
        key.as_str(),
        "api_key"
            | "secret"
            | "secret_value"
            | "password"
            | "access_token"
            | "refresh_token"
            | "token"
            | "bot_token"
            | "pkcs8"
            | "private_key"
            | "credential"
            | "authorization"
            | "authorization_url"
            | "ticket"
            | "session_token"
            | "client_secret"
            | "isolation_nonce"
    ) || key.ends_with("_secret")
        || key.ends_with("_password")
        || key.ends_with("_token")
}
fn has_secret(value: &Value) -> bool {
    match value {
        Value::Object(map) => map
            .iter()
            .any(|(key, value)| sensitive_key(key) && !value.is_null() || has_secret(value)),
        Value::Array(items) => items.iter().any(has_secret),
        _ => false,
    }
}
fn secrets(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if sensitive_key(key) {
                    if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
                        found.push(value.to_owned());
                    }
                }
                secrets(value, found);
            }
        }
        Value::Array(items) => {
            for value in items {
                secrets(value, found);
            }
        }
        _ => {}
    }
}
fn redact(value: &mut Value, private: &[String]) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| !sensitive_key(key));
            for value in map.values_mut() {
                redact(value, private);
            }
        }
        Value::Array(items) => {
            for value in items {
                redact(value, private);
            }
        }
        Value::String(value) => {
            for secret in private {
                if value.contains(secret) {
                    *value = value.replace(secret, "[REDACTED]");
                }
            }
        }
        _ => {}
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum CliOperation {
    Devices {},
    DeviceRevoke { id: String },
    GoogleConnect { provider: String },
}
fn special(value: &Value) -> Result<Option<(Method, String)>, String> {
    let kind = value["type"].as_str().unwrap_or("");
    if !["devices", "device_revoke", "google_connect"].contains(&kind) {
        return Ok(None);
    }
    let operation: CliOperation =
        serde_json::from_value(value.clone()).map_err(|_| err("INVALID_OPERATION"))?;
    let route = match operation {
        CliOperation::Devices {} => (Method::GET, "/api/v1/devices".into()),
        CliOperation::DeviceRevoke { id } if valid_id(&id) => {
            (Method::POST, format!("/api/v1/devices/{id}/revoke"))
        }
        CliOperation::GoogleConnect { provider } if provider == "gmail" => {
            (Method::POST, "/api/v1/mail/gmail/browser-connect".into())
        }
        CliOperation::GoogleConnect { provider } if provider == "calendar" => (
            Method::POST,
            "/api/v1/calendar/google/browser-connect".into(),
        ),
        _ => return Err(err("VALIDATION_ERROR")),
    };
    Ok(Some(route))
}
fn describe(value: &Value) -> Result<(Method, String, Option<Value>), String> {
    if let Some((method, path)) = special(value)? {
        return Ok((method, path, None));
    }
    let operation: Operation =
        serde_json::from_value(value.clone()).map_err(|_| err("INVALID_OPERATION"))?;
    if let Operation::ApiBinary { path } = &operation {
        if !binary_allowed(path) {
            return Err(err("VALIDATION_ERROR"));
        }
        return Ok((Method::GET, path.clone(), None));
    }
    if let Operation::Api {
        query: Some(query), ..
    } = &operation
    {
        if query.keys().any(|key| sensitive_key(key)) {
            return Err(err("SECRET_QUERY_FORBIDDEN"));
        }
    }
    if let Operation::Api {
        path,
        body: Some(body),
        ..
    } = &operation
    {
        if path.starts_with("/api/v1/finance/") {
            for field in ["amount", "limit_amount"] {
                if body.get(field).is_some_and(|value| !value.is_string()) {
                    return Err(err("DECIMAL_STRING_REQUIRED"));
                }
            }
        }
    }
    if let Operation::Api {
        idempotency_key: Some(key),
        ..
    } = &operation
    {
        if !(8..=128).contains(&key.len())
            || !key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b))
        {
            return Err(err("INVALID_IDEMPOTENCY_KEY"));
        }
    }
    route(operation)
}
fn mutates(method: &Method, path: &str) -> bool {
    method != Method::GET
        && !(method == Method::POST
            && matches!(
                path,
                "/api/v1/knowledge/search" | "/api/v1/agents/sessions/search"
            ))
}
fn input(path: &str) -> Result<(Value, bool), String> {
    let stdin = path == "-";
    let bytes = if stdin {
        if std::io::stdin().is_terminal() {
            return Err(err("STDIN_PIPE_REQUIRED"));
        }
        let mut bytes = Vec::new();
        std::io::stdin()
            .lock()
            .take(MAX_INPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| err("INPUT_READ_FAILED"))?;
        if bytes.len() as u64 > MAX_INPUT {
            return Err(err("INPUT_TOO_LARGE"));
        }
        bytes
    } else {
        read_bounded(Path::new(path))?
    };
    let value = serde_json::from_slice(&bytes).map_err(|_| err("INVALID_OPERATION_JSON"))?;
    Ok((value, stdin))
}
fn finish(
    operations: Vec<Value>,
    source: Option<&str>,
    apply: bool,
    unlock_keychain: bool,
    receipt: Option<PathBuf>,
    stdin: bool,
) -> Result<Invocation, String> {
    if operations.is_empty() || operations.len() > 200 {
        return Err(err("INVALID_BATCH"));
    }
    let mut writes = false;
    for operation in &operations {
        let (method, path, _) = describe(operation)?;
        writes |= mutates(&method, &path);
        if has_secret(operation) && !stdin {
            return Err(err("SECRET_STDIN_REQUIRED"));
        }
    }
    if stdin && writes && apply && receipt.is_none() {
        return Err(err("RECEIPT_PATH_REQUIRED"));
    }
    let receipt = receipt.or_else(|| {
        source
            .filter(|source| *source != "-")
            .map(|source| sibling(Path::new(source), ".aelys-operations.json"))
    });
    if writes && apply && receipt.is_none() {
        return Err(err("RECEIPT_PATH_REQUIRED"));
    }
    // Digest covers non-secret content only. Secret commands are deliberately
    // single-attempt; a fresh receipt is required for another secret change.
    let mut safe = json!(operations);
    redact(&mut safe, &[]);
    let digest = hash(&serde_json::to_vec(&safe).map_err(|_| err("INVALID_OPERATION"))?);
    Ok(Invocation {
        operations,
        receipt,
        digest,
        preview: writes && !apply,
        unlock_keychain,
    })
}
fn alias(
    domain: &str,
    action: &str,
    rest: &[String],
) -> Result<Option<(Value, Option<String>)>, String> {
    let read = match (domain, action) {
        ("devices", "list") => Some(json!({"type":"devices"})),
        ("settings", "show") => Some(json!({"type":"me"})),
        ("tasks", "list") => Some(json!({"type":"tasks"})),
        ("notes", "list") => Some(json!({"type":"notes"})),
        ("projects", "list") => Some(json!({"type":"projects"})),
        ("calendar", "list") => Some(json!({"type":"calendar_events"})),
        ("mail", "list") => Some(json!({"type":"mail_messages"})),
        ("mail", "accounts") => Some(json!({"type":"mail_accounts"})),
        ("mail", "drafts") => Some(json!({"type":"mail_drafts"})),
        ("focus", "list") => Some(json!({"type":"focus_sessions"})),
        ("notifications", "list") => Some(json!({"type":"notifications"})),
        ("activity", "list") => Some(json!({"type":"activity"})),
        ("ai", "providers") => Some(json!({"type":"ai_providers"})),
        ("ai", "conversations") => Some(json!({"type":"ai_conversations"})),
        ("finance", kind)
            if [
                "accounts",
                "categories",
                "transactions",
                "budgets",
                "summary",
            ]
            .contains(&kind) =>
        {
            Some(json!({"type":format!("finance_{kind}")}))
        }
        ("automations", "list") => {
            Some(json!({"type":"api","method":"GET","path":"/api/v1/automations"}))
        }
        ("telegram", "list") => {
            Some(json!({"type":"api","method":"GET","path":"/api/v1/integrations/telegram/chats"}))
        }
        ("agents", "list") => {
            Some(json!({"type":"api","method":"GET","path":"/api/v1/agents/sessions"}))
        }
        _ => None,
    };
    if let Some(value) = read {
        if !rest.is_empty() {
            return Err(err("USAGE_ERROR"));
        }
        return Ok(Some((value, None)));
    }
    if domain == "connect" && ["gmail", "calendar"].contains(&action) && rest.is_empty() {
        return Ok(Some((
            json!({"type":"google_connect","provider":action}),
            None,
        )));
    }
    if domain == "devices" && action == "revoke" && rest.len() == 1 && valid_id(&rest[0]) {
        return Ok(Some((json!({"type":"device_revoke","id":rest[0]}), None)));
    }
    if domain == "knowledge" && action == "search" && rest.len() == 1 {
        return Ok(Some((
            json!({"type":"api","method":"POST","path":"/api/v1/knowledge/search","body":{"query":rest[0],"limit":20}}),
            None,
        )));
    }
    if action == "get" && rest.len() == 1 && valid_id(&rest[0]) {
        let id = &rest[0];
        let value = match domain {
            "notes" | "mail" => json!({"type":"read_item","resource":domain,"id":id}),
            "tasks" | "projects" => {
                json!({"type":"api","method":"GET","path":format!("/api/v1/{domain}/{id}")})
            }
            "calendar" => {
                json!({"type":"api","method":"GET","path":format!("/api/v1/calendar/events/{id}")})
            }
            "ai" => json!({"type":"ai_run_get","id":id}),
            _ => return Err(err("USAGE_ERROR")),
        };
        return Ok(Some((value, None)));
    }
    if action == "create" && rest.len() == 1 {
        let (body, _) = input(&rest[0])?;
        let (kind, field) = match domain {
            "tasks" => ("task_create", "task"),
            "notes" => ("note_create", "note"),
            "projects" => ("project_create", "project"),
            "calendar" => ("calendar_event_create", "event"),
            "mail" => ("mail_draft_create", "draft"),
            "focus" => ("focus_start", "focus"),
            "ai" => ("ai_conversation_create", "conversation"),
            "automations" => {
                return Ok(Some((
                    json!({"type":"api","method":"POST","path":"/api/v1/automations","body":body}),
                    Some(rest[0].clone()),
                )))
            }
            _ => return Err(err("USAGE_ERROR")),
        };
        let mut value = json!({"type":kind});
        value[field] = body;
        return Ok(Some((value, Some(rest[0].clone()))));
    }
    Ok(None)
}
pub(super) fn parse(args: &[String]) -> Result<Option<Invocation>, String> {
    if args.is_empty() {
        return Ok(None);
    }
    let reserved = ["status", "unlock", "import"];
    if reserved.contains(&args[0].as_str()) {
        return Ok(None);
    }
    let mut positionals = Vec::new();
    let mut apply = false;
    let mut unlock = false;
    let mut receipt = None;
    let mut body = None;
    let mut query = None;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--apply" if !apply => apply = true,
            "--unlock-keychain" if !unlock => unlock = true,
            "--receipt" | "--body" | "--query" => {
                let flag = args[index].as_str();
                index += 1;
                let path = args.get(index).ok_or_else(|| err("USAGE_ERROR"))?.clone();
                let target = match flag {
                    "--receipt" => &mut receipt,
                    "--body" => &mut body,
                    _ => &mut query,
                };
                if target.replace(path).is_some() {
                    return Err(err("USAGE_ERROR"));
                }
            }
            value if value.starts_with("--") => return Err(err("USAGE_ERROR")),
            _ => positionals.push(args[index].clone()),
        }
        index += 1;
    }
    let receipt = receipt.map(PathBuf::from);
    let command = positionals
        .first()
        .map(String::as_str)
        .ok_or_else(|| err("USAGE_ERROR"))?;
    match command {
        "exec" | "batch" if positionals.len() == 2 && body.is_none() && query.is_none() => {
            let (value, stdin) = input(&positionals[1])?;
            let operations = if command == "batch" {
                let batch: BatchInput =
                    serde_json::from_value(value).map_err(|_| err("INVALID_BATCH_JSON"))?;
                if batch.version != 2 {
                    return Err(err("INVALID_BATCH"));
                }
                batch.operations
            } else {
                vec![value]
            };
            finish(
                operations,
                Some(&positionals[1]),
                apply,
                unlock,
                receipt,
                stdin,
            )
            .map(Some)
        }
        "api" if positionals.len() == 3 => {
            let mut value = json!({"type":"api","method":positionals[1],"path":positionals[2]});
            let mut stdin = false;
            if let Some(path) = &body {
                let (data, from_stdin) = input(path)?;
                value["body"] = data;
                stdin = from_stdin;
            }
            if let Some(path) = &query {
                let (data, from_stdin) = input(path)?;
                if from_stdin {
                    return Err(err("USAGE_ERROR"));
                }
                let _: BTreeMap<String, String> =
                    serde_json::from_value(data.clone()).map_err(|_| err("INVALID_QUERY"))?;
                value["query"] = data;
            }
            // API writes without a body also need a durable explicit receipt.
            if mutates(
                &Method::from_bytes(positionals[1].as_bytes()).map_err(|_| err("USAGE_ERROR"))?,
                &positionals[2],
            ) && apply
                && body.is_none()
                && receipt.is_none()
            {
                return Err(err("RECEIPT_PATH_REQUIRED"));
            }
            finish(vec![value], body.as_deref(), apply, unlock, receipt, stdin).map(Some)
        }
        _ if positionals.len() >= 2 && body.is_none() && query.is_none() => {
            let (value, source) = alias(&positionals[0], &positionals[1], &positionals[2..])?
                .ok_or_else(|| err("USAGE_ERROR"))?;
            finish(
                vec![value],
                source.as_deref(),
                apply,
                unlock,
                receipt,
                source.as_deref() == Some("-"),
            )
            .map(Some)
        }
        _ => Err(err("USAGE_ERROR")),
    }
}
fn save_receipt(path: &Path, receipt: &Receipt) -> Result<(), String> {
    // Reuse the existing fsync/atomic writer without serializing auth material.
    let bytes = serde_json::to_vec(receipt).map_err(|_| err("OUTBOX_WRITE_FAILED"))?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(err("OUTBOX_TOO_LARGE"));
    }
    let temporary = sibling(path, &format!(".tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| err("OUTBOX_WRITE_FAILED"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| err("OUTBOX_WRITE_FAILED"))?;
        fs::rename(&temporary, path).map_err(|_| err("OUTBOX_WRITE_FAILED"))?;
        File::open(
            path.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )
        .and_then(|dir| dir.sync_all())
        .map_err(|_| err("OUTBOX_WRITE_FAILED"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn open_receipt(invocation: &Invocation, session: &Session) -> Result<Option<Receipt>, String> {
    let Some(path) = &invocation.receipt else {
        return Ok(None);
    };
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
                return Err(err("OUTBOX_PERMISSIONS"));
            }
            let file = File::open(path).map_err(|_| err("OUTBOX_READ_FAILED"))?;
            let mut bytes = Vec::new();
            file.take(16 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| err("OUTBOX_READ_FAILED"))?;
            if bytes.len() > 16 * 1024 * 1024 {
                return Err(err("OUTBOX_TOO_LARGE"));
            }
            let receipt: Receipt =
                serde_json::from_slice(&bytes).map_err(|_| err("INVALID_OUTBOX"))?;
            if receipt.version != 2
                || receipt.origin != session.origin
                || receipt.owner_id != session.record.owner_id
                || receipt.digest != invocation.digest
                || receipt.entries.len() != invocation.operations.len()
            {
                return Err(err("OUTBOX_CONFLICT"));
            }
            // Secrets are single-attempt and may never reuse a receipt, even with another value.
            if invocation.operations.iter().any(has_secret) {
                return Err(err("SECRET_RECEIPT_ALREADY_EXISTS"));
            }
            for (entry, operation) in receipt.entries.iter().zip(&invocation.operations) {
                if entry.operation != *operation
                    || !["pending", "in_flight", "succeeded", "rejected", "uncertain"]
                        .contains(&entry.state.as_str())
                {
                    return Err(err("OUTBOX_CONFLICT"));
                }
            }
            Ok(Some(receipt))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut operations = json!(invocation.operations);
            redact(&mut operations, &[]);
            let receipt = Receipt {
                version: 2,
                origin: session.origin.clone(),
                owner_id: session.record.owner_id.clone(),
                digest: invocation.digest.clone(),
                entries: operations
                    .as_array()
                    .expect("array")
                    .iter()
                    .cloned()
                    .map(|operation| Entry {
                        operation,
                        state: "pending".into(),
                        result: None,
                    })
                    .collect(),
            };
            save_receipt(path, &receipt)?;
            Ok(Some(receipt))
        }
        Err(_) => Err(err("OUTBOX_READ_FAILED")),
    }
}
async fn connect_google(session: &Session, provider: &str, path: &str) -> Result<Value, String> {
    let response = request_api(
        &client()?,
        Method::POST,
        &format!("{}{path}", session.origin),
        None,
        None,
        &session.access,
    )
    .await?;
    let kind = if provider == "gmail" {
        GoogleConnection::Gmail
    } else {
        GoogleConnection::Calendar
    };
    let url = google_browser_url(&session.origin, &response, kind)?;
    // Fixed executable, one validated selected-backend URL. No shell/string evaluation.
    let status = std::process::Command::new("/usr/bin/open")
        .arg(url.as_str())
        .status()
        .map_err(|_| err("BROWSER_OPEN_FAILED"))?;
    if !status.success() {
        return Err(err("BROWSER_OPEN_FAILED"));
    }
    Ok(json!({"browser_opened":true,"provider":provider,"consent_required":true}))
}
pub(super) async fn execute(session: &Session, invocation: Invocation) -> Result<Value, String> {
    let writes = invocation
        .operations
        .iter()
        .any(|value| describe(value).is_ok_and(|(method, path, _)| mutates(&method, &path)));
    if writes && invocation.receipt.is_none() {
        return Err(err("RECEIPT_PATH_REQUIRED"));
    }
    let _lock = invocation
        .receipt
        .as_ref()
        .map(|path| acquire(path))
        .transpose()?;
    let mut receipt = if writes {
        open_receipt(&invocation, session)?
    } else {
        None
    };
    let state = NativeState(Mutex::new(Some(Session {
        origin: session.origin.clone(),
        access: session.access.clone(),
        record: identity_record(&session.record),
    })));
    let mut private = Vec::new();
    for value in &invocation.operations {
        secrets(value, &mut private);
    }
    let mut results = Vec::new();
    for (index, value) in invocation.operations.iter().enumerate() {
        let (method, path, _) = describe(value)?;
        let mutation = mutates(&method, &path);
        if let Some(saved) = receipt.as_mut() {
            let entry = &mut saved.entries[index];
            if entry.state == "succeeded" {
                results.push(json!({"index":index,"reused":true,"result":entry.result}));
                continue;
            }
            if mutation && ["in_flight", "uncertain"].contains(&entry.state.as_str()) {
                return Err(format!("OPERATION_OUTCOME_UNKNOWN:{index}"));
            }
            entry.state = "in_flight".into();
            save_receipt(invocation.receipt.as_ref().expect("receipt path"), saved)?;
        }
        let response = if let Some((method, path)) = special(value)? {
            if value["type"] == "google_connect" {
                connect_google(
                    session,
                    value["provider"].as_str().expect("validated provider"),
                    &path,
                )
                .await
            } else {
                request_api(
                    &client()?,
                    method,
                    &format!("{}{path}", session.origin),
                    None,
                    None,
                    &session.access,
                )
                .await
            }
        } else {
            let operation: Operation =
                serde_json::from_value(value.clone()).map_err(|_| err("INVALID_OPERATION"))?;
            execute_operation_inner(&state, &session.origin, operation, None).await
        };
        match response {
            Ok(mut result) => {
                redact(&mut result, &private);
                if let Some(saved) = receipt.as_mut() {
                    saved.entries[index].state = "succeeded".into();
                    saved.entries[index].result = Some(result.clone());
                    save_receipt(invocation.receipt.as_ref().expect("receipt path"), saved)?;
                }
                results.push(json!({"index":index,"result":result}));
            }
            Err(code) => {
                if let Some(saved) = receipt.as_mut() {
                    saved.entries[index].state = if mutation
                        && (code == "MUTATION_OUTCOME_UNKNOWN"
                            || [
                                "NETWORK_ERROR",
                                "INVALID_RESPONSE",
                                "RESPONSE_TOO_LARGE",
                                "BACKEND_ERROR",
                            ]
                            .contains(&code.as_str()))
                    {
                        "uncertain"
                    } else {
                        "rejected"
                    }
                    .into();
                    save_receipt(invocation.receipt.as_ref().expect("receipt path"), saved)?;
                }
                return Err(format!("OPERATION_FAILED:{index}:{code}"));
            }
        }
    }
    Ok(json!({"operation_count":results.len(),"results":results}))
}

pub(super) fn local(args: &[String]) -> Option<Result<Value, String>> {
    if args.first().map(String::as_str) != Some("receipt") {
        return None;
    }
    Some((|| {
        if args.len() != 2
            && !(args.len() == 5 && args[2] == "--retry" && args[4] == "--confirmed-not-applied")
        {
            return Err(err("USAGE_ERROR"));
        }
        let path = Path::new(&args[1]);
        let metadata = fs::symlink_metadata(path).map_err(|_| err("OUTBOX_READ_FAILED"))?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err(err("OUTBOX_PERMISSIONS"));
        }
        let _lock = acquire(path)?;
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|_| err("OUTBOX_READ_FAILED"))?
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| err("OUTBOX_READ_FAILED"))?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(err("OUTBOX_TOO_LARGE"));
        }
        let mut receipt: Receipt =
            serde_json::from_slice(&bytes).map_err(|_| err("INVALID_OUTBOX"))?;
        if receipt.version != 2 {
            return Err(err("INVALID_OUTBOX"));
        }
        if args.len() == 5 {
            let index: usize = args[3]
                .parse()
                .map_err(|_| err("INVALID_OPERATION_INDEX"))?;
            let entry = receipt
                .entries
                .get_mut(index)
                .ok_or_else(|| err("INVALID_OPERATION_INDEX"))?;
            if !["uncertain", "in_flight"].contains(&entry.state.as_str()) {
                return Err(err("OPERATION_NOT_UNCERTAIN"));
            }
            if has_secret(&entry.operation)
                || entry.operation["body"]
                    .as_object()
                    .is_some_and(|body| body.is_empty())
            {
                return Err(err("SECRET_COMMAND_NEEDS_NEW_RECEIPT"));
            }
            // Explicit owner assertion after checking server state, never an automatic retry.
            entry.state = "pending".into();
            entry.result = None;
            save_receipt(path, &receipt)?;
        }
        Ok(
            json!({"version":receipt.version,"origin":receipt.origin,"owner_id":receipt.owner_id,
            "operations":receipt.entries.iter().enumerate().map(|(index,entry)|json!({"index":index,"type":entry.operation["type"],"state":entry.state,"has_result":entry.result.is_some()})).collect::<Vec<_>>()}),
        )
    })())
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
