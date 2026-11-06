// Synthetic peers only; no personal transcripts, live account or Keychain.
use super::*;

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

// Synthetic loopback peer only: never access a real owner, Keychain or
// transcript. Check both the bounded wire contract and its failure paths.
fn binding_peer(replies: Vec<(&'static str, u16, Value)>) -> (String, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        for (path, status, body) in replies {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "missing identity check");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("fixture accept failed: {e}"),
                }
            };
            // On platforms where accepted sockets inherit nonblocking
            // mode from the listener, wait for the HTTP request instead of
            // treating a not-yet-arrived packet as a fixture failure.
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut wire = Vec::new();
            let mut chunk = [0; 1024];
            while !wire.ends_with(b"\r\n\r\n") {
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0);
                wire.extend_from_slice(&chunk[..count]);
                assert!(wire.len() < 8192);
            }
            let wire = String::from_utf8(wire).unwrap();
            assert!(wire.starts_with(&format!("GET {path} HTTP/1.1\r\n")));
            assert!(wire
                .to_ascii_lowercase()
                .contains("authorization: bearer access-secret\r\n"));
            for forbidden in [
                "refresh-secret",
                "private_transcript",
                "source_ref",
                "origin:",
                "cookie:",
            ] {
                assert!(!wire.to_ascii_lowercase().contains(forbidden));
            }
            let body = body.to_string();
            write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    });
    (origin, server)
}

fn binding_me() -> Value {
    json!({"id":"owner-1","email":"synthetic@example.test","device_id":"device-1"})
}

#[test]
fn reader_binding_requires_live_session_and_expires_without_network() {
    tauri::async_runtime::block_on(async {
        let state = NativeState::default();
        assert_eq!(
            state.session_binding().await.err().as_deref(),
            Some("SIGN_IN_REQUIRED")
        );
        let session = session_from("https://example.test", tokens("refresh-secret")).unwrap();
        *state.0.lock().await = Some(session);
        let binding = state.session_binding().await.unwrap();
        binding.ensure_active().unwrap();
        *state.0.lock().await = None;
        assert_eq!(binding.ensure_active().unwrap_err(), "SIGN_IN_REQUIRED");
        let mut expired = session_from("https://example.test", tokens("refresh-secret")).unwrap();
        Arc::get_mut(&mut expired.binding.0).unwrap().expires_at = Instant::now();
        *state.0.lock().await = Some(expired);
        assert_eq!(
            state.session_binding().await.err().as_deref(),
            Some("SIGN_IN_REQUIRED")
        );
    });
}

#[test]
fn reader_binding_cannot_revive_for_same_identity_or_different_origin_owner_device() {
    tauri::async_runtime::block_on(async {
        for change in ["same", "origin", "owner", "device"] {
            let origin = "https://example.test";
            let state = NativeState(Mutex::new(Some(
                session_from(origin, tokens("refresh-secret")).unwrap(),
            )));
            let old = state.session_binding().await.unwrap();
            let mut replacement = tokens("refresh-secret");
            if change == "owner" {
                replacement.owner_id = "owner-2".into();
            }
            if change == "device" {
                replacement.device_id = "device-2".into();
            }
            let next_origin = if change == "origin" {
                "https://other.test"
            } else {
                origin
            };
            // Even identical access/refresh strings cannot resurrect a grant.
            *state.0.lock().await = Some(session_from(next_origin, replacement).unwrap());
            assert_eq!(old.ensure_active().unwrap_err(), "SIGN_IN_REQUIRED");
            assert_eq!(
                state.validate_session_binding(&old).await.unwrap_err(),
                "SIGN_IN_REQUIRED"
            );
            state
                .session_binding()
                .await
                .unwrap()
                .ensure_active()
                .unwrap();
        }
    });
}

