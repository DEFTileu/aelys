use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::adapter::AgentAdapter;
use crate::credentials::{
    load_brokered_credential, CredentialLease, CredentialReplayGuard, CredentialScope,
    CredentialVerifier, KeychainReader,
};
use crate::error::{RuntimeError, RuntimeResult};
use crate::isolation::IsolationGate;
use crate::process::{build_invocation, ManagedCliProcess};
use crate::runs::{RunManager, RunPersistence, RunRecord};
use crate::sandbox::SandboxProfile;
use ed25519_dalek::VerifyingKey;
use std::path::Path;
use std::path::PathBuf;
use std::time::{Duration as StdDuration, Instant};

/// Orchestrates the safe boundary around a local process. It intentionally
/// cannot start a vendor process until both adapter capability validation and
/// OS-level isolation validation have succeeded.
pub struct LocalRunCoordinator<A> {
    pub manager: RunManager,
    pub adapter: A,
    pub isolation: IsolationGate,
}

pub struct CredentialRequest<'a> {
    pub reader: &'a dyn KeychainReader,
    pub lease: &'a CredentialLease,
    pub trusted_backend_key: &'a VerifyingKey,
    pub replay_guard: &'a CredentialReplayGuard,
    pub device_id: Uuid,
    pub grant_id: Uuid,
}

impl<A> LocalRunCoordinator<A> {
    pub fn with_persistence(
        adapter: A,
        isolation: IsolationGate,
        persistence: std::sync::Arc<dyn RunPersistence>,
    ) -> RuntimeResult<Self> {
        Ok(Self {
            manager: RunManager::with_persistence(persistence)?,
            adapter,
            isolation,
        })
    }
}

impl<A: AgentAdapter> LocalRunCoordinator<A> {
    pub fn submit(
        &self,
        key: impl Into<String>,
        project_id: Uuid,
        task: impl Into<String>,
    ) -> RuntimeResult<RunRecord> {
        self.manager
            .submit(key, project_id, self.adapter.kind(), task)
    }

    pub fn claim(
        &self,
        key: &str,
        now: DateTime<Utc>,
        lease_for: Duration,
    ) -> RuntimeResult<RunRecord> {
        self.manager.claim(key, now, lease_for)
    }

    pub fn start(&self, key: &str) -> RuntimeResult<RunRecord> {
        self.isolation.authorize_run()?;
        let capabilities = self.adapter.probe_support();
        if !capabilities.can_run {
            return Err(RuntimeError::AdapterUnavailable(
                capabilities
                    .reason
                    .unwrap_or_else(|| "adapter cannot run".into()),
            ));
        }
        self.manager.start(key)
    }

    pub fn cancel(&self, key: &str) -> RuntimeResult<RunRecord> {
        self.manager.request_cancel(key)
    }

    /// Execute one already claimed run inside the validated project sandbox.
    /// The vendor process receives structured argv values, never a shell
    /// command. Terminal state is persisted in the local run manager.
    pub fn execute_once(
        &self,
        key: &str,
        profile: SandboxProfile,
        cwd: &Path,
        executable: impl Into<std::path::PathBuf>,
        timeout: StdDuration,
    ) -> RuntimeResult<RunRecord> {
        self.isolation.authorize_run()?;
        let capabilities = self.adapter.probe_support();
        if !capabilities.can_run {
            return Err(RuntimeError::AdapterUnavailable(
                "adapter capability probe does not permit execution".into(),
            ));
        }
        let executable = executable.into();
        validate_executable(&capabilities.executable, &executable)?;
        let run = self
            .manager
            .transition(key, crate::runs::RunState::Running)?;
        let invocation = build_invocation(run.adapter, executable, &run.task)?;
        self.wait_for_process(
            key,
            ManagedCliProcess::spawn(profile, cwd, invocation)?,
            timeout,
        )
    }

