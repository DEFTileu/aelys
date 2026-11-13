use super::*;
use crate::transport::passwordless_tests::server;
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let mut random = [0; 16];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut random).unwrap();
        let path = std::env::temp_dir().join(format!("aelys-cli-domains-{}", hash(&random)));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn invocation(&self, operations: Vec<Value>) -> Invocation {
        finish(
            operations,
            None,
            true,
            false,
            Some(self.0.join("receipt.json")),
            false,
        )
        .unwrap()
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn session(origin: String) -> Session {
    Session {
        binding: NativeSessionBinding::new(
            &origin,
            "owner-1",
            "device-1",
            Instant::now() + Duration::from_secs(60),
        ),
        origin: origin.clone(),
        access: "cli-private-access".into(),
        record: Record {
            origin,
            owner_id: "owner-1".into(),
            device_id: "device-1".into(),
            refresh_token: "cli-private-refresh".into(),
            device_key: None,
        },
    }
}
fn note() -> Value {
    json!({"type":"note_create","note":{"title":"Example note","markdown_body":"Local-first content"}})
}
fn note_result() -> Value {
    json!({"id":"note-1","version":1,"title":"Example note","markdown_body":"Local-first content"})
}
#[test]
fn every_catalogue_example_is_accepted_by_the_native_validator() {
    let catalogue: Value = serde_json::from_str(catalogue()).unwrap();
    let examples = catalogue["typed_operations"].as_array().unwrap();
    assert_eq!(examples.len(), 58);
    for example in examples {
        assert!(describe(example).is_ok(), "{}", example["type"]);
    }
    for example in catalogue["cli_operations"].as_array().unwrap() {
        assert!(describe(example).is_ok());
    }
    for route in catalogue["api_routes"].as_array().unwrap() {
        let path = route["path"].as_str().unwrap().replace('*', "example-1");
        assert!(
            describe(&json!({"type":"api","method":route["method"],"path":path})).is_ok(),
            "{path}"
        );
    }
}
#[test]
fn typed_reads_and_each_domain_alias_use_the_existing_contract() {
    for args in [
        vec!["tasks", "list"],
        vec!["notes", "list"],
        vec!["projects", "list"],
        vec!["calendar", "list"],
        vec!["focus", "list"],
        vec!["mail", "list"],
        vec!["mail", "drafts"],
        vec!["finance", "accounts"],
        vec!["finance", "summary"],
        vec!["ai", "providers"],
        vec!["ai", "conversations"],
        vec!["automations", "list"],
        vec!["telegram", "list"],
        vec!["agents", "list"],
        vec!["knowledge", "search", "example"],
    ] {
        let args: Vec<String> = args.iter().map(|v| v.to_string()).collect();
        let invocation = parse(&args).unwrap().unwrap();
        assert!(!invocation.preview, "{args:?}");
    }
}

#[test]
fn temporary_command_state_does_not_invalidate_the_owning_session_binding() {
    let (origin, peer) = server(vec![json!([])]);
    tauri::async_runtime::block_on(async {
        let owner = session(origin);
        let invocation = parse(&["projects".into(), "list".into()]).unwrap().unwrap();
        execute(&owner, invocation).await.unwrap();
        owner.binding.ensure_active().unwrap();
    });
    assert_eq!(peer.join().unwrap().len(), 1);
}
#[test]
fn rejects_foreign_urls_auth_device_credentials_traversal_and_unknown_fields() {
    for path in [
        "https://evil.example/api/v1/automations",
        "/api/v1/auth/native/login",
        "/api/v1/devices/enroll",
        "/api/v1/pairing/invite",
        "/api/v1/sync/push",
        "/api/v1/agents/runs/id/credential-lease",
        "/api/v1/notes/../auth",
        "/api/v1/notes/%2e%2e",
        "/api/v1/notes/id?token=secret",
    ] {
        assert!(
            describe(&json!({"type":"api","method":"POST","path":path})).is_err(),
            "{path}"
        );
    }
    assert!(describe(&json!({"type":"notes","access_token":"fake"})).is_err());
    assert!(describe(
        &json!({"type":"api","method":"GET","path":"/api/v1/search","query":{"token":"fake"}})
    )
    .is_err());
    assert!(describe(&json!({"type":"api","method":"POST","path":"/api/v1/automations","idempotency_key":"bad key"})).is_err());
}
#[test]
fn preview_has_no_request_body_or_local_writes_and_mutation_needs_apply() {
    let directory = Directory::new();
    let input = directory.0.join("note.json");
    fs::write(&input, note().to_string()).unwrap();
    let invocation = parse(&["exec".into(), input.to_string_lossy().into()])
        .unwrap()
        .unwrap();
    assert!(invocation.preview);
    let preview = invocation.preview_value().to_string();
    assert!(!preview.contains("Local-first content"));
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    assert!(finish(vec![note()], None, true, false, None, false).is_err());
}
#[test]
fn secrets_require_stdin_never_enter_the_receipt_and_are_redacted_from_all_output() {
    let operation = json!({"type":"api","method":"PUT","path":"/api/v1/ai/providers/provider-1/secret","body":{"api_key":"synthetic-provider-private"}});
    assert!(finish(vec![operation.clone()], None, true, false, None, false).is_err());
    let directory = Directory::new();
    let invocation = finish(
        vec![operation],
        None,
        true,
        false,
        Some(directory.0.join("secret-receipt.json")),
        true,
    )
    .unwrap();
    let (origin, server) = server(vec![
        json!({"stored":true,"api_key":"synthetic-provider-private","nested":{"refresh_token":"server-private","message":"echo synthetic-provider-private"}}),
    ]);
    tauri::async_runtime::block_on(async {
        let session = session(origin);
        let result = execute(&session, invocation).await.unwrap().to_string();
        assert!(
            !result.contains("synthetic-provider-private") && !result.contains("server-private")
        );
        assert!(result.contains("[REDACTED]"));
    });
    let requests = server.join().unwrap();
    assert!(requests[0].contains("synthetic-provider-private"));
    let receipt = fs::read_to_string(directory.0.join("secret-receipt.json")).unwrap();
    assert!(
        !receipt.contains("synthetic-provider-private")
            && !receipt.contains("cli-private-access")
            && !receipt.contains("cli-private-refresh")
    );
}
#[test]
fn non_secret_writes_checkpoint_and_rerun_without_creating_a_duplicate() {
    let directory = Directory::new();
    let (origin, server) = server(vec![note_result()]);
    tauri::async_runtime::block_on(async {
        let session = session(origin);
        let first = execute(&session, directory.invocation(vec![note()]))
            .await
            .unwrap();
        assert_eq!(first["results"][0]["result"]["id"], "note-1");
        let second = execute(&session, directory.invocation(vec![note()]))
            .await
            .unwrap();
        assert_eq!(second["results"][0]["reused"], true);
    });
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /api/v1/notes "));
    assert!(requests[0].contains("Bearer cli-private-access"));
    let receipt = fs::read_to_string(directory.0.join("receipt.json")).unwrap();
    assert!(!receipt.contains("cli-private-access"));
    assert_eq!(
        fs::metadata(directory.0.join("receipt.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
#[test]
fn uncertain_mutation_is_not_replayed_and_rest_of_batch_remains_pending() {
    let directory = Directory::new();
    let (origin, server) = server(vec![json!({})]);
    tauri::async_runtime::block_on(async {
        let session = session(origin);
        let ops = vec![
            note(),
            json!({"type":"project_create","project":{"name":"Later project"}}),
        ];
        let error = execute(&session, directory.invocation(ops.clone()))
            .await
            .unwrap_err();
        assert!(error.contains("MUTATION_OUTCOME_UNKNOWN"));
        let error = execute(&session, directory.invocation(ops))
            .await
            .unwrap_err();
        assert_eq!(error, "OPERATION_OUTCOME_UNKNOWN:0");
    });
    assert_eq!(server.join().unwrap().len(), 1);
    let receipt: Receipt =
        serde_json::from_slice(&fs::read(directory.0.join("receipt.json")).unwrap()).unwrap();
    assert_eq!(receipt.entries[0].state, "uncertain");
    assert_eq!(receipt.entries[1].state, "pending");
}
#[test]
fn owner_origin_input_conflicts_and_symlink_receipts_fail_before_network() {
    let directory = Directory::new();
    let session = session("https://example.com".into());
    let invocation = directory.invocation(vec![note()]);
    open_receipt(&invocation, &session).unwrap();
    let other = session_from(
        &session.origin,
        Tokens {
            access_token: "a".into(),
            refresh_token: "b".into(),
            owner_id: "owner-2".into(),
            device_id: "device-2".into(),
            token_type: "bearer".into(),
            expires_in: 900,
        },
    )
    .unwrap();
    assert!(open_receipt(&invocation, &other).is_err());
    let mut changed = note();
    changed["note"]["title"] = json!("Different");
    assert!(open_receipt(&directory.invocation(vec![changed]), &session).is_err());
    let path = directory.0.join("receipt.json");
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(directory.0.join("target"), &path).unwrap();
    assert!(open_receipt(&invocation, &session).is_err());
}
#[test]
fn finance_amounts_remain_decimal_strings() {
    let mut operation = json!({"type":"finance_transaction_create","transaction":{"account_id":"account-1","amount":"0.10","currency":"KZT","type":"expense","occurred_at":"2026-11-04T05:00:00Z","idempotency_key":"example-finance-1"}});
    let (_, _, body) = describe(&operation).unwrap();
    assert_eq!(body.unwrap()["amount"], "0.10");
    operation["transaction"]["amount"] = json!(0.1);
    assert!(describe(&operation).is_err());
}
#[test]
fn explicit_receipt_recovery_only_resets_an_uncertain_operation() {
    let directory = Directory::new();
    let session = session("https://example.com".into());
    let invocation = directory.invocation(vec![note()]);
    let mut receipt = open_receipt(&invocation, &session).unwrap().unwrap();
    receipt.entries[0].state = "uncertain".into();
    save_receipt(invocation.receipt.as_ref().unwrap(), &receipt).unwrap();
    let path = directory
        .0
        .join("receipt.json")
        .to_string_lossy()
        .to_string();
    let show = local(&["receipt".into(), path.clone()]).unwrap().unwrap();
    assert_eq!(show["operations"][0]["state"], "uncertain");
    assert!(!show.to_string().contains("Local-first content"));
    assert!(
        local(&["receipt".into(), path.clone(), "--retry".into(), "0".into()])
            .unwrap()
            .is_err()
    );
    let reset = local(&[
        "receipt".into(),
        path,
        "--retry".into(),
        "0".into(),
        "--confirmed-not-applied".into(),
    ])
    .unwrap()
    .unwrap();
    assert_eq!(reset["operations"][0]["state"], "pending");
}

#[test]
fn device_management_is_fixed_scope_and_browser_connect_rejects_foreign_providers() {
    assert_eq!(
        describe(&json!({"type":"devices"})).unwrap().1,
        "/api/v1/devices"
    );
    assert_eq!(
        describe(&json!({"type":"device_revoke","id":"example-1"}))
            .unwrap()
            .1,
        "/api/v1/devices/example-1/revoke"
    );
    assert!(describe(&json!({"type":"device_revoke","id":"../enroll"})).is_err());
    assert!(describe(&json!({"type":"devices","token":"secret"})).is_err());
    assert!(describe(&json!({"type":"google_connect","provider":"https://evil.example"})).is_err());
    assert!(describe(&json!({"type":"google_connect","provider":"gmail","authorization_url":"https://evil.example"})).is_err());
}

#[test]
fn generic_finance_writes_also_reject_binary_float_amounts() {
    let mut operation = json!({"type":"api","method":"PUT","path":"/api/v1/finance/budgets","body":{"limit_amount":0.1}});
    assert!(describe(&operation).is_err());
    operation["body"]["limit_amount"] = json!("0.10");
    assert!(describe(&operation).is_ok());
}

#[test]
fn knowledge_search_shortcut_does_not_send_an_unsupported_pagination_field() {
    let invocation = parse(&["knowledge".into(), "search".into(), "Example query".into()])
        .unwrap()
        .unwrap();
    let (_, path, body) = describe(&invocation.operations[0]).unwrap();
    assert_eq!(path, "/api/v1/knowledge/search");
    assert_eq!(body.unwrap(), json!({"query":"Example query"}));
    assert!(!invocation.preview);
}

const FIRMWARE_MAX: u64 = 4_194_304;
fn s(args: &[&str]) -> Vec<String> {
    args.iter().map(|v| v.to_string()).collect()
}
fn upload_args(file: &Path, version: &str, min: &str, tail: &[&str]) -> Vec<String> {
    let mut args = s(&["companion", "firmware-upload", &file.to_string_lossy()]);
    args.extend(s(&["--version", version, "--min-version", min]));
    args.extend(s(tail));
    args
}
fn firmware_file(directory: &Directory, bytes: &[u8]) -> PathBuf {
    let path = directory.0.join("companion.bin");
    fs::write(&path, bytes).unwrap();
    path
}
#[test]
fn firmware_upload_preview_reports_hash_and_size_without_receipt_or_request() {
    let directory = Directory::new();
    let file = firmware_file(&directory, b"signed-image-bytes");
    let invocation = parse(&upload_args(&file, "0.3.0", "0.2.0", &[]))
        .unwrap()
        .unwrap();
    assert!(invocation.preview);
    let preview = invocation.preview_value();
    let entry = &preview["operations"][0];
    assert_eq!(entry["method"], "PUT");
    assert_eq!(entry["mutation"], true);
    assert_eq!(entry["version"], "0.3.0");
    assert_eq!(entry["min_version"], "0.2.0");
    assert_eq!(entry["size"], 18);
    assert_eq!(entry["sha256"], hash(b"signed-image-bytes"));
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}
#[test]
fn firmware_upload_rejects_bad_versions_before_reading_the_file() {
    let missing = Path::new("/nonexistent/companion.bin");
    for bad in [
        "1.2",
        "1.2.3.4",
        "1234.0.0",
        "a.b.c",
        "1.2.3\n",
        " 1.2.3",
        "-1.0.0",
        "1..3",
        "",
        "٣.1.1",
        "1.2.3-rc1",
    ] {
        for args in [
            upload_args(missing, bad, "0.1.0", &[]),
            upload_args(missing, "0.1.0", bad, &[]),
        ] {
            assert_eq!(parse(&args).err().unwrap(), "VALIDATION_ERROR", "{bad:?}");
        }
    }
}
#[test]
fn firmware_upload_enforces_the_size_cap_and_missing_flags() {
    let directory = Directory::new();
    let file = directory.0.join("big.bin");
    let handle = File::create(&file).unwrap();
    handle.set_len(FIRMWARE_MAX + 1).unwrap();
    assert_eq!(
        parse(&upload_args(&file, "0.3.0", "0.2.0", &[]))
            .err()
            .unwrap(),
        "VALIDATION_ERROR"
    );
    handle.set_len(FIRMWARE_MAX).unwrap();
    assert!(parse(&upload_args(&file, "0.3.0", "0.2.0", &[])).is_ok());
    handle.set_len(0).unwrap();
    assert_eq!(
        parse(&upload_args(&file, "0.3.0", "0.2.0", &[]))
            .err()
            .unwrap(),
        "VALIDATION_ERROR"
    );
    let args = s(&["companion", "firmware-upload", &file.to_string_lossy()]);
    assert_eq!(parse(&args).err().unwrap(), "USAGE_ERROR");
    let mut args = upload_args(&file, "0.3.0", "0.2.0", &[]);
    args.truncate(5);
    assert_eq!(parse(&args).err().unwrap(), "USAGE_ERROR");
}
#[test]
fn version_flags_belong_to_firmware_upload_only() {
    let args = s(&["tasks", "list", "--version", "1.0.0"]);
    assert_eq!(parse(&args).err().unwrap(), "USAGE_ERROR");
    let args = s(&["companion", "other", "x", "--version", "1.0.0"]);
    assert!(parse(&args).is_err());
}
#[test]
fn firmware_upload_sends_one_put_with_hash_and_checkpoints_the_receipt() {
    let directory = Directory::new();
    let file = firmware_file(&directory, b"signed-image-bytes");
    let args = upload_args(&file, "0.3.0", "0.2.0", &["--apply"]);
    let reply = json!({"version":"0.3.0","sha256":hash(b"signed-image-bytes"),"size":18,"min_version":"0.2.0"});
    let (origin, server) = server(vec![reply]);
    tauri::async_runtime::block_on(async {
        let session = session(origin);
        let invocation = parse(&args).unwrap().unwrap();
        assert!(!invocation.preview);
        let first = execute(&session, invocation).await.unwrap();
        assert_eq!(first["results"][0]["result"]["version"], "0.3.0");
        // A rerun reuses the checkpoint instead of uploading again.
        let second = execute(&session, parse(&args).unwrap().unwrap())
            .await
            .unwrap();
        assert_eq!(second["results"][0]["reused"], true);
    });
    let requests = server.join().unwrap();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert!(request.starts_with("PUT /api/v1/companion/firmware/0.3.0?min_version=0.2.0 "));
    let lower = request.to_ascii_lowercase();
    assert!(lower.contains("content-type: application/octet-stream"));
    assert!(lower.contains(&format!(
        "x-content-sha256: {}",
        hash(b"signed-image-bytes")
    )));
    assert!(request.ends_with("\r\n\r\nsigned-image-bytes"));
    let receipt =
        fs::read_to_string(directory.0.join("companion.bin.aelys-operations.json")).unwrap();
    assert!(!receipt.contains("cli-private-access") && !receipt.contains("signed-image-bytes"));
}
#[test]
fn firmware_upload_refuses_a_file_that_changed_after_the_preview() {
    let directory = Directory::new();
    let file = firmware_file(&directory, b"signed-image-bytes");
    let invocation = parse(&upload_args(&file, "0.3.0", "0.2.0", &["--apply"]))
        .unwrap()
        .unwrap();
    fs::write(&file, b"tampered-image-bytes").unwrap();
    let (origin, server) = server(vec![]);
    let error = tauri::async_runtime::block_on(execute(&session(origin), invocation)).unwrap_err();
    assert!(error.contains("INPUT_CHANGED"), "{error}");
    assert!(server.join().unwrap().is_empty());
}
#[test]
fn firmware_route_is_unreachable_through_generic_commands() {
    let route = "/api/v1/companion/firmware/0.3.0";
    for operation in [
        json!({"type":"api","method":"PUT","path":route}),
        json!({"type":"api","method":"PUT","path":format!("{route}?min_version=0.2.0")}),
        json!({"type":"api","method":"PUT","path":route,"upload":{"content_type":"application/octet-stream","data":"AAAA"}}),
        json!({"type":"api","method":"POST","path":"/api/v1/english/speech/transcribe","upload":{"content_type":"audio/wav","data":"AAAA"}}),
        json!({"type":"api_binary","path":route}),
        json!({"type":"companion_firmware_upload","file":"x.bin","version":"1.2","min_version":"0.1.0","size":1,"sha256":hash(b"x")}),
        json!({"type":"companion_firmware_upload","file":"x.bin","version":"1.2.3","min_version":"0.1.0","size":FIRMWARE_MAX + 1,"sha256":hash(b"x")}),
        json!({"type":"companion_firmware_upload","file":"x.bin","version":"1.2.3","min_version":"0.1.0","size":1,"sha256":"ABC"}),
        json!({"type":"companion_firmware_upload","file":"x.bin","version":"1.2.3","min_version":"0.1.0","size":1,"sha256":hash(b"x"),"path":"/api/v1/me"}),
    ] {
        assert!(describe(&operation).is_err(), "{operation}");
    }
    let good = json!({"type":"companion_firmware_upload","file":"x.bin","version":"1.2.3","min_version":"0.1.0","size":1,"sha256":hash(b"x")});
    let (method, path, _) = describe(&good).unwrap();
    assert_eq!(method, Method::PUT);
    assert_eq!(path, "/api/v1/companion/firmware/1.2.3?min_version=0.1.0");
}
#[test]
fn only_the_owner_crash_dump_path_joins_the_binary_allowlist() {
    let binary = |path: &str| describe(&json!({"type":"api_binary","path":path})).is_ok();
    assert!(binary("/api/v1/companion/devices/dev-1/coredumps/dump_2"));
    assert!(binary("/api/v1/integrations/telegram/chats/1234567/avatar"));
    for path in [
        "/api/v1/companion/devices/dev-1/coredumps",
        "/api/v1/companion/devices/dev-1/coredumps/a/b",
        "/api/v1/companion/devices/../coredumps/x",
        "/api/v1/companion/devices/dev-1/coredumps/..",
        "/api/v1/companion/devices/dev-1/firmware",
        "/api/v1/companion/coredumps",
        "/api/v1/companion/devices/dev-1/coredumps/x?token=1",
    ] {
        assert!(!binary(path), "{path}");
    }
}
fn octet_server(body: &'static [u8]) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0; 4096];
        let _ = stream.read(&mut buf);
        let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
    });
    origin
}
#[test]
fn crash_dump_download_accepts_octet_stream_but_telegram_media_stays_strict() {
    let dump = "/api/v1/companion/devices/dev-1/coredumps/dump_2";
    // `api` stays JSON-only; the typed binary operation is what carries dumps.
    assert!(parse(&s(&["api", "GET", dump])).is_err());
    let operation = |path: &str| Invocation {
        operations: vec![json!({"type":"api_binary","path":path})],
        receipt: None,
        digest: String::new(),
        preview: false,
        unlock_keychain: false,
    };
    let result = tauri::async_runtime::block_on(execute(
        &session(octet_server(b"\x7fELF")),
        operation(dump),
    ))
    .unwrap();
    assert_eq!(
        result["results"][0]["result"]["content_type"],
        "application/octet-stream"
    );
    assert_eq!(result["results"][0]["result"]["data"], "f0VMRg==");
    let telegram = "/api/v1/integrations/telegram/chats/1234567/avatar";
    let error = tauri::async_runtime::block_on(execute(
        &session(octet_server(b"\x7fELF")),
        operation(telegram),
    ))
    .unwrap_err();
    assert!(error.contains("415:TELEGRAM_MEDIA_UNSUPPORTED"), "{error}");
}