#[test]
fn reader_checks_owner_device_project_and_never_uses_status_as_authentication() {
    for (me, project, expected) in [
        (
            binding_me(),
            Some((200, json!({"id":"project-1","ignored":"private"}))),
            None,
        ),
        (
            binding_me(),
            Some((404, json!({"detail":{"code":"NOT_FOUND"}}))),
            Some("READER_PROJECT_UNAVAILABLE"),
        ),
        (
            json!({"id":"owner-2","email":"synthetic","device_id":"device-1"}),
            None,
            Some("SIGN_IN_REQUIRED"),
        ),
        (
            json!({"id":"owner-1","email":"synthetic","device_id":"device-2"}),
            None,
            Some("SIGN_IN_REQUIRED"),
        ),
        (
            json!({"id":"owner-1","email":"synthetic","device_id":null}),
            None,
            Some("SIGN_IN_REQUIRED"),
        ),
    ] {
        let mut replies = vec![("/api/v1/me", 200, me)];
        if let Some((status, project)) = project {
            replies.push(("/api/v1/projects/project-1", status, project));
        }
        let (origin, server) = binding_peer(replies);
        tauri::async_runtime::block_on(async {
            let state = NativeState(Mutex::new(Some(
                session_from(&origin, tokens("refresh-secret")).unwrap(),
            )));
            let binding = state.session_binding().await.unwrap();
            assert_eq!(
                state
                    .validate_session_project(&binding, "project-1")
                    .await
                    .err()
                    .as_deref(),
                expected
            );
            if expected == Some("SIGN_IN_REQUIRED") {
                assert!(binding.ensure_active().is_err());
            }
        });
        server.join().unwrap();
    }
}

#[test]
fn reader_rejects_revocation_offline_and_bad_responses_without_refresh_or_cached_success() {
    for (status, body, expected) in [
        (
            401,
            json!({"detail":{"code":"DEVICE_REVOKED","token":"never-reflect"}}),
            "SIGN_IN_REQUIRED",
        ),
        (403, json!({"token":"never-reflect"}), "FORBIDDEN"),
        (500, json!({"token":"never-reflect"}), "BACKEND_ERROR"),
        (200, json!({"token":"never-reflect"}), "INVALID_RESPONSE"),
    ] {
        let (origin, server) = binding_peer(vec![
            ("/api/v1/me", 200, binding_me()),
            ("/api/v1/projects/project-1", 200, json!({"id":"project-1"})),
            ("/api/v1/me", status, body),
        ]);
        tauri::async_runtime::block_on(async {
            let state = NativeState(Mutex::new(Some(
                session_from(&origin, tokens("refresh-secret")).unwrap(),
            )));
            let binding = state.session_binding().await.unwrap();
            state
                .validate_session_project(&binding, "project-1")
                .await
                .unwrap();
            assert_eq!(
                state
                    .validate_session_project(&binding, "project-1")
                    .await
                    .unwrap_err(),
                expected
            );
            assert_eq!(binding.ensure_active().is_err(), status == 401);
        });
        server.join().unwrap();
    }
    // The peer closes after a successful check. The next call must fail;
    // no cached authority and no automatic token rotation is allowed.
    let (origin, server) = binding_peer(vec![("/api/v1/me", 200, binding_me())]);
    tauri::async_runtime::block_on(async {
        let state = NativeState(Mutex::new(Some(
            session_from(&origin, tokens("refresh-secret")).unwrap(),
        )));
        let binding = state.session_binding().await.unwrap();
        state.validate_session_binding(&binding).await.unwrap();
        server.join().unwrap();
        assert_eq!(
            state.validate_session_binding(&binding).await.unwrap_err(),
            "NETWORK_ERROR"
        );
    });
}

