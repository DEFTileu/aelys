//! Vendor CLI command construction and supervised execution.
//!
//! The command builders use documented non-interactive entry points and never
//! accept a raw shell string. The caller supplies a canonical project root and
//! a validated `SandboxProfile`; the process inherits a scrubbed environment.
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::adapter::AdapterKind;
use crate::error::{RuntimeError, RuntimeResult};
use crate::sandbox::{SandboxChild, SandboxCommand, SandboxProfile};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliInvocation {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

pub fn build_invocation(
    adapter: AdapterKind,
    executable: impl Into<PathBuf>,
    task: &str,
) -> RuntimeResult<CliInvocation> {
    if task.is_empty() || task.len() > 10_000 {
        return Err(RuntimeError::AdapterUnavailable(
            "task length is outside bounds".into(),
        ));
    }
    let executable = executable.into();
    let args = match adapter {
        AdapterKind::ClaudeCode => vec![
            "--print".into(),
            "--output-format".into(),
            "stream-json".into(),
            task.into(),
        ],
        AdapterKind::CodexCli => vec![
            "exec".into(),
            "--json".into(),
            "--ephemeral".into(),
            task.into(),
        ],
    };
    Ok(CliInvocation { executable, args })
}

pub struct ManagedCliProcess {
    child: SandboxChild,
}

impl ManagedCliProcess {
    pub fn spawn(
        profile: SandboxProfile,
        cwd: &Path,
        invocation: CliInvocation,
    ) -> RuntimeResult<Self> {
        if !cwd.starts_with(&profile.root) {
            return Err(RuntimeError::UnauthorizedPath);
        }
        let mut command = SandboxCommand::new(profile, invocation.executable, cwd.to_path_buf())?;
        for arg in invocation.args {
            command = command.arg(arg);
        }
        Ok(Self {
            child: command.spawn()?,
        })
    }
    pub fn spawn_with_env(
        profile: SandboxProfile,
        cwd: &Path,
        invocation: CliInvocation,
        env: impl IntoIterator<Item = (String, String)>,
    ) -> RuntimeResult<Self> {
        if !cwd.starts_with(&profile.root) {
            return Err(RuntimeError::UnauthorizedPath);
        }
        let mut command = SandboxCommand::new(profile, invocation.executable, cwd.to_path_buf())?;
        for arg in invocation.args {
            command = command.arg(arg);
        }
        for (name, value) in env {
            command = command.env(name, value);
        }
        Ok(Self {
            child: command.spawn()?,
        })
    }
    pub fn wait_timeout(self, timeout: Duration) -> RuntimeResult<std::process::ExitStatus> {
        self.child.wait_timeout(timeout)
    }
    pub fn try_wait(&mut self) -> RuntimeResult<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }
    pub fn cancel(&mut self) -> RuntimeResult<()> {
        self.child.kill()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn builders_do_not_accept_shell_strings() {
        let invocation = build_invocation(
            AdapterKind::CodexCli,
            "/opt/homebrew/bin/codex",
            "echo; cat ~/.ssh/id_rsa",
        )
        .unwrap();
        assert_eq!(invocation.args[0], "exec");
        assert_eq!(invocation.args.last().unwrap(), "echo; cat ~/.ssh/id_rsa");
    }
    #[test]
    fn task_bounds_are_enforced() {
        assert!(build_invocation(AdapterKind::ClaudeCode, "/bin/echo", "").is_err());
        assert!(
            build_invocation(AdapterKind::ClaudeCode, "/bin/echo", &"x".repeat(10_001)).is_err()
        );
    }

    #[test]
    fn explicit_environment_is_not_implicit_host_environment() {
        let root = tempfile::tempdir().unwrap();
        let profile = SandboxProfile::new(root.path()).unwrap();
        let cwd = profile.root.clone();
        let invocation = CliInvocation {
            executable: "/bin/echo".into(),
            args: vec!["ok".into()],
        };
        let process = ManagedCliProcess::spawn_with_env(
            profile,
            &cwd,
            invocation,
            [("AELYS_TEST_SECRET".into(), "value".into())],
        )
        .unwrap();
        assert!(process
            .wait_timeout(Duration::from_secs(2))
            .unwrap()
            .success());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn managed_process_runs_inside_sandbox_and_finishes() {
        let root = tempfile::tempdir().unwrap();
        let profile = SandboxProfile::new(root.path()).unwrap();
        let invocation = build_invocation(AdapterKind::ClaudeCode, "/bin/echo", "hello").unwrap();
        let cwd = profile.root.clone();
        let process = ManagedCliProcess::spawn(profile, &cwd, invocation).unwrap();
        assert!(process
            .wait_timeout(Duration::from_secs(2))
            .unwrap()
            .success());
    }
}
