use aelys_runtime::channel::BackendChannelClient;
use aelys_runtime::protocol::DeviceIdentity;
use aelys_runtime::sandbox::{bundled_probe_path, run_probe, SandboxProfile};
use ed25519_dalek::SigningKey;
use std::env;
use std::path::PathBuf;
use uuid::Uuid;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let endpoint = env::var("AELYS_CHANNEL_URL").expect("AELYS_CHANNEL_URL");
    let token = env::var("AELYS_ACCESS_TOKEN").expect("AELYS_ACCESS_TOKEN");
    let device_id =
        Uuid::parse_str(&env::var("AELYS_DEVICE_ID").expect("AELYS_DEVICE_ID")).unwrap();
    let grant_id = Uuid::parse_str(&env::var("AELYS_GRANT_ID").expect("AELYS_GRANT_ID")).unwrap();
    let project_id =
        Uuid::parse_str(&env::var("AELYS_PROJECT_ID").expect("AELYS_PROJECT_ID")).unwrap();
    let nonce = env::var("AELYS_GRANT_NONCE").expect("AELYS_GRANT_NONCE");
    let private =
        hex::decode(env::var("AELYS_PRIVATE_KEY_HEX").expect("AELYS_PRIVATE_KEY_HEX")).unwrap();
    let key = SigningKey::from_bytes(private.as_slice().try_into().unwrap());
    let identity = DeviceIdentity::from_signing_key(device_id, &key);
    let root = PathBuf::from(env::var("AELYS_PROJECT_ROOT").expect("AELYS_PROJECT_ROOT"));
    let outside =
        PathBuf::from(env::var("AELYS_OUTSIDE_PROBE_PATH").expect("AELYS_OUTSIDE_PROBE_PATH"));
    let credential = PathBuf::from(
        env::var("AELYS_CREDENTIAL_PROBE_PATH").expect("AELYS_CREDENTIAL_PROBE_PATH"),
    );
    let symlink =
        PathBuf::from(env::var("AELYS_SYMLINK_PROBE_PATH").expect("AELYS_SYMLINK_PROBE_PATH"));
    let network = env::var("AELYS_NETWORK_PROBE_ADDRESS").expect("AELYS_NETWORK_PROBE_ADDRESS");
    let probe = bundled_probe_path().expect("bundled isolation probe");
    let network_allowed = env::var("AELYS_NETWORK_ALLOWED")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let evidence = run_probe(
        &SandboxProfile::new_with_network(&root, network_allowed).unwrap(),
        &probe,
        &[
            root.join(".aelys-probe-write").into(),
            outside.into(),
            credential.into(),
            symlink.into(),
            network.into(),
            nonce.clone().into(),
        ],
    )
    .expect("isolation probe");
    assert_eq!(evidence.network_blocked, !network_allowed);
    assert!(
        evidence.project_write
            && evidence.outside_read_blocked
            && evidence.credential_read_blocked
            && evidence.symlink_read_blocked
            && evidence.subprocess_escape_blocked
    );
    let envelope = BackendChannelClient::isolation_attestation_message(
        &identity, &key, grant_id, project_id, nonce, evidence,
    )
    .unwrap();
    BackendChannelClient::new(endpoint, token)
        .send_isolation_attestation(&envelope)
        .await
        .unwrap();
    println!("isolation attestation acknowledged");
}