#[test]
fn reader_rechecks_project_and_revocation_after_successful_identity_response() {
    for (status, project, expected) in [
        (
            401,
            json!({"detail":{"code":"DEVICE_REVOKED"}}),
            "SIGN_IN_REQUIRED",
        ),
        (
            404,
            json!({"detail":{"code":"NOT_FOUND"}}),
            "READER_PROJECT_UNAVAILABLE",
        ),
        (
            200,
            json!({"unexpected":"never-reflect"}),
            "INVALID_RESPONSE",
        ),
        (
            200,
            json!({"id":"another-project","name":"never-reflect"}),
            "INVALID_RESPONSE",
        ),
    ] {
        let (origin, server) = binding_peer(vec![
            ("/api/v1/me", 200, binding_me()),
            ("/api/v1/projects/project-1", 200, json!({"id":"project-1"})),
            ("/api/v1/me", 200, binding_me()),
            ("/api/v1/projects/project-1", status, project),
        ]);
        tauri::async_runtime::block_on(async {
            let state = NativeState(Mutex::new(Some(
                session_from(&origin, tokens("refresh-secret")).unwrap(),
            )));
            let binding = state.session_binding().await.unwrap();
            state
                .validate_session_project(&binding, "project-1")
                .await
                .unwrap();
            assert_eq!(
                state
                    .validate_session_project(&binding, "project-1")
                    .await
                    .unwrap_err(),
                expected
            );
            assert_eq!(binding.ensure_active().is_err(), status == 401);
        });
        server.join().unwrap();
    }
}

#[test]
fn reader_late_http_response_cannot_cross_logout_or_clear_replacement_session() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    for (replace, status) in [(false, 200), (true, 200), (true, 401)] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            assert!(socket.read(&mut [0; 4096]).unwrap() > 0);
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            let body = binding_me().to_string();
            write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        tauri::async_runtime::block_on(async {
            let state = Arc::new(NativeState(Mutex::new(Some(
                session_from(&origin, tokens("refresh-secret")).unwrap(),
            ))));
            let binding = state.session_binding().await.unwrap();
            let task_state = state.clone();
            let pending =
                tokio::spawn(async move { task_state.validate_session_binding(&binding).await });
            tokio::time::timeout(Duration::from_secs(3), started_rx)
                .await
                .unwrap()
                .unwrap();
            let mut guard = tokio::time::timeout(Duration::from_secs(1), state.0.lock())
                .await
                .unwrap();
            *guard = if replace {
                Some(session_from(&origin, tokens("refresh-secret")).unwrap())
            } else {
                None
            };
            drop(guard);
            release_tx.send(()).unwrap();
            assert_eq!(pending.await.unwrap().unwrap_err(), "SIGN_IN_REQUIRED");
            assert_eq!(state.session_binding().await.is_ok(), replace);
        });
        server.join().unwrap();
    }
}

#[test]
fn logout_invalidates_reader_before_keychain_read_delete_or_network_failure() {
    struct LogoutStore {
        fail_read: bool,
        fail_delete: bool,
        binding: NativeSessionBinding,
    }
    impl Store for LogoutStore {
        async fn read(&self, origin: &str) -> Result<Option<Record>, String> {
            assert_eq!(
                self.binding.ensure_active().unwrap_err(),
                "SIGN_IN_REQUIRED"
            );
            if self.fail_read {
                return Err("KEYCHAIN_ACCESS_REQUIRED".into());
            }
            Ok(Some(Record {
                origin: origin.into(),
                owner_id: "owner-1".into(),
                device_id: "device-1".into(),
                refresh_token: "refresh-secret".into(),
                device_key: None,
            }))
        }
        async fn write(&self, _: &str, _: &Record) -> Result<(), String> {
            panic!("logout cannot write")
        }
        async fn delete(&self, _: &str) -> Result<(), String> {
            assert_eq!(
                self.binding.ensure_active().unwrap_err(),
                "SIGN_IN_REQUIRED"
            );
            if self.fail_delete {
                Err("STORAGE_ERROR".into())
            } else {
                Ok(())
            }
        }
    }
    // Reserve then release an unused loopback port for the offline case.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    tauri::async_runtime::block_on(async {
        for (fail_read, fail_delete, expected) in [
            (true, false, "KEYCHAIN_ACCESS_REQUIRED"),
            (false, true, "STORAGE_ERROR"),
            (false, false, "LOCAL_LOGOUT_ONLY"),
        ] {
            let state = NativeState(Mutex::new(Some(
                session_from(&origin, tokens("refresh-secret")).unwrap(),
            )));
            let binding = state.session_binding().await.unwrap();
            let result = logout_session(
                &LogoutStore {
                    fail_read,
                    fail_delete,
                    binding: binding.clone(),
                },
                &state,
                &NativeAIStreams::default(),
                &origin,
            )
            .await;
            assert_eq!(result.err().as_deref(), Some(expected));
            assert_eq!(binding.ensure_active().unwrap_err(), "SIGN_IN_REQUIRED");
            assert!(state.0.lock().await.is_none());
        }
    });
}

