use aelys_runtime::adapter::{
    AdapterCapabilities, AdapterKind, AgentAdapter, CommandProbe, ProcessCommandProbe,
    VendorAdapter,
};
use aelys_runtime::credentials::{
    CredentialLease, CredentialReplayGuard, KeychainReader, ProviderCredential,
};
use aelys_runtime::db::DurableRunStore;
use aelys_runtime::discovery::{discover_session_files, DiscoveryCursor};
use aelys_runtime::error::RuntimeResult;
use aelys_runtime::isolation::{
    IsolationGate, IsolationStatus, IsolationValidationReport, MacOsIsolationValidator,
};
use aelys_runtime::metadata::{CloudSessionMetadata, LocalSessionMetadata};
use aelys_runtime::paths::AuthorizedRoot;
use aelys_runtime::protocol::{
    ChannelAvailability, DeviceIdentity, OutboundBody, OutboundRequest, ReplayGuard,
    RuntimeChannel, SignedOutboundRequest,
};
use aelys_runtime::runner::{CredentialRequest, LocalRunCoordinator};
use aelys_runtime::runs::RunState;
use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::{Duration as StdDuration, Instant};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use uuid::Uuid;

struct FakeProbe;
impl CommandProbe for FakeProbe {
    fn probe_version(&self, _: &str) -> std::io::Result<(bool, String)> {
        Ok((true, "1.0".into()))
    }
}

struct RunnableAdapter;
struct RunnableAdapterWithExecutable {
    executable: String,
}
impl AgentAdapter for RunnableAdapter {
    fn kind(&self) -> AdapterKind {
        AdapterKind::ClaudeCode
    }

    fn probe_support(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            adapter: self.kind(),
            executable: "/bin/echo".into(),
            installed: true,
            version: Some("test-only".into()),
            can_discover_sessions: false,
            can_resume_sessions: false,
            can_run: true,
            reason: None,
        }
    }
}

impl AgentAdapter for RunnableAdapterWithExecutable {
    fn kind(&self) -> AdapterKind {
        AdapterKind::ClaudeCode
    }
    fn probe_support(&self) -> AdapterCapabilities {
        AdapterCapabilities {
            adapter: self.kind(),
            executable: self.executable.clone(),
            installed: true,
            version: Some("test-only".into()),
            can_discover_sessions: false,
            can_resume_sessions: false,
            can_run: true,
            reason: None,
        }
    }
}

struct FakeCredentialReader {
    calls: Mutex<Vec<(String, String)>>,
}

impl KeychainReader for FakeCredentialReader {
    fn read_password(&self, service: &str, account: &str) -> RuntimeResult<String> {
        self.calls
            .lock()
            .unwrap()
            .push((service.to_owned(), account.to_owned()));
        Ok("test-only-openai-credential".into())
    }
}

fn validated_isolation_gate() -> IsolationGate {
    IsolationGate::from_report(IsolationValidationReport {
        os_level_enforced: true,
        escape_tests_passed: true,
        credential_paths_unavailable: true,
        network_policy_enforced: true,
    })
}

fn coordinator() -> LocalRunCoordinator<RunnableAdapter> {
    LocalRunCoordinator {
        manager: Default::default(),
        adapter: RunnableAdapter,
        isolation: validated_isolation_gate(),
    }
}

fn coordinator_with_executable(
    executable: String,
) -> LocalRunCoordinator<RunnableAdapterWithExecutable> {
    LocalRunCoordinator {
        manager: Default::default(),
        adapter: RunnableAdapterWithExecutable { executable },
        isolation: validated_isolation_gate(),
    }
}

#[test]
fn outbound_request_is_bound_to_device_key_and_time() {
    let (identity, key) = DeviceIdentity::generate();
    let request = OutboundRequest {
        request_id: Uuid::new_v4(),
        device_id: identity.device_id,
        issued_at: Utc::now(),
        expires_at: Utc::now() + Duration::minutes(1),
        nonce: [7; 32],
        body: OutboundBody::Heartbeat {
            lease_id: Uuid::new_v4(),
        },
    };
    let signed = SignedOutboundRequest::sign(request, &key).unwrap();
    signed.verify(Utc::now(), &identity).unwrap();
    let replay = ReplayGuard::default();
    replay.accept_once(&signed, Utc::now(), &identity).unwrap();
    assert!(replay.accept_once(&signed, Utc::now(), &identity).is_err());
    let (other, _) = DeviceIdentity::generate();
    assert!(signed.verify(Utc::now(), &other).is_err());
}

