use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{RuntimeError, RuntimeResult};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AdapterKind {
    ClaudeCode,
    CodexCli,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdapterCapabilities {
    pub adapter: AdapterKind,
    pub executable: String,
    pub installed: bool,
    pub version: Option<String>,
    pub can_discover_sessions: bool,
    pub can_resume_sessions: bool,
    pub can_run: bool,
    pub reason: Option<String>,
}

pub trait CommandProbe: Send + Sync {
    fn probe_version(&self, executable: &str) -> std::io::Result<(bool, String)>;
    fn probe_help(&self, executable: &str, kind: AdapterKind) -> std::io::Result<(bool, String)> {
        let mut command = Command::new(executable);
        match kind {
            AdapterKind::ClaudeCode => {
                command.arg("--help");
            }
            AdapterKind::CodexCli => {
                command.args(["exec", "--help"]);
            }
        }
        let output = command.output()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let text = if text.is_empty() {
            String::from_utf8_lossy(&output.stderr).trim().to_owned()
        } else {
            text
        };
        Ok((output.status.success(), text))
    }
}

pub struct ProcessCommandProbe;

impl CommandProbe for ProcessCommandProbe {
    fn probe_version(&self, executable: &str) -> std::io::Result<(bool, String)> {
        let output = Command::new(executable).arg("--version").output()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let text = if text.is_empty() {
            String::from_utf8_lossy(&output.stderr).trim().to_owned()
        } else {
            text
        };
        Ok((output.status.success(), text))
    }
}

pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AdapterKind;
    fn probe_support(&self) -> AdapterCapabilities;
    fn start(&self, _task: &str) -> RuntimeResult<()> {
        Err(RuntimeError::AdapterUnavailable(
            "vendor invocation is not enabled until supported flags and isolation are validated"
                .into(),
        ))
    }
    fn cancel(&self, _handle: &str) -> RuntimeResult<()> {
        Err(RuntimeError::AdapterUnavailable(
            "no process was started".into(),
        ))
    }
}

#[derive(Debug, Clone)]
pub struct VendorAdapter<P> {
    pub kind: AdapterKind,
    pub executable: String,
    pub probe: P,
}

impl<P: CommandProbe> VendorAdapter<P> {
    pub fn new(kind: AdapterKind, executable: impl Into<String>, probe: P) -> Self {
        Self {
            kind,
            executable: executable.into(),
            probe,
        }
    }
}

impl<P: CommandProbe> AgentAdapter for VendorAdapter<P> {
    fn kind(&self) -> AdapterKind {
        self.kind
    }

    fn probe_support(&self) -> AdapterCapabilities {
        match self.probe.probe_version(&self.executable) {
            Ok((true, version)) => {
                let required = match self.kind {
                    AdapterKind::ClaudeCode => &["--print", "--output-format", "stream-json"][..],
                    AdapterKind::CodexCli => &["exec", "--json", "--ephemeral"][..],
                };
                let reason = match self.probe.probe_help(&self.executable, self.kind) {
                    Ok((true, help)) if required.iter().all(|flag| help.contains(flag)) =>
                        "version and invocation shape detected; authentication, isolation, and native session compatibility remain unverified".into(),
                    Ok((true, _)) => "version detected but required non-interactive invocation flags were not found".into(),
                    Ok((false, output)) => format!("version detected but help probe failed: {output}"),
                    Err(error) => format!("version detected but help probe unavailable: {error}"),
                };
                AdapterCapabilities {
                    adapter: self.kind,
                    executable: self.executable.clone(),
                    installed: true,
                    version: Some(version),
                    can_discover_sessions: false,
                    can_resume_sessions: false,
                    can_run: false,
                    reason: Some(reason),
                }
            }
            Ok((false, output)) => unavailable(
                self.kind,
                &self.executable,
                format!("--version failed: {output}"),
            ),
            Err(error) => unavailable(self.kind, &self.executable, error.to_string()),
        }
    }
}

fn unavailable(kind: AdapterKind, executable: &str, reason: String) -> AdapterCapabilities {
    AdapterCapabilities {
        adapter: kind,
        executable: executable.into(),
        installed: false,
        version: None,
        can_discover_sessions: false,
        can_resume_sessions: false,
        can_run: false,
        reason: Some(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeProbe;
    impl CommandProbe for FakeProbe {
        fn probe_version(&self, _: &str) -> std::io::Result<(bool, String)> {
            Ok((true, "vendor 1.2.3".into()))
        }
    }

    struct CompatibleProbe;
    impl CommandProbe for CompatibleProbe {
        fn probe_version(&self, _: &str) -> std::io::Result<(bool, String)> {
            Ok((true, "vendor 1.2.3".into()))
        }
        fn probe_help(&self, _: &str, _: AdapterKind) -> std::io::Result<(bool, String)> {
            Ok((
                true,
                "exec --json --ephemeral --print --output-format stream-json".into(),
            ))
        }
    }

    #[test]
    fn probe_does_not_claim_unknown_capabilities() {
        let adapter = VendorAdapter::new(AdapterKind::CodexCli, "codex", FakeProbe);
        let capabilities = adapter.probe_support();
        assert!(capabilities.installed);
        assert!(!capabilities.can_discover_sessions);
        assert!(!capabilities.can_resume_sessions);
        assert!(!capabilities.can_run);
    }

    #[test]
    fn compatible_invocation_is_detected_but_execution_stays_fail_closed() {
        let adapter = VendorAdapter::new(AdapterKind::CodexCli, "codex", CompatibleProbe);
        let capabilities = adapter.probe_support();
        assert!(capabilities.installed);
        assert!(!capabilities.can_run);
        assert!(capabilities
            .reason
            .unwrap()
            .contains("invocation shape detected"));
    }
}