#[test]
fn reader_rejects_invalid_project_paths_without_network() {
    tauri::async_runtime::block_on(async {
        let state = NativeState(Mutex::new(Some(
            session_from("https://example.test", tokens("refresh-secret")).unwrap(),
        )));
        let binding = state.session_binding().await.unwrap();
        for project in [
            "",
            "../me",
            "p?token=private",
            "p#fragment",
            "p/other",
            "%2e%2e",
        ] {
            assert_eq!(
                state
                    .validate_session_project(&binding, project)
                    .await
                    .unwrap_err(),
                "VALIDATION_ERROR"
            );
        }
        assert!(state
            .validate_session_project(&binding, &"p".repeat(101))
            .await
            .is_err());
        binding.ensure_active().unwrap();
    });
}

#[test]
fn reader_legacy_lifetime_is_bounded_and_overflow_is_rejected() {
    for expires_in in [0, u64::MAX] {
        let mut token = tokens("refresh-secret");
        token.expires_in = expires_in;
        assert!(
            matches!(session_from("https://example.test", token), Err(e) if e == "INVALID_RESPONSE")
        );
    }
}

fn device_access(claims: Value) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    // A synthetic JWT envelope, not a signed token. Only the fixture server can
    // authenticate it; local claims never supply owner/device identity.
    format!(
        "header.{}.signature",
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

fn future_expiry() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60
}

#[test]
fn reader_device_deadline_fails_closed_for_unknown_expired_or_malformed_lifetimes() {
    for access in [
        "opaque-access".into(),
        device_access(json!({})),
        device_access(json!({"exp":0})),
        device_access(json!({"exp":-1})),
        device_access(json!({"exp":"9999999999"})),
        "header.invalid!.signature".into(),
        format!("{}.extra", device_access(json!({"exp":future_expiry()}))),
        device_access(json!({"exp":future_expiry(),"padding":"x".repeat(16*1024)})),
    ] {
        assert!(device_deadline(&access) <= Instant::now());
    }
    let before = Instant::now();
    let deadline = device_deadline(&device_access(json!({"exp":future_expiry()})));
    assert!(deadline > before);
    assert!(deadline <= Instant::now() + Duration::from_secs(60));
}

#[test]
fn reader_device_identity_comes_from_me_and_never_from_jwt_claims() {
    use crate::transport::passwordless_tests::server;
    let access = device_access(json!({
        "exp":future_expiry(), "sub":"forged-owner", "device_id":"forged-device"
    }));
    let (origin, peer) = server(vec![binding_me(), binding_me(), json!({"id":"project-1"})]);
    tauri::async_runtime::block_on(async {
        let session = device_session(
            &client().unwrap(),
            &origin,
            DeviceTokens {
                access_token: access.clone(),
                refresh_token: "refresh-secret".into(),
                device_id: "device-1".into(),
                token_type: "bearer".into(),
            },
            crate::device_key::DeviceKey::generate().unwrap(),
        )
        .await
        .unwrap();
        assert!(session.record.device_key.is_some());
        let state = NativeState(Mutex::new(Some(session)));
        let binding = state.session_binding().await.unwrap();
        assert_eq!(binding.0.owner_id, "owner-1");
        assert_eq!(binding.0.device_id, "device-1");
        state
            .validate_session_project(&binding, "project-1")
            .await
            .unwrap();
        *state.0.lock().await = None;
        assert!(binding.ensure_active().is_err());
    });
    let requests = peer.join().unwrap();
    assert_eq!(requests.len(), 3);
    for (request, path) in
        requests
            .iter()
            .zip(["/api/v1/me", "/api/v1/me", "/api/v1/projects/project-1"])
    {
        assert!(request.starts_with(&format!("GET {path} HTTP/1.1\r\n")));
        assert!(!request.contains("refresh-secret"));
        assert!(!request.contains("pkcs8"));
    }
}

