use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{
    cell::RefCell,
    io::{Read, Write},
    net::TcpListener,
};

struct MemoryStore(RefCell<Option<String>>);
impl Store for MemoryStore {
    async fn read(&self, _: &str) -> Result<Option<Record>, String> {
        self.0
            .borrow()
            .as_deref()
            .map(|v| serde_json::from_str(v).map_err(|_| err("STORAGE_ERROR")))
            .transpose()
    }
    async fn write(&self, _: &str, record: &Record) -> Result<(), String> {
        *self.0.borrow_mut() = Some(serde_json::to_string(record).unwrap());
        Ok(())
    }
    async fn delete(&self, _: &str) -> Result<(), String> {
        *self.0.borrow_mut() = None;
        Ok(())
    }
}
pub(super) fn server(responses: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut data = Vec::new();
            loop {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buf[..n]);
                if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&data[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|s| s.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if data.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(data).unwrap());
            let body = response.to_string();
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        }
        requests
    });
    (origin, handle)
}
fn tokens() -> Value {
    json!({"access_token":"access-secret","refresh_token":"refresh-secret","device_id":"device-1","token_type":"bearer"})
}
fn me() -> Value {
    json!({"id":"owner-1","device_id":"device-1"})
}

#[test]
fn enrollment_uses_existing_protocol_and_never_exports_credentials_in_status() {
    let (origin, handle) = server(vec![tokens(), me()]);
    tauri::async_runtime::block_on(async {
        let store = MemoryStore(RefCell::new(None));
        let session = establish_device(
            &client().unwrap(),
            &store,
            &origin,
            "one-time-private-code",
            "Test Mac",
        )
        .await
        .unwrap();
        assert!(store
            .read(&origin)
            .await
            .unwrap()
            .unwrap()
            .device_key
            .is_some());
        let safe = serde_json::to_string(&status(Some(&session), &origin, Some(true), Some(true)))
            .unwrap();
        for private in [
            "pkcs8",
            "access-secret",
            "refresh-secret",
            "one-time-private-code",
        ] {
            assert!(!safe.contains(private));
        }
    });
    let requests = handle.join().unwrap();
    assert!(requests[0].starts_with("POST /api/v1/auth/setup/claim "));
    let body: Value = serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body["token"], "one-time-private-code");
    assert_eq!(
        URL_SAFE_NO_PAD
            .decode(body["public_key"].as_str().unwrap())
            .unwrap()
            .len(),
        65
    );
    assert!(requests[1].starts_with("GET /api/v1/me "));
    assert!(!requests[0].contains("password"));
}
#[test]
fn restart_signs_the_server_nonce_and_retains_identity_through_offline_failures() {
    let (origin, handle) = server(vec![
        json!({"challenge_id":"challenge-1","nonce":"random-nonce"}),
        tokens(),
        me(),
    ]);
    let key = crate::device_key::DeviceKey::generate().unwrap();
    let public = URL_SAFE_NO_PAD.decode(key.public_key().unwrap()).unwrap();
    tauri::async_runtime::block_on(async {
        let record = Record {
            origin: origin.clone(),
            owner_id: "owner-1".into(),
            device_id: "device-1".into(),
            refresh_token: "expired-rotating-secret".into(),
            device_key: Some(key),
        };
        let store = MemoryStore(RefCell::new(None));
        store.write(&origin, &record).await.unwrap();
        let old = take_record(&store, &origin).await.unwrap();
        let retained = store.read(&origin).await.unwrap().unwrap();
        assert!(retained.device_key.is_some());
        assert!(retained.refresh_token.is_empty());
        let session = resume_device(&client().unwrap(), &origin, &old)
            .await
            .unwrap();
        assert_eq!(session.record.owner_id, "owner-1");
        assert_eq!(session.record.device_id, "device-1");
        assert!(session.record.device_key.is_some());
    });
    let requests = handle.join().unwrap();
    assert!(requests[0].starts_with("POST /api/v1/auth/device/challenge "));
    assert!(requests[1].starts_with("POST /api/v1/auth/device/login "));
    let body: Value = serde_json::from_str(requests[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
    let signature = URL_SAFE_NO_PAD
        .decode(body["signature"].as_str().unwrap())
        .unwrap();
    ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, public)
        .verify(b"aelys-device-login-v1\ndevice-1\nrandom-nonce", &signature)
        .unwrap();
    assert!(!requests
        .iter()
        .any(|r| r.contains("expired-rotating-secret")));
}
#[test]
fn mismatched_authenticated_device_is_rejected() {
    let (origin, handle) = server(vec![
        tokens(),
        json!({"id":"owner-1","device_id":"another-device"}),
    ]);
    tauri::async_runtime::block_on(async {
        let store = MemoryStore(RefCell::new(None));
        let result = establish_device(
            &client().unwrap(),
            &store,
            &origin,
            "one-time-private-code",
            "Test Mac",
        )
        .await;
        assert!(matches!(result,Err(e) if e=="INVALID_RESPONSE"));
        assert!(store.read(&origin).await.unwrap().is_none());
    });
    handle.join().unwrap();
}