#[test]
fn metadata_projection_has_no_local_content_fields() {
    let local = LocalSessionMetadata {
        session_index_id: Uuid::new_v4(),
        native_session_id: "native".into(),
        local_session_ref: "/private/session.jsonl".into(),
        project_id: Uuid::new_v4(),
        adapter: "codex_cli".into(),
        source_revision: 1,
        started_at: None,
        last_activity_at: None,
        state: "active".into(),
        message_count: 4,
    };
    let cloud: CloudSessionMetadata = local.cloud_projection(Uuid::new_v4());
    let object = cloud.to_cloud_json().unwrap();
    let keys: Vec<&str> = object
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert!(!keys.iter().any(|key| [
        "content",
        "prompt",
        "summary",
        "embedding",
        "local_session_ref",
        "native_session_id",
        "path"
    ]
    .contains(key)));
}

#[test]
fn offline_channel_has_explicit_error() {
    let channel = RuntimeChannel::offline();
    assert_eq!(channel.availability(), ChannelAvailability::Offline);
    assert!(channel.require_online().is_err());
}

#[test]
fn vendor_probe_is_conservative() {
    let adapter = VendorAdapter::new(AdapterKind::ClaudeCode, "claude", FakeProbe);
    let capabilities = adapter.probe_support();
    assert_eq!(capabilities.version.as_deref(), Some("1.0"));
    assert!(!capabilities.can_run);
    assert!(adapter.start("task").is_err());
}

#[test]
fn persisted_runs_reconcile_nonterminal_work_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtime.db");
    let persistence = Arc::new(DurableRunStore::open(&path).unwrap());
    let manager = aelys_runtime::runs::RunManager::with_persistence(persistence.clone()).unwrap();
    let project = Uuid::new_v4();
    manager
        .submit("durable", project, AdapterKind::CodexCli, "task")
        .unwrap();
    manager
        .claim("durable", Utc::now(), Duration::minutes(1))
        .unwrap();
    manager.start("durable").unwrap();
    drop(manager);

    let restored = aelys_runtime::runs::RunManager::with_persistence(persistence).unwrap();
    let record = restored.get("durable").unwrap();
    assert_eq!(record.state, RunState::Failed);
    assert!(record.lease_id.is_none());
    assert!(record.lease_until.is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_channel_recovers_on_a_fresh_connection() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}/channel", listener.local_addr().unwrap());
    let connections = Arc::new(AtomicUsize::new(0));
    let server_connections = Arc::clone(&connections);

    let server = tokio::spawn(async move {
        for connection_number in 1..=2 {
            let (stream, _) = listener.accept().await.unwrap();
            server_connections.fetch_add(1, Ordering::SeqCst);
            let mut socket = accept_async(stream).await.unwrap();
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.into()))
                .await
                .unwrap();

            assert!(matches!(
                socket.next().await,
                Some(Ok(Message::Text(message))) if message.contains("heartbeat")
            ));
            if connection_number == 2 {
                socket
                    .send(Message::Text(r#"{"type":"heartbeat_ack"}"#.into()))
                    .await
                    .unwrap();
            }
            // The first connection is deliberately dropped after the request
            // reaches the server. The next client operation must dial again.
        }
    });

    let client = aelys_runtime::channel::BackendChannelClient::new(endpoint, "test-device-token");
    let first = client.heartbeat().await;
    assert!(matches!(
        first,
        Err(aelys_runtime::RuntimeError::Channel(_))
    ));
    client.heartbeat().await.unwrap();

    server.await.unwrap();
    assert_eq!(connections.load(Ordering::SeqCst), 2);
}

#[test]
fn isolation_validator_never_claims_success_without_spike() {
    assert!(matches!(
        MacOsIsolationValidator::validate(),
        IsolationStatus::Unavailable(_)
    ));
    assert!(IsolationGate::unavailable().authorize_run().is_err());
}

#[test]
fn discovery_is_incremental_and_root_scoped() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("session.jsonl"), "event").unwrap();
    std::fs::write(root.path().join("ignored.txt"), "event").unwrap();
    let authorized = AuthorizedRoot::new(root.path()).unwrap();
    let project = Uuid::new_v4();
    let first = discover_session_files(
        &[(authorized.clone(), project, AdapterKind::CodexCli)],
        DiscoveryCursor::default(),
        &["jsonl"],
        10,
        1024,
    )
    .unwrap();
    assert_eq!(first.len(), 1);
    let second = discover_session_files(
        &[(authorized, project, AdapterKind::CodexCli)],
        DiscoveryCursor {
            modified_after_unix_ms: i128::MAX,
        },
        &["jsonl"],
        10,
        1024,
    )
    .unwrap();
    assert!(second.is_empty());
}