#[test]
fn reader_unknown_device_expiry_does_not_change_existing_login_contract() {
    use crate::transport::passwordless_tests::server;
    let (origin, peer) = server(vec![binding_me()]);
    tauri::async_runtime::block_on(async {
        let session = device_session(
            &client().unwrap(),
            &origin,
            DeviceTokens {
                access_token: "opaque-access".into(),
                refresh_token: "refresh-secret".into(),
                device_id: "device-1".into(),
                token_type: "bearer".into(),
            },
            crate::device_key::DeviceKey::generate().unwrap(),
        )
        .await
        .unwrap();
        assert!(status(Some(&session), &origin, Some(true), None).signed_in);
        let state = NativeState(Mutex::new(Some(session)));
        assert!(state.session_binding().await.is_err());
    });
    peer.join().unwrap();
}

#[test]
fn reader_device_resume_creates_new_authority_without_reviving_old_grants() {
    use crate::transport::passwordless_tests::server;
    let (origin, peer) = server(vec![
        json!({"challenge_id":"challenge-1","nonce":"synthetic-nonce"}),
        json!({"access_token":device_access(json!({"exp":future_expiry()})),"refresh_token":"new-refresh","device_id":"device-1","token_type":"bearer"}),
        binding_me(),
    ]);
    tauri::async_runtime::block_on(async {
        let mut session = session_from(&origin, tokens("old-refresh")).unwrap();
        session.record.device_key = Some(crate::device_key::DeviceKey::generate().unwrap());
        let old_record = identity_record(&session.record);
        let state = NativeState(Mutex::new(Some(session)));
        let old = state.session_binding().await.unwrap();
        let resumed = resume_device(&client().unwrap(), &origin, &old_record)
            .await
            .unwrap();
        *state.0.lock().await = Some(resumed);
        assert!(old.ensure_active().is_err());
        state
            .session_binding()
            .await
            .unwrap()
            .ensure_active()
            .unwrap();
    });
    let requests = peer.join().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(!requests
        .iter()
        .any(|request| request.contains("old-refresh")));
}

#[test]
fn reader_detached_cli_state_has_independent_authority_with_the_same_deadline() {
    let owner = session_from("https://example.test", tokens("refresh-secret")).unwrap();
    let detached = owner.binding.detached();
    assert!(!Arc::ptr_eq(&detached.0, &owner.binding.0));
    assert_eq!(detached.0.expires_at, owner.binding.0.expires_at);
    let temporary = Session {
        binding: detached.clone(),
        origin: owner.origin.clone(),
        access: owner.access.clone(),
        record: identity_record(&owner.record),
    };
    drop(temporary);
    assert!(detached.ensure_active().is_err());
    owner.binding.ensure_active().unwrap();
    owner.binding.0.active.store(false, Ordering::SeqCst);
    assert!(owner.binding.detached().ensure_active().is_err());
}

#[test]
fn reader_identity_get_rejects_redirects_oversized_and_malformed_responses() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    for (response, expected) in [
        (
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/private\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            "BACKEND_ERROR",
        ),
        (
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_JSON + 1),
            "RESPONSE_TOO_LARGE",
        ),
        (
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nprivate".into(),
            "INVALID_RESPONSE",
        ),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let peer = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            assert!(socket.read(&mut [0; 4096]).unwrap() > 0);
            socket.write_all(response.as_bytes()).unwrap();
        });
        tauri::async_runtime::block_on(async {
            let state = NativeState(Mutex::new(Some(session_from(&origin, tokens("refresh-secret")).unwrap())));
            let binding = state.session_binding().await.unwrap();
            assert_eq!(state.validate_session_binding(&binding).await.unwrap_err(), expected);
        });
        peer.join().unwrap();
    }
}
