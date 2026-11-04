//! Explicit owner CLI. No arbitrary HTTP, shell commands, or exported credentials.
use super::*;
mod commands;
use chrono::DateTime;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const MAX_INPUT: u64 = 2 * 1024 * 1024;
const HELP: &str = "Aelys CLI (macOS)\n\
Usage: aelys --origin https://HOST status|unlock\n\
       aelys --origin https://HOST import FILE [--apply [--unlock-keychain]]\n\
Import JSON: {\"version\":1,\"events\":[...],\"mail_sync\":[\"ACCOUNT_ID\"]}\n\
Without --apply: local validation only; no authentication or network.\n\
With --apply: Touch ID policy, durable local outbox, duplicate checks, sequential sync.\n\
Re-run the same command/file to resume. No credentials are printed or exported.";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    version: u8,
    #[serde(default)]
    events: Vec<CalendarEventInput>,
    #[serde(default)]
    mail_sync: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Outbox {
    version: u8,
    origin: String,
    owner_id: String,
    digest: String,
    batch: Batch,
    event_ids: Vec<Option<String>>,
    mail_done: Vec<bool>,
}
struct Import {
    path: PathBuf,
    batch: Batch,
    digest: String,
    apply: bool,
    unlock_keychain: bool,
}
enum Command {
    Status,
    Unlock,
    Import(Import),
    Operations(commands::Invocation),
}
struct Lock(PathBuf);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn hash(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn timestamp(value: &str) -> Result<i64, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_micros())
        .map_err(|_| err("INVALID_DATETIME"))
}
fn validate(batch: &Batch) -> Result<(), String> {
    if batch.version != 1
        || batch.events.len() + batch.mail_sync.len() > 200
        || batch.events.is_empty() && batch.mail_sync.is_empty()
    {
        return Err(err("INVALID_BATCH"));
    }
    for event in &batch.events {
        if !valid_calendar_event(event)
            || timestamp(&event.ends_at)? <= timestamp(&event.starts_at)?
            || event
                .reminder_at
                .as_deref()
                .map(timestamp)
                .transpose()?
                .is_some_and(|time| timestamp(&event.starts_at).is_ok_and(|start| time > start))
        {
            return Err(err("INVALID_EVENT"));
        }
    }
    if batch.mail_sync.iter().any(|id| !valid_id(id)) {
        return Err(err("INVALID_ACCOUNT_ID"));
    }
    Ok(())
}
fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|_| err("INPUT_READ_FAILED"))?;
    if !file
        .metadata()
        .map_err(|_| err("INPUT_READ_FAILED"))?
        .is_file()
    {
        return Err(err("INPUT_NOT_REGULAR_FILE"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_INPUT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| err("INPUT_READ_FAILED"))?;
    if bytes.len() as u64 > MAX_INPUT {
        return Err(err("INPUT_TOO_LARGE"));
    }
    Ok(bytes)
}
fn parse(args: &[String]) -> Result<(String, Command), String> {
    if args.len() < 3 || args[0] != "--origin" {
        return Err(err("USAGE_ERROR"));
    }
    let origin = origin_fn(&args[1])?;
    if let Some(command) = commands::parse(&args[2..])? {
        return Ok((origin, Command::Operations(command)));
    }
    match args[2].as_str() {
        "status" if args.len() == 3 => Ok((origin, Command::Status)),
        "unlock" if args.len() == 3 => Ok((origin, Command::Unlock)),
        "import"
            if args.len() == 4
                || args.len() == 5 && args[4] == "--apply"
                || args.len() == 6 && args[4] == "--apply" && args[5] == "--unlock-keychain" =>
        {
            let path = PathBuf::from(&args[3]);
            let bytes = read_bounded(&path)?;
            let batch: Batch =
                serde_json::from_slice(&bytes).map_err(|_| err("INVALID_BATCH_JSON"))?;
            validate(&batch)?;
            let digest = hash(&serde_json::to_vec(&batch).map_err(|_| err("INVALID_BATCH"))?);
            Ok((
                origin,
                Command::Import(Import {
                    path,
                    batch,
                    digest,
                    apply: args.len() >= 5,
                    unlock_keychain: args.len() == 6,
                }),
            ))
        }
        _ => Err(err("USAGE_ERROR")),
    }
}
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}
fn lock_at(path: &Path) -> Result<File, String> {
    if path.is_symlink() {
        return Err(err("STORAGE_ERROR"));
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|_| err("STORAGE_ERROR"))?;
    file.try_lock().map_err(|_| err("CLOSE_AELYS_FIRST"))?;
    Ok(file)
}
/// Serialize GUI/CLI session ownership, including legacy rotating credentials.
/// The OS releases the advisory lock on normal exit and crashes alike.
pub fn lock_native_session() -> Result<File, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| err("STORAGE_ERROR"))?;
    let directory = PathBuf::from(home).join("Library/Application Support/com.aelys.desktop");
    fs::create_dir_all(&directory).map_err(|_| err("STORAGE_ERROR"))?;
    lock_at(&directory.join("native-session.lock"))
}
fn acquire(path: &Path) -> Result<Lock, String> {
    let lock = sibling(path, ".aelys-lock");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&lock)
        .map_err(|_| err("IMPORT_LOCKED"))?;
    writeln!(file, "{}", std::process::id()).map_err(|_| err("OUTBOX_WRITE_FAILED"))?;
    file.sync_all().map_err(|_| err("OUTBOX_WRITE_FAILED"))?;
    Ok(Lock(lock))
}
fn save(path: &Path, outbox: &Outbox) -> Result<(), String> {
    let temporary = sibling(path, &format!(".tmp-{}", std::process::id()));
    let result = (|| {
        let bytes = serde_json::to_vec(outbox).map_err(|_| err("OUTBOX_WRITE_FAILED"))?;
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
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )
        .and_then(|directory| directory.sync_all())
        .map_err(|_| err("OUTBOX_WRITE_FAILED"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn open_outbox(import: Import, origin: &str, owner_id: &str) -> Result<(PathBuf, Outbox), String> {
    let path = sibling(&import.path, ".aelys-outbox.json");
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
                return Err(err("OUTBOX_PERMISSIONS"));
            }
            let outbox: Outbox =
                serde_json::from_slice(&read_bounded(&path)?).map_err(|_| err("INVALID_OUTBOX"))?;
            let digest =
                hash(&serde_json::to_vec(&outbox.batch).map_err(|_| err("INVALID_OUTBOX"))?);
            if outbox.version != 1
                || outbox.origin != origin
                || outbox.owner_id != owner_id
                || outbox.digest != import.digest
                || digest != import.digest
                || outbox.event_ids.len() != outbox.batch.events.len()
                || outbox.mail_done.len() != outbox.batch.mail_sync.len()
                || outbox.event_ids.iter().flatten().any(|id| !valid_id(id))
            {
                return Err(err("OUTBOX_CONFLICT"));
            }
            Ok((path, outbox))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let outbox = Outbox {
                version: 1,
                origin: origin.into(),
                owner_id: owner_id.into(),
                digest: import.digest,
                event_ids: vec![None; import.batch.events.len()],
                mail_done: vec![false; import.batch.mail_sync.len()],
                batch: import.batch,
            };
            save(&path, &outbox)?;
            Ok((path, outbox))
        }
        Err(_) => Err(err("OUTBOX_READ_FAILED")),
    }
}
fn same_event(existing: &Value, event: &CalendarEventInput) -> bool {
    existing["external_source"].is_null()
        && existing["title"].as_str() == Some(&event.title)
        && existing["starts_at"]
            .as_str()
            .and_then(|time| timestamp(time).ok())
            == timestamp(&event.starts_at).ok()
        && existing["ends_at"]
            .as_str()
            .and_then(|time| timestamp(time).ok())
            == timestamp(&event.ends_at).ok()
        && existing["timezone"].as_str() == Some(&event.timezone)
        && existing["rrule"].as_str() == event.rrule.as_deref()
        && existing["all_day"].as_bool() == Some(event.all_day)
        && existing["project_id"].as_str() == event.project_id.as_deref()
        && existing["linked_task_id"].as_str() == event.linked_task_id.as_deref()
}
async fn api(
    client: &Client,
    session: &Session,
    method: Method,
    path: &str,
    body: Option<Value>,
    key: Option<&str>,
) -> Result<Value, String> {
    request_api(
        client,
        method,
        &format!("{}/api/v1/{path}", session.origin),
        body,
        key,
        &session.access,
    )
    .await
}
async fn apply(client: &Client, session: &Session, import: Import) -> Result<Value, String> {
    let _lock = acquire(&import.path)?;
    let (path, mut outbox) = open_outbox(import, &session.origin, &session.record.owner_id)?;
    // Plan and every checkpoint are durable before starting the next server mutation.
    let mut events = api(client, session, Method::GET, "calendar/events", None, None)
        .await?
        .as_array()
        .cloned()
        .ok_or_else(|| err("INVALID_RESPONSE"))?;
    let mut created = 0;
    let mut skipped = 0;
    let mut synced = 0;
    for index in 0..outbox.batch.events.len() {
        if outbox.event_ids[index].is_some() {
            skipped += 1;
            continue;
        }
        let event = &outbox.batch.events[index];
        let matches: Vec<_> = events
            .iter()
            .filter(|existing| same_event(existing, event))
            .collect();
        if matches.len() > 1 {
            return Err(err("DUPLICATE_EVENT_CONFLICT"));
        }
        let id = if let Some(existing) = matches.first() {
            skipped += 1;
            existing["id"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or_else(|| err("INVALID_RESPONSE"))?
                .to_owned()
        } else {
            let body = serde_json::to_value(event).map_err(|_| err("INVALID_BATCH"))?;
            let key = format!(
                "cli-event-v1-{}",
                hash(
                    &serde_json::to_vec(&json!([session.record.owner_id, body]))
                        .map_err(|_| err("INVALID_BATCH"))?
                )
            );
            let response = api(
                client,
                session,
                Method::POST,
                "calendar/events",
                Some(body),
                Some(&key),
            )
            .await?;
            let id = response["id"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or_else(|| err("INVALID_RESPONSE"))?
                .to_owned();
            events.push(response);
            created += 1;
            id
        };
        outbox.event_ids[index] = Some(id);
        save(&path, &outbox)?;
        eprintln!("calendar: {}/{}", index + 1, outbox.batch.events.len());
    }
    for index in 0..outbox.batch.mail_sync.len() {
        if outbox.mail_done[index] {
            continue;
        }
        api(
            client,
            session,
            Method::POST,
            &format!("mail/gmail/{}/sync", outbox.batch.mail_sync[index]),
            Some(json!({})),
            None,
        )
        .await?;
        // Gmail sync uses stable provider IDs; an interrupted retry cannot duplicate messages.
        outbox.mail_done[index] = true;
        save(&path, &outbox)?;
        synced += 1;
    }
    Ok(
        json!({"events_created":created,"events_skipped":skipped,"series_total":outbox.event_ids.len(),"mail_synced":synced}),
    )
}
async fn resume_cli(
    client: &Client,
    store: &impl Store,
    old: Record,
) -> Result<(Session, bool), String> {
    if old.device_key.is_some() {
        return Ok((resume_device(client, &old.origin, &old).await?, true));
    }
    // Same fail-closed rotation as native_resume. The cross-process lock keeps
    // the GUI from consuming this single-use refresh credential concurrently.
    store.delete(&old.origin).await?;
    let tokens: Tokens = request(
        client,
        Method::POST,
        &format!("{}/api/v1/auth/native/refresh", old.origin),
        Some(json!({"refresh_token":old.refresh_token})),
        None,
    )
    .await?;
    let session = session_from(&old.origin, tokens)?;
    if session.record.owner_id != old.owner_id || session.record.device_id != old.device_id {
        return Err(err("INVALID_RESPONSE"));
    }
    Ok((persist_or_revoke(client, store, session).await?, false))
}
async fn authenticated(origin: String, command: Command) -> Result<Value, String> {
    let _session_lock = lock_native_session()?;
    let gate_origin = origin.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if crate::biometric::enabled(&gate_origin)? {
            eprintln!("Confirm Touch ID to unlock the saved Aelys device identity.");
            crate::biometric::authenticate()?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| err("BIOMETRIC_UNAVAILABLE"))??;
    if matches!(&command, Command::Operations(invocation) if invocation.unlock_keychain)
        || matches!(&command, Command::Unlock)
        || matches!(&command, Command::Import(import) if import.unlock_keychain)
    {
        let unlock_origin = origin.clone();
        let found = tauri::async_runtime::spawn_blocking(move || {
            eprintln!("Approve access to the existing Aelys item in the macOS Keychain prompt.");
            crate::keychain::authorize(SERVICE, &unlock_origin)
        })
        .await
        .map_err(|_| err("STORAGE_ERROR"))??;
        if !found {
            return Err(err("SIGN_IN_REQUIRED"));
        }
    }
    let old = NativeStorage {}
        .read(&origin)
        .await?
        .ok_or_else(|| err("SIGN_IN_REQUIRED"))?;
    if matches!(&command, Command::Unlock) {
        return Ok(json!({"unlocked":true}));
    }
    let client = client_with_timeout(Duration::from_secs(180))?;
    let (session, ephemeral) = resume_cli(&client, &NativeStorage {}, old).await?;
    let result = match command {
        Command::Status => async {
            let events = api(&client, &session, Method::GET, "calendar/events", None, None).await?;
            let accounts = api(&client, &session, Method::GET, "mail/accounts", None, None).await?;
            let accounts = accounts.as_array().ok_or_else(|| err("INVALID_RESPONSE"))?.iter()
                .map(|account| json!({"id":account["id"],"provider":account["provider"]})).collect::<Vec<_>>();
            Ok(json!({"authenticated":true,"calendar_series":events.as_array().ok_or_else(|| err("INVALID_RESPONSE"))?.len(),"mail_accounts":accounts}))
        }.await,
        Command::Import(import) => apply(&client, &session, import).await,
        Command::Operations(invocation) => commands::execute(&session, invocation).await,
        Command::Unlock => unreachable!("unlock returns before session creation"),
    };
    if !ephemeral {
        // Legacy refresh was rotated and durably replaced for the next GUI/CLI
        // launch. Revoking it here would also revoke the owner's saved sign-in.
        return result;
    }
    let cleanup: Result<Value, String> = request(
        &client,
        Method::POST,
        &format!("{origin}/api/v1/auth/native/logout"),
        Some(json!({"refresh_token":session.record.refresh_token})),
        None,
    )
    .await;
    if cleanup.is_err() {
        eprintln!(
            "SESSION_CLEANUP_FAILED: temporary session will expire; credentials were not saved."
        );
    }
    result
}
pub fn run_cli(args: Vec<String>) -> i32 {
    if args == ["operations"] {
        println!("{}", commands::catalogue());
        return 0;
    }
    if args.is_empty() || args == ["--help"] || args == ["help"] {
        println!("{HELP}\n{}", commands::HELP);
        return 0;
    }
    let result = (|| {
        if args.len() >= 3 && args[0] == "--origin" {
            origin_fn(&args[1])?;
            if let Some(result) = commands::local(&args[2..]) {
                return result;
            }
        }
        parse(&args).and_then(|(origin, command)| {
        if let Command::Import(import) = &command {
            if !import.apply {
                return Ok(json!({"valid":true,"apply":false,"events":import.batch.events.len(),"mail_sync":import.batch.mail_sync.len(),"digest":import.digest}));
            }
        }
        if let Command::Operations(invocation) = &command {
            if invocation.preview { return Ok(invocation.preview_value()); }
        }
        tauri::async_runtime::block_on(authenticated(origin, command))
        })
    })();
    match result {
        Ok(value) => {
            println!("{value}");
            0
        }
        Err(code) => {
            eprintln!("{code}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Batch {
        serde_json::from_value(json!({"version":1,"events":[{
            "title":"Example lecture", "starts_at":"2026-11-05T05:30:00Z",
            "ends_at":"2026-11-05T06:20:00Z", "timezone":"Asia/Almaty",
            "rrule":"FREQ=WEEKLY;BYDAY=TH;UNTIL=20261218T185959Z"
        }]}))
        .unwrap()
    }
    fn event(id: &str) -> Value {
        let mut value = serde_json::to_value(&fixture().events[0]).unwrap();
        value["id"] = json!(id);
        value["starts_at"] = json!("2026-11-05T10:30:00+05:00");
        value
    }
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let mut random = [0_u8; 16];
            ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random).unwrap();
            let path = std::env::temp_dir().join(format!("aelys-cli-test-{}", hash(&random)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn import(&self, batch: Batch) -> Import {
            let digest = hash(&serde_json::to_vec(&batch).unwrap());
            Import {
                path: self.0.join("batch.json"),
                batch,
                digest,
                apply: true,
                unlock_keychain: false,
            }
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn session(origin: String) -> Session {
        Session {
            origin: origin.clone(),
            access: "private-access".into(),
            record: Record {
                origin,
                owner_id: "owner-1".into(),
                device_id: "device-1".into(),
                refresh_token: "private-refresh".into(),
                device_key: None,
            },
        }
    }
    #[test]
    fn rejects_unknown_fields_dates_and_unsafe_accounts_before_authentication() {
        assert!(serde_json::from_value::<Batch>(json!({"version":1,"token":"secret"})).is_err());
        let mut batch = fixture();
        batch.events[0].ends_at = "2026-11-05T05:30:00Z".into();
        assert!(validate(&batch).is_err());
        batch.events[0].ends_at = "not-a-date".into();
        assert!(validate(&batch).is_err());
        let mut batch = fixture();
        batch.mail_sync.push("../send".into());
        assert!(validate(&batch).is_err());
        assert!(parse(&[
            "--origin".into(),
            "https://host/path".into(),
            "status".into()
        ])
        .is_err());
    }
    #[test]
    fn matches_equivalent_instants_but_never_imported_google_events() {
        let batch = fixture();
        let mut existing = event("event-1");
        assert!(same_event(&existing, &batch.events[0]));
        existing["external_source"] = json!("google_calendar");
        assert!(!same_event(&existing, &batch.events[0]));
    }
    #[test]
    fn local_preview_is_non_mutating_and_bounded() {
        let directory = Directory::new();
        let path = directory.0.join("batch.json");
        fs::write(&path, serde_json::to_vec(&fixture()).unwrap()).unwrap();
        let (origin, command) = parse(&[
            "--origin".into(),
            "https://example.com".into(),
            "import".into(),
            path.to_string_lossy().into(),
        ])
        .unwrap();
        assert_eq!(origin, "https://example.com");
        assert!(matches!(
            command,
            Command::Import(Import { apply: false, .. })
        ));
        assert!(!sibling(&path, ".aelys-outbox.json").exists());
        let args = vec![
            "--origin".into(),
            "https://example.com".into(),
            "import".into(),
            path.to_string_lossy().into(),
            "--unlock-keychain".into(),
        ];
        assert!(parse(&args).is_err());
        let mut args = args;
        args.insert(4, "--apply".into());
        assert!(matches!(
            parse(&args).unwrap().1,
            Command::Import(Import {
                apply: true,
                unlock_keychain: true,
                ..
            })
        ));
        let file = File::create(&path).unwrap();
        file.set_len(MAX_INPUT + 1).unwrap();
        assert_eq!(read_bounded(&path).unwrap_err(), "INPUT_TOO_LARGE");
    }
    #[test]
    fn checkpoints_deduplication_and_resumes_without_a_second_post() {
        let directory = Directory::new();
        let (origin, server) = super::super::passwordless_tests::server(vec![
            json!([event("existing-1")]),
            json!([event("existing-1")]),
        ]);
        tauri::async_runtime::block_on(async {
            let session = session(origin);
            for _ in 0..2 {
                let result = apply(&client().unwrap(), &session, directory.import(fixture()))
                    .await
                    .unwrap();
                assert_eq!(result["events_created"], 0);
                assert_eq!(result["events_skipped"], 1);
                assert!(!result.to_string().contains("private-"));
            }
        });
        let requests = server.join().unwrap();
        assert!(requests.iter().all(|request| request.starts_with("GET ")));
        let path = directory.0.join("batch.json.aelys-outbox.json");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let saved = fs::read_to_string(path).unwrap();
        assert!(!saved.contains("private-access") && !saved.contains("private-refresh"));
    }
    #[test]
    fn ambiguous_post_reuses_stable_idempotency_key_on_retry() {
        let directory = Directory::new();
        let (origin, server) = super::super::passwordless_tests::server(vec![
            json!([]),
            json!({}),
            json!([]),
            event("created-1"),
        ]);
        tauri::async_runtime::block_on(async {
            let session = session(origin);
            assert!(
                apply(&client().unwrap(), &session, directory.import(fixture()))
                    .await
                    .is_err()
            );
            let result = apply(&client().unwrap(), &session, directory.import(fixture()))
                .await
                .unwrap();
            assert_eq!(result["events_created"], 1);
        });
        let requests = server.join().unwrap();
        let key = |request: &str| {
            request
                .lines()
                .find(|line| line.to_ascii_lowercase().starts_with("idempotency-key:"))
                .unwrap()
                .to_owned()
        };
        assert_eq!(key(&requests[1]), key(&requests[3]));
    }
    #[test]
    fn refuses_owner_file_changes_concurrent_imports_and_symlink_outboxes() {
        let directory = Directory::new();
        let path = directory.0.join("batch.json");
        let lock = acquire(&path).unwrap();
        assert!(acquire(&path).is_err());
        drop(lock);
        let (outbox_path, _) = open_outbox(
            directory.import(fixture()),
            "https://example.com",
            "owner-1",
        )
        .unwrap();
        assert!(open_outbox(
            directory.import(fixture()),
            "https://example.com",
            "owner-2"
        )
        .is_err());
        let mut changed = fixture();
        changed.events[0].title = "Changed".into();
        assert!(open_outbox(directory.import(changed), "https://example.com", "owner-1").is_err());
        fs::remove_file(&outbox_path).unwrap();
        std::os::unix::fs::symlink(directory.0.join("other"), &outbox_path).unwrap();
        assert!(open_outbox(
            directory.import(fixture()),
            "https://example.com",
            "owner-1"
        )
        .is_err());
    }

    #[test]
    fn process_lock_prevents_gui_cli_refresh_races_and_releases_on_drop() {
        let directory = Directory::new();
        let path = directory.0.join("session.lock");
        let held = lock_at(&path).unwrap();
        assert_eq!(lock_at(&path).unwrap_err(), "CLOSE_AELYS_FIRST");
        drop(held);
        assert!(lock_at(&path).is_ok());
    }
    #[test]
    fn legacy_refresh_is_replaced_durably_without_revoking_saved_sign_in() {
        let (origin, server) = super::super::passwordless_tests::server(vec![json!({
            "access_token":"new-access", "refresh_token":"new-refresh", "owner_id":"owner-1",
            "device_id":"device-1", "token_type":"bearer", "expires_in":900
        })]);
        tauri::async_runtime::block_on(async {
            let old = session(origin).record;
            let store = super::super::passwordless_tests::MemoryStore(std::cell::RefCell::new(
                Some(serde_json::to_string(&old).unwrap()),
            ));
            let (resumed, ephemeral) = resume_cli(&client().unwrap(), &store, old).await.unwrap();
            assert!(!ephemeral);
            assert_eq!(resumed.access, "new-access");
            assert_eq!(
                store
                    .read(&resumed.origin)
                    .await
                    .unwrap()
                    .unwrap()
                    .refresh_token,
                "new-refresh"
            );
        });
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /api/v1/auth/native/refresh "));
    }
}