#[test]
fn local_run_coordinator_completes_claimed_run_lifecycle_before_cancellation() {
    let coordinator = coordinator();
    let project = Uuid::new_v4();
    let submitted = coordinator
        .submit("lifecycle", project, "test task")
        .unwrap();
    assert_eq!(submitted.state, RunState::Queued);

    let claimed = coordinator
        .claim("lifecycle", Utc::now(), Duration::minutes(1))
        .unwrap();
    assert_eq!(claimed.state, RunState::Starting);
    assert!(claimed.lease_id.is_some());
    assert!(claimed.lease_until.is_some());

    let running = coordinator.start("lifecycle").unwrap();
    assert_eq!(running.state, RunState::Running);

    let cancellation_requested = coordinator.cancel("lifecycle").unwrap();
    assert_eq!(cancellation_requested.state, RunState::Running);
    assert!(cancellation_requested.cancellation_requested);

    let cancelled = coordinator.manager.confirm_cancelled("lifecycle").unwrap();
    assert_eq!(cancelled.state, RunState::Cancelled);
}

#[test]
fn local_run_coordinator_claim_and_heartbeat_enforce_lease_window() {
    let coordinator = coordinator();
    coordinator
        .submit("lease", Uuid::new_v4(), "test task")
        .unwrap();
    let now = Utc::now();
    let claimed = coordinator
        .claim("lease", now, Duration::seconds(30))
        .unwrap();
    let original_lease_id = claimed.lease_id;
    let original_until = claimed.lease_until.unwrap();

    assert!(coordinator
        .claim("lease", now + Duration::seconds(1), Duration::seconds(30))
        .is_err());

    let renewed = coordinator
        .manager
        .heartbeat("lease", now + Duration::seconds(10), Duration::seconds(30))
        .unwrap();
    assert_eq!(renewed.lease_id, original_lease_id);
    assert!(renewed.lease_until.unwrap() > original_until);

    let expired_at = renewed.lease_until.unwrap() + Duration::seconds(1);
    assert!(coordinator
        .manager
        .heartbeat("lease", expired_at, Duration::seconds(30))
        .is_err());
}

#[cfg(target_os = "macos")]
fn write_process_tree_script(root: &Path) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::PermissionsExt;

    let script = root.join("process-tree.sh");
    let child_pid = root.join("child.pid");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n(while :; do /bin/sleep 1; done) &\nprintf '%s' $! > '{}'\nwhile :; do /bin/sleep 1; done\n",
            child_pid.display()
        ),
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).unwrap();
    (script, child_pid)
}

#[cfg(target_os = "macos")]
fn wait_for_child_pid(path: &Path) -> u32 {
    let deadline = Instant::now() + StdDuration::from_secs(2);
    loop {
        if let Ok(value) = std::fs::read_to_string(path) {
            if let Ok(pid) = value.trim().parse() {
                return pid;
            }
        }
        assert!(
            Instant::now() < deadline,
            "process-tree helper did not publish child pid"
        );
        std::thread::sleep(StdDuration::from_millis(10));
    }
}

#[cfg(target_os = "macos")]
fn process_is_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(target_os = "macos")]
fn assert_process_tree_exited(pid: u32) {
    let deadline = Instant::now() + StdDuration::from_secs(2);
    while process_is_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(StdDuration::from_millis(20));
    }
    assert!(
        !process_is_alive(pid),
        "descendant process {pid} survived cleanup"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn cancellation_kills_the_managed_process_tree() {
    use aelys_runtime::process::{CliInvocation, ManagedCliProcess};
    use aelys_runtime::sandbox::SandboxProfile;

    let root = tempfile::tempdir().unwrap();
    let profile = SandboxProfile::new(root.path()).unwrap();
    let cwd = profile.root.clone();
    let (script, child_pid_path) = write_process_tree_script(root.path());
    let mut process = ManagedCliProcess::spawn(
        profile,
        &cwd,
        CliInvocation {
            executable: script,
            args: Vec::new(),
        },
    )
    .unwrap();
    let child_pid = wait_for_child_pid(&child_pid_path);

    process.cancel().unwrap();
    let deadline = Instant::now() + StdDuration::from_secs(2);
    while process.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(StdDuration::from_millis(20));
    }
    assert!(process.try_wait().unwrap().is_some());
    assert_process_tree_exited(child_pid);
}

#[cfg(target_os = "macos")]
#[test]
fn timeout_kills_the_managed_process_tree() {
    use aelys_runtime::process::{CliInvocation, ManagedCliProcess};
    use aelys_runtime::sandbox::SandboxProfile;

    let root = tempfile::tempdir().unwrap();
    let profile = SandboxProfile::new(root.path()).unwrap();
    let cwd = profile.root.clone();
    let (script, child_pid_path) = write_process_tree_script(root.path());
    let process = ManagedCliProcess::spawn(
        profile,
        &cwd,
        CliInvocation {
            executable: script,
            args: Vec::new(),
        },
    )
    .unwrap();
    let child_pid = wait_for_child_pid(&child_pid_path);

    assert!(matches!(
        process.wait_timeout(StdDuration::from_millis(100)),
        Err(aelys_runtime::RuntimeError::ProcessTimeout)
    ));
    assert_process_tree_exited(child_pid);
}