    pub fn execute_once_with_credential(
        &self,
        key: &str,
        profile: SandboxProfile,
        cwd: &Path,
        executable: impl Into<std::path::PathBuf>,
        timeout: StdDuration,
        request: CredentialRequest<'_>,
    ) -> RuntimeResult<RunRecord> {
        self.isolation.authorize_run()?;
        let capabilities = self.adapter.probe_support();
        if !capabilities.can_run {
            return Err(RuntimeError::AdapterUnavailable(
                "adapter capability probe does not permit execution".into(),
            ));
        }
        let executable = executable.into();
        validate_executable(&capabilities.executable, &executable)?;
        let queued = self.manager.get(key)?;
        let verifier = CredentialVerifier {
            now: Utc::now(),
            scope: CredentialScope {
                run_id: queued.run_id,
                device_id: request.device_id,
                project_id: queued.project_id,
                grant_id: request.grant_id,
            },
            trusted_backend_key: request.trusted_backend_key,
            replay_guard: request.replay_guard,
        };
        let (name, value) = load_brokered_credential(request.reader, request.lease, &verifier)?;
        let run = self
            .manager
            .transition(key, crate::runs::RunState::Running)?;
        let invocation = build_invocation(run.adapter, executable, &run.task)?;
        self.wait_for_process(
            key,
            ManagedCliProcess::spawn_with_env(profile, cwd, invocation, [(name, value)])?,
            timeout,
        )
    }

    fn wait_for_process(
        &self,
        key: &str,
        mut process: ManagedCliProcess,
        timeout: StdDuration,
    ) -> RuntimeResult<RunRecord> {
        let started = Instant::now();
        loop {
            let run = self.manager.get(key)?;
            if !self.manager.lease_valid(key, Utc::now())? {
                process.cancel()?;
                return self.manager.transition(key, crate::runs::RunState::Expired);
            }
            if run.cancellation_requested {
                process.cancel()?;
                return self
                    .manager
                    .transition(key, crate::runs::RunState::Cancelled);
            }
            if let Some(status) = process.try_wait()? {
                return if status.success() {
                    self.manager
                        .transition(key, crate::runs::RunState::Completed)
                } else {
                    self.manager.transition(key, crate::runs::RunState::Failed)
                };
            }
            if started.elapsed() >= timeout {
                process.cancel()?;
                return self.manager.transition(key, crate::runs::RunState::Expired);
            }
            std::thread::sleep(StdDuration::from_millis(20));
        }
    }
}

fn validate_executable(probed: &str, requested: &Path) -> RuntimeResult<()> {
    let probed_path = PathBuf::from(probed);
    if !probed_path.is_absolute() || !requested.is_absolute() {
        return Err(RuntimeError::AdapterUnavailable(
            "runnable adapters must expose an absolute probed executable".into(),
        ));
    }
    let probed = probed_path
        .canonicalize()
        .map_err(|_| RuntimeError::AdapterUnavailable("probed executable is unavailable".into()))?;
    let requested = requested.canonicalize().map_err(|_| {
        RuntimeError::AdapterUnavailable("requested executable is unavailable".into())
    })?;
    if probed != requested {
        return Err(RuntimeError::AdapterUnavailable(
            "requested executable does not match the probed adapter executable".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::{AdapterCapabilities, AdapterKind};
    use crate::isolation::{IsolationGate, IsolationValidationReport};

    struct RunAdapter;
    impl AgentAdapter for RunAdapter {
        fn kind(&self) -> AdapterKind {
            AdapterKind::ClaudeCode
        }
        fn probe_support(&self) -> AdapterCapabilities {
            AdapterCapabilities {
                adapter: self.kind(),
                executable: "/bin/echo".into(),
                installed: true,
                version: Some("test".into()),
                can_discover_sessions: false,
                can_resume_sessions: false,
                can_run: true,
                reason: None,
            }
        }
    }

    #[test]
    fn executable_identity_is_bound_before_run() {
        assert!(validate_executable("/bin/echo", Path::new("/bin/cat")).is_err());
        assert!(validate_executable("/bin/echo", Path::new("/bin/echo")).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn execute_once_transitions_claimed_run_to_completed() {
        let root = tempfile::tempdir().unwrap();
        let profile = SandboxProfile::new(root.path()).unwrap();
        let cwd = profile.root.clone();
        let gate = IsolationGate::from_report(IsolationValidationReport {
            os_level_enforced: true,
            escape_tests_passed: true,
            credential_paths_unavailable: true,
            network_policy_enforced: true,
        });
        let coordinator = LocalRunCoordinator {
            manager: RunManager::default(),
            adapter: RunAdapter,
            isolation: gate,
        };
        let project = Uuid::new_v4();
        coordinator.submit("run", project, "hello").unwrap();
        coordinator
            .claim("run", Utc::now(), Duration::minutes(1))
            .unwrap();
        let result = coordinator
            .execute_once("run", profile, &cwd, "/bin/echo", StdDuration::from_secs(2))
            .unwrap();
        assert_eq!(result.state, crate::runs::RunState::Completed);
    }
}
