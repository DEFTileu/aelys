use crate::error::{RuntimeError, RuntimeResult};
use crate::sandbox::{run_probe_attested, ProbeResult, SandboxProfile};
use std::ffi::OsString;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IsolationStatus {
    Unavailable(String),
    Validated,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct IsolationValidationReport {
    pub os_level_enforced: bool,
    pub escape_tests_passed: bool,
    pub credential_paths_unavailable: bool,
    pub network_policy_enforced: bool,
}

#[derive(Debug, Clone)]
pub struct IsolationGate {
    status: IsolationStatus,
}

impl IsolationGate {
    pub fn unavailable() -> Self {
        Self {
            status: IsolationStatus::Unavailable(
                "macOS OS-level sandbox validation has not passed".into(),
            ),
        }
    }

    #[allow(dead_code)]
    pub fn from_report(report: IsolationValidationReport) -> Self {
        let valid = report.os_level_enforced
            && report.escape_tests_passed
            && report.credential_paths_unavailable
            && report.network_policy_enforced;
        if valid {
            Self {
                status: IsolationStatus::Validated,
            }
        } else {
            Self::unavailable()
        }
    }

    #[cfg(test)]
    fn complete_test_report() -> IsolationValidationReport {
        IsolationValidationReport {
            os_level_enforced: true,
            escape_tests_passed: true,
            credential_paths_unavailable: true,
            network_policy_enforced: true,
        }
    }

    pub fn status(&self) -> &IsolationStatus {
        &self.status
    }

    pub fn authorize_run(&self) -> RuntimeResult<()> {
        match &self.status {
            IsolationStatus::Validated => Ok(()),
            IsolationStatus::Unavailable(reason) => {
                Err(RuntimeError::IsolationUnavailable(reason.clone()))
            }
        }
    }
}

/// Probe placeholder. A real implementation must run an OS-level macOS
/// sandbox validation suite and produce all four evidence fields. It never
/// reports success based on a cwd check or a profile string alone.
pub struct MacOsIsolationValidator;

impl MacOsIsolationValidator {
    pub fn validate() -> IsolationStatus {
        IsolationStatus::Unavailable(
            "validation spike required before unattended execution can be enabled".into(),
        )
    }

    pub fn validate_project(
        root: &Path,
        probe_program: &Path,
        outside: &Path,
        credential: &Path,
        symlink: &Path,
        network: &str,
    ) -> RuntimeResult<IsolationGate> {
        Self::validate_project_with_network(
            root,
            probe_program,
            outside,
            credential,
            symlink,
            network,
            false,
        )
    }

    pub fn validate_project_with_network(
        root: &Path,
        probe_program: &Path,
        outside: &Path,
        credential: &Path,
        symlink: &Path,
        network: &str,
        network_allowed: bool,
    ) -> RuntimeResult<IsolationGate> {
        let profile = SandboxProfile::new_with_network(root, network_allowed)?;
        let probe_challenge = Uuid::new_v4().to_string();
        let args: Vec<OsString> = vec![
            root.join(".aelys-probe-write").into(),
            outside.into(),
            credential.into(),
            symlink.into(),
            network.into(),
            probe_challenge.clone().into(),
        ];
        let evidence = run_probe_attested(&profile, probe_program, &args)?;
        if !evidence.is_bound_to(&profile) {
            return Err(RuntimeError::IsolationUnavailable(
                "isolation probe evidence is not bound to the canonical root and profile".into(),
            ));
        }
        let result: ProbeResult = evidence.result;
        if result.probe_challenge != probe_challenge {
            return Err(RuntimeError::IsolationUnavailable(
                "isolation probe challenge did not round-trip".into(),
            ));
        }
        let report = IsolationValidationReport {
            os_level_enforced: true,
            escape_tests_passed: result.outside_read_blocked
                && result.symlink_read_blocked
                && result.subprocess_escape_blocked,
            credential_paths_unavailable: result.credential_read_blocked,
            network_policy_enforced: result.network_blocked == !network_allowed,
        };
        let gate = IsolationGate::from_report(report);
        gate.authorize_run().map(|_| gate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_gate_is_unavailable() {
        assert!(IsolationGate::unavailable().authorize_run().is_err());
    }

    #[test]
    fn incomplete_report_stays_blocked() {
        let gate = IsolationGate::from_report(IsolationValidationReport {
            os_level_enforced: true,
            escape_tests_passed: true,
            credential_paths_unavailable: true,
            network_policy_enforced: false,
        });
        assert!(gate.authorize_run().is_err());
    }

    #[test]
    fn complete_report_can_authorize() {
        let gate = IsolationGate::from_report(IsolationGate::complete_test_report());
        assert!(gate.authorize_run().is_ok());
    }
}