#[test]
fn installed_cli_version_and_help_probe_without_provider_auth_remains_fail_closed() {
    let (adapter_kind, executable) = [
        (AdapterKind::CodexCli, "codex"),
        (AdapterKind::ClaudeCode, "claude"),
    ]
    .into_iter()
    .find_map(|(kind, name)| {
        std::env::split_paths(&std::env::var_os("PATH")?)
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
            .map(|path| (kind, path))
    })
    .expect("an installed Claude Code or Codex CLI is required for this compatibility probe");
    let isolated_home = tempfile::tempdir().unwrap();
    let isolated_config = tempfile::tempdir().unwrap();

    let version = ProcessCommandProbe
        .probe_version(executable.to_str().unwrap())
        .unwrap();
    assert!(version.0, "installed CLI --version failed: {}", version.1);
    assert!(!version.1.trim().is_empty());

    let help = std::process::Command::new(&executable)
        .arg("--help")
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("HOME", isolated_home.path())
        .env("XDG_CONFIG_HOME", isolated_config.path())
        .env("CODEX_HOME", isolated_config.path())
        .env("CLAUDE_CONFIG_DIR", isolated_config.path())
        .output()
        .unwrap();
    assert!(
        help.status.success(),
        "installed CLI --help failed: {}",
        String::from_utf8_lossy(&help.stderr)
    );
    assert!(!help.stdout.is_empty() || !help.stderr.is_empty());

    let capabilities = VendorAdapter::new(
        adapter_kind,
        executable.to_string_lossy().into_owned(),
        ProcessCommandProbe,
    )
    .probe_support();
    assert!(capabilities.installed);
    assert_eq!(capabilities.version.as_deref(), Some(version.1.as_str()));
    assert!(!capabilities.can_discover_sessions);
    assert!(!capabilities.can_resume_sessions);
    assert!(!capabilities.can_run);
    assert!(capabilities.reason.is_some());
}

#[cfg(target_os = "macos")]
#[test]
fn local_run_coordinator_injects_only_requested_provider_environment() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("credential-check.sh");
    std::fs::write(
        &script,
        "#!/bin/sh\nif [ \"$OPENAI_API_KEY\" = \"test-only-openai-credential\" ]; then\n  printf '%s' \"$OPENAI_API_KEY\" > credential-observed\n  exit 0\nfi\nexit 1\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).unwrap();

    let profile = aelys_runtime::sandbox::SandboxProfile::new(root.path()).unwrap();
    let coordinator = coordinator_with_executable(script.to_string_lossy().into_owned());
    let project_id = Uuid::new_v4();
    let submitted = coordinator
        .submit("credential", project_id, "test task")
        .unwrap();
    coordinator
        .claim("credential", Utc::now(), Duration::minutes(1))
        .unwrap();

    let reader = FakeCredentialReader {
        calls: Mutex::new(Vec::new()),
    };
    let backend_key = SigningKey::from_bytes(&[8; 32]);
    let device_id = Uuid::new_v4();
    let grant_id = Uuid::new_v4();
    let now = Utc::now();
    let credential_lease = CredentialLease::issue(
        aelys_runtime::credentials::CredentialLeaseSpec {
            run_id: submitted.run_id,
            device_id,
            project_id,
            grant_id,
            provider: ProviderCredential::OpenAiApiKey,
            issued_at: now,
            expires_at: now + Duration::minutes(1),
            nonce: [4; 32],
        },
        &backend_key,
    )
    .unwrap();
    let replay_guard = CredentialReplayGuard::default();
    let result = coordinator
        .execute_once_with_credential(
            "credential",
            profile.clone(),
            &profile.root,
            script,
            std::time::Duration::from_secs(2),
            CredentialRequest {
                reader: &reader,
                lease: &credential_lease,
                trusted_backend_key: &backend_key.verifying_key(),
                replay_guard: &replay_guard,
                device_id,
                grant_id,
            },
        )
        .unwrap();

    assert_eq!(result.state, RunState::Completed);
    assert_eq!(
        std::fs::read_to_string(profile.root.join("credential-observed")).unwrap(),
        "test-only-openai-credential"
    );
    assert_eq!(
        reader.calls.lock().unwrap().as_slice(),
        [("com.aelys.openai".into(), "default".into())]
    );
}
