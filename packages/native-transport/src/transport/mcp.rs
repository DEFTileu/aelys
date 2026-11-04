//! Local owner-authorized data broker. Credentials never cross the MCP channel.
use super::*;
use ring::{
    hmac,
    rand::{SecureRandom, SystemRandom},
};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::{
    fs::{OpenOptionsExt, PermissionsExt},
    net::{UnixListener, UnixStream},
};
use std::path::PathBuf;

const SERVICE_MCP: &str = "com.aelys.desktop.mcp";
const ACCOUNT: &str = "owner-data-access-v1";
const MAX: usize = 2 * 1024 * 1024;
fn directory() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| err("STORAGE_ERROR"))?;
    let dir = PathBuf::from(home).join("Library/Application Support/com.aelys.desktop/mcp");
    if dir.is_symlink() {
        return Err(err("STORAGE_ERROR"));
    }
    fs::create_dir_all(&dir).map_err(|_| err("STORAGE_ERROR"))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
        .map_err(|_| err("STORAGE_ERROR"))?;
    Ok(dir)
}
fn key() -> Result<Vec<u8>, String> {
    crate::keychain::read(SERVICE_MCP, ACCOUNT)?
        .filter(|k| k.len() == 32)
        .ok_or_else(|| err("MCP_DISABLED"))
}
fn read_message(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut bytes = Vec::new();
    reader
        .take((MAX + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|_| err("MCP_IO_ERROR"))?;
    if bytes.is_empty() {
        return Err(err("MCP_EOF"));
    }
    if bytes.len() > MAX || bytes.last() != Some(&b'\n') {
        return Err(err("MCP_MESSAGE_TOO_LARGE"));
    }
    serde_json::from_slice(&bytes).map_err(|_| err("MCP_INVALID_JSON"))
}
fn send(stream: &mut impl Write, value: &Value) -> Result<(), String> {
    writeln!(stream, "{value}")
        .and_then(|_| stream.flush())
        .map_err(|_| err("MCP_IO_ERROR"))
}
/// Explicit owner data grant: allow only typed data operations, never generic
/// HTTP, credentials, device control, agent execution or external AI effects.
struct McpPolicyEngine;
impl McpPolicyEngine {
    fn authorize(value: &Value, write: bool) -> Result<Operation, String> {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| err("INVALID_OPERATION"))?;
        let reads = [
            "me",
            "projects",
            "tasks",
            "notes",
            "read_page",
            "read_item",
            "calendar_occurrences",
            "calendar_events",
            "calendar_reminders",
            "finance_transactions",
            "finance_accounts",
            "finance_categories",
            "finance_budgets",
            "finance_summary",
            "focus_sessions",
            "mail_messages",
            "mail_accounts",
            "mail_drafts",
            "activity",
            "notifications",
            "ai_conversations",
            "ai_messages",
        ];
        let writes = [
            "project_create",
            "project_patch",
            "project_delete",
            "task_create",
            "task_patch",
            "task_delete",
            "note_create",
            "note_patch",
            "note_delete",
            "calendar_event_create",
            "calendar_event_patch",
            "calendar_event_delete",
            "calendar_reminder_create",
            "calendar_reminder_delete",
            "finance_account_create",
            "finance_category_create",
            "finance_transaction_create",
            "finance_budget_create",
            "finance_transfer_create",
            "focus_start",
            "focus_stop",
            "mail_draft_create",
            "mail_draft_patch",
            "mail_draft_delete",
            "notification_read",
        ];
        if !(if write {
            writes.contains(&kind)
        } else {
            reads.contains(&kind)
        }) {
            return Err(err("MCP_POLICY_DENIED"));
        }
        let operation: Operation =
            serde_json::from_value(value.clone()).map_err(|_| err("INVALID_OPERATION"))?;
        // route also validates IDs, decimal amounts, bounded paths and bodies.
        route(serde_json::from_value(value.clone()).map_err(|_| err("INVALID_OPERATION"))?)?;
        Ok(operation)
    }
}
fn digest(value: &Value) -> String {
    ring::digest::digest(&ring::digest::SHA256, value.to_string().as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn save(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|_| err("STORAGE_ERROR"))?;
    file.write_all(value.to_string().as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|_| err("STORAGE_ERROR"))?;
    fs::rename(&tmp, path).map_err(|_| err("STORAGE_ERROR"))?;
    std::fs::File::open(path.parent().ok_or_else(|| err("STORAGE_ERROR"))?)
        .and_then(|f| f.sync_all())
        .map_err(|_| err("STORAGE_ERROR"))
}
async fn execute(state: &NativeState, request: Value) -> Result<Value, String> {
    execute_at(state, request, &directory()?).await
}
async fn execute_at(
    state: &NativeState,
    request: Value,
    receipt_dir: &std::path::Path,
) -> Result<Value, String> {
    let write = request["write"]
        .as_bool()
        .ok_or_else(|| err("INVALID_OPERATION"))?;
    let operation = McpPolicyEngine::authorize(&request["operation"], write)?;
    let (origin, owner, device, access) = {
        let guard = state.0.lock().await;
        let session = guard.as_ref().ok_or_else(|| err("SIGN_IN_REQUIRED"))?;
        (
            session.origin.clone(),
            session.record.owner_id.clone(),
            session.record.device_id.clone(),
            session.access.clone(),
        )
    };
    if !write {
        return execute_operation_inner(state, &origin, operation, None).await;
    }
    let id = request["request_id"]
        .as_str()
        .filter(|s| valid_id(s))
        .ok_or_else(|| err("MCP_REQUEST_ID_REQUIRED"))?;
    let binding =
        json!({"origin":origin,"owner":owner,"device":device,"operation":request["operation"]});
    let hash = digest(&binding);
    let path = receipt_dir.join(format!("{}.json", digest(&json!([owner, device, id]))));
    if path.exists() {
        if path.is_symlink() {
            return Err(err("STORAGE_ERROR"));
        }
        let old: Value =
            serde_json::from_slice(&fs::read(&path).map_err(|_| err("STORAGE_ERROR"))?)
                .map_err(|_| err("STORAGE_ERROR"))?;
        if old["digest"] != hash {
            return Err(err("IDEMPOTENCY_CONFLICT"));
        }
        if old["state"] == "done" {
            ensure_operation_session(state, &origin, &access, false).await?;
            return Ok(old["result"].clone());
        }
        return Err(err("MCP_WRITE_OUTCOME_UNCERTAIN"));
    }
    // Persist the complete mutation before dispatch. Never automatically replay
    // a pending receipt after a crash or an ambiguous network response.
    save(
        &path,
        &json!({"digest":hash,"state":"pending","request":binding}),
    )?;
    ensure_operation_session(state, &origin, &access, false).await?;
    let result = execute_operation_inner(state, &origin, operation, None).await?;
    save(
        &path,
        &json!({"digest":hash,"state":"done","result":result}),
    )?;
    Ok(result)
}
fn verify_request(request: &Value, secret: &[u8]) -> Result<(), String> {
    let supplied: Vec<u8> = serde_json::from_value(request["authorization"].clone())
        .map_err(|_| err("MCP_UNAUTHORIZED"))?;
    let mut payload = request.clone();
    payload
        .as_object_mut()
        .ok_or_else(|| err("MCP_UNAUTHORIZED"))?
        .remove("authorization");
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, secret),
        payload.to_string().as_bytes(),
        &supplied,
    )
    .map_err(|_| err("MCP_UNAUTHORIZED"))
}
/// Start only inside the desktop process; uses its managed in-memory session.
pub fn start_mcp_broker(app: tauri::AppHandle) -> Result<(), String> {
    let path = directory()?.join("broker.sock");
    if path.exists() {
        if !path
            .symlink_metadata()
            .map_err(|_| err("STORAGE_ERROR"))?
            .file_type()
            .is_socket()
        {
            return Err(err("STORAGE_ERROR"));
        }
        fs::remove_file(&path).map_err(|_| err("STORAGE_ERROR"))?;
    }
    let listener = UnixListener::bind(&path).map_err(|_| err("MCP_IO_ERROR"))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|_| err("STORAGE_ERROR"))?;
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
            let mut request_digest = String::new();
            let result = (|| {
                let request = read_message(&mut BufReader::new(
                    stream.try_clone().map_err(|_| err("MCP_IO_ERROR"))?,
                ))?;
                verify_request(&request, &key()?)?;
                request_digest = digest(&request);
                tauri::async_runtime::block_on(execute(app.state::<NativeState>().inner(), request))
            })();
            let mut response = match result {
                Ok(value) => json!({"result":value}),
                Err(code) => json!({"error":code}),
            };
            response["request_digest"] = json!(request_digest);
            if let Ok(secret) = key() {
                let proof = hmac::sign(
                    &hmac::Key::new(hmac::HMAC_SHA256, &secret),
                    response.to_string().as_bytes(),
                );
                response["authorization"] = json!(proof.as_ref());
                let _ = send(&mut stream, &response);
            } else {
                let _ = send(&mut stream, &json!({"error":"MCP_DISABLED"}));
            }
        }
    });
    Ok(())
}
use std::os::unix::fs::FileTypeExt;
fn forward(args: &Value, write: bool) -> Result<Value, String> {
    let secret = key()?;
    let mut stream = UnixStream::connect(directory()?.join("broker.sock"))
        .map_err(|_| err("AELYS_NOT_RUNNING"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(190)))
        .map_err(|_| err("MCP_IO_ERROR"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| err("MCP_IO_ERROR"))?;
    let mut nonce = [0u8; 16];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| err("STORAGE_ERROR"))?;
    let mut request = json!({"nonce":nonce,"operation":args["operation"],"request_id":args["request_id"],"write":write});
    let proof = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, &secret),
        request.to_string().as_bytes(),
    )
    .as_ref()
    .to_vec();
    request["authorization"] = json!(proof);
    send(&mut stream, &request)?;
    let response = read_message(&mut BufReader::new(stream))?;
    verify_request(&response, &secret)?;
    if response["request_digest"] != digest(&request) {
        return Err(err("MCP_UNAUTHORIZED"));
    }
    if let Some(code) = response["error"].as_str() {
        return Err(code.into());
    }
    Ok(response["result"].clone())
}
fn tools() -> Value {
    json!({"tools":[
        {"name":"aelys_read","description":"Read Aelys owner data using a typed operation. Aelys must be open and signed in. Use aelys_catalogue for examples.","inputSchema":{"type":"object","properties":{"operation":{"type":"object"}},"required":["operation"],"additionalProperties":false},"annotations":{"readOnlyHint":true}},
        {"name":"aelys_write","description":"Write Aelys owner data. Supply a unique stable request_id for each intentional mutation; replaying it returns the stored result or stops if outcome is uncertain.","inputSchema":{"type":"object","properties":{"operation":{"type":"object"},"request_id":{"type":"string","minLength":1,"maxLength":100}},"required":["operation","request_id"],"additionalProperties":false},"annotations":{"readOnlyHint":false,"destructiveHint":true}},
        {"name":"aelys_catalogue","description":"List supported typed operation examples for Aelys data read/write tools.","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"annotations":{"readOnlyHint":true}}
    ]})
}
fn rpc(request: Value) -> Option<Value> {
    if request.get("jsonrpc") != Some(&json!("2.0")) || !request["method"].is_string() {
        return Some(
            json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}),
        );
    }
    let id = request.get("id")?.clone();
    let method = request["method"].as_str().unwrap_or("");
    let response = match method {
        "initialize" => {
            json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"aelys-desktop","version":"0.1.0"}})
        }
        "ping" => json!({}),
        "tools/list" => tools(),
        "tools/call" => {
            let name = request["params"]["name"].as_str().unwrap_or("");
            let args = &request["params"]["arguments"];
            let result = match name {
                "aelys_read" => forward(args, false),
                "aelys_write" => forward(args, true),
                "aelys_catalogue" => {
                    let catalogue: Value =
                        serde_json::from_str(include_str!("cli/operations.json"))
                            .unwrap_or(json!({}));
                    Ok(
                        json!({"operations":catalogue["typed_operations"].as_array().map(|items|items.iter().filter(|v|McpPolicyEngine::authorize(v,false).is_ok()||McpPolicyEngine::authorize(v,true).is_ok()).cloned().collect::<Vec<_>>()).unwrap_or_default()}),
                    )
                }
                _ => Err(err("MCP_UNKNOWN_TOOL")),
            };
            match result {
                Ok(value) => {
                    json!({"content":[{"type":"text","text":value.to_string()}],"isError":false})
                }
                Err(code) => json!({"content":[{"type":"text","text":code}],"isError":true}),
            }
        }
        _ => {
            return Some(
                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}}),
            )
        }
    };
    Some(json!({"jsonrpc":"2.0","id":id,"result":response}))
}
pub fn run_mcp(mode: &str) -> i32 {
    let result = (|| -> Result<(), String> {
        match mode {
            "enable" => {
                let mut secret = [0u8; 32];
                SystemRandom::new()
                    .fill(&mut secret)
                    .map_err(|_| err("STORAGE_ERROR"))?;
                crate::keychain::write(SERVICE_MCP, ACCOUNT, &secret)?;
                eprintln!("MCP owner data access enabled. Local clients invoking this signed application can read/write your Aelys data. Run --mcp disable to revoke.");
                Ok(())
            }
            "disable" => {
                crate::keychain::delete(SERVICE_MCP, ACCOUNT)?;
                Ok(())
            }
            "stdio" => {
                let stdin = std::io::stdin();
                let mut input = stdin.lock();
                loop {
                    match read_message(&mut input) {
                        Ok(request) => {
                            if let Some(response) = rpc(request) {
                                send(&mut std::io::stdout().lock(), &response)?;
                            }
                        }
                        Err(code) if code == "MCP_EOF" => break,
                        Err(_) => {
                            send(
                                &mut std::io::stdout().lock(),
                                &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid or oversized JSON-RPC message"}}),
                            )?;
                            break;
                        }
                    }
                }
                Ok(())
            }
            _ => Err(err("USAGE_ERROR")),
        }
    })();
    match result {
        Ok(()) => 0,
        Err(code) => {
            eprintln!("{code}");
            1
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_denies_generic_http_and_external_effects() {
        for value in [
            json!({"type":"api","method":"GET","path":"/api/v1/me"}),
            json!({"type":"ai_run_create"}),
            json!({"type":"calendar_reminder_dispatch"}),
        ] {
            assert!(McpPolicyEngine::authorize(&value, true).is_err());
            assert!(McpPolicyEngine::authorize(&value, false).is_err());
        }
    }
    #[test]
    fn policy_separates_reads_and_writes() {
        let v = json!({"type":"project_create","project":{"name":"Test"}});
        assert!(McpPolicyEngine::authorize(&v, true).is_ok());
        assert!(McpPolicyEngine::authorize(&v, false).is_err());
        assert!(McpPolicyEngine::authorize(&json!({"type":"notes"}), false).is_ok());
    }
    #[test]
    fn protocol_handles_initialization_notifications_and_unknown_methods() {
        assert!(rpc(json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        assert_eq!(
            rpc(json!({"jsonrpc":"2.0","id":1,"method":"initialize"})).unwrap()["result"]
                ["protocolVersion"],
            "2025-06-18"
        );
        assert_eq!(
            rpc(json!({"jsonrpc":"2.0","id":2,"method":"other"})).unwrap()["error"]["code"],
            -32601
        );
    }
    #[test]
    fn framing_rejects_unterminated_input() {
        assert!(read_message(&mut std::io::Cursor::new(b"{}")).is_err());
        assert_eq!(
            read_message(&mut std::io::Cursor::new(b"{}\n")).unwrap(),
            json!({})
        );
    }
}

#[cfg(test)]
mod receipt_tests {
    use super::*;
    #[test]
    fn mutation_is_durable_and_replay_does_not_send_again() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut bytes = [0; 8192];
            let n = socket.read(&mut bytes).unwrap();
            assert!(String::from_utf8_lossy(&bytes[..n]).starts_with("POST /api/v1/projects "));
            let body=json!({"id":"project-1","name":"Test","description":"","status":"active","version":1}).to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let mut random = [0u8; 16];
        SystemRandom::new().fill(&mut random).unwrap();
        let dir = std::env::temp_dir().join(format!("aelys-mcp-test-{}", digest(&json!(random))));
        fs::create_dir(&dir).unwrap();
        tauri::async_runtime::block_on(async {
            let state = NativeState(Mutex::new(Some(Session {
                origin,
                access: "test-access".into(),
                record: Record {
                    origin: "unused".into(),
                    owner_id: "owner-1".into(),
                    device_id: "device-1".into(),
                    refresh_token: "test-refresh".into(),
                    device_key: None,
                },
            })));
            let request = json!({"write":true,"request_id":"intent-1","operation":{"type":"project_create","project":{"name":"Test"}}});
            let result = execute_at(&state, request.clone(), &dir).await.unwrap();
            assert_eq!(result["id"], "project-1");
            assert_eq!(
                execute_at(&state, request.clone(), &dir).await.unwrap(),
                result
            );
            let mut changed = request.clone();
            changed["operation"]["project"]["name"] = json!("Other");
            assert_eq!(
                execute_at(&state, changed, &dir).await.unwrap_err(),
                "IDEMPOTENCY_CONFLICT"
            );
            let path = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
            let mut receipt: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            receipt["state"] = json!("pending");
            save(&path, &receipt).unwrap();
            assert_eq!(
                execute_at(&state, request.clone(), &dir).await.unwrap_err(),
                "MCP_WRITE_OUTCOME_UNCERTAIN"
            );
            *state.0.lock().await = None;
            assert_eq!(
                execute_at(&state, request, &dir).await.unwrap_err(),
                "SIGN_IN_REQUIRED"
            );
        });
        server.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn durable_save_refuses_existing_temporary_path() {
        let mut random = [0u8; 16];
        SystemRandom::new().fill(&mut random).unwrap();
        let dir = std::env::temp_dir().join(format!("aelys-mcp-test-{}", digest(&json!(random))));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("receipt.json");
        let target = dir.join("target");
        fs::write(&target, b"original").unwrap();
        std::os::unix::fs::symlink(&target, path.with_extension("tmp")).unwrap();
        assert!(save(&path, &json!({"state":"pending"})).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
        fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod authentication_tests {
    use super::*;
    #[test]
    fn proof_binds_operation_and_revocation_key() {
        let secret = [1u8; 32];
        let mut request = json!({"write":false,"operation":{"type":"notes"}});
        let proof = hmac::sign(
            &hmac::Key::new(hmac::HMAC_SHA256, &secret),
            request.to_string().as_bytes(),
        );
        request["authorization"] = json!(proof.as_ref());
        assert!(verify_request(&request, &secret).is_ok());
        assert!(verify_request(&request, &[2u8; 32]).is_err());
        request["write"] = json!(true);
        assert!(verify_request(&request, &secret).is_err());
    }
}
