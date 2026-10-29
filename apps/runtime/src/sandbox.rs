//! macOS Seatbelt process isolation and local validation.
//!
//! This module is fail-closed. A project grant is usable only after the
//! bundled probe has demonstrated project write access and denied outside,
//! credential, symlink, subprocess, and network escapes.
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{RuntimeError, RuntimeResult};

const BUNDLED_PROBE_NAME: &str = "aelys-isolation-probe";

#[derive(Debug, Clone)]
pub struct SandboxProfile {
    pub root: PathBuf,
    pub home: PathBuf,
    pub network_allowed: bool,
    parent: PathBuf,
}

impl SandboxProfile {
    pub fn new(root: impl AsRef<Path>) -> RuntimeResult<Self> {
        Self::new_with_network(root, false)
    }

    pub fn new_with_network(root: impl AsRef<Path>, network_allowed: bool) -> RuntimeResult<Self> {
        let root =
            fs::canonicalize(root).map_err(|e| RuntimeError::PathUnavailable(e.to_string()))?;
        if !root.is_dir() {
            return Err(RuntimeError::PathUnavailable(
                "sandbox root is not a directory".into(),
            ));
        }
        let home = dirs_home()
            .ok_or_else(|| RuntimeError::IsolationUnavailable("HOME is unavailable".into()))?;
        let parent = root
            .parent()
            .ok_or_else(|| RuntimeError::PathUnavailable("sandbox root has no parent".into()))?
            .to_path_buf();
        Ok(Self {
            root,
            home,
            network_allowed,
            parent,
        })
    }

    pub fn sbpl(&self) -> String {
        let root = literal(&self.root);
        let parent = literal(&self.parent);
        let home = literal(&self.home);
        format!("(version 1)\n(import \"system.sb\")\n{}(deny file-read* (subpath \"{parent}\"))\n(deny file-write* (subpath \"{parent}\"))\n(deny file-read* (subpath \"{home}/.ssh\"))\n(deny file-read* (subpath \"{home}/.aws\"))\n(deny file-read* (subpath \"{home}/Library/Keychains\"))\n(deny file-read* (subpath \"{home}/.config\"))\n(deny file-read* (subpath \"{home}/.codex\"))\n(deny file-read* (subpath \"{home}/.claude\"))\n(allow process-exec)\n(allow process-fork)\n(allow file-read* (subpath \"{root}\"))\n(allow file-write-create file-write-data file-write-unlink (subpath \"{root}\"))\n", if self.network_allowed { "" } else { "(deny network*)\n" })
    }

    pub(crate) fn digest(&self) -> String {
        digest_bytes(
            format!(
                "aelys-sandbox-profile-v1\nroot={}\nparent={}\nhome={}\nnetwork_allowed={}\nsbpl={}\n",
                self.root.display(),
                self.parent.display(),
                self.home.display(),
                self.network_allowed,
                self.sbpl()
            )
            .as_bytes(),
        )
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn literal(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

pub struct SandboxChild {
    child: Child,
}

impl SandboxChild {
    pub fn wait(mut self) -> RuntimeResult<ExitStatus> {
        self.child.wait().map_err(RuntimeError::from)
    }
    pub fn kill(&mut self) -> RuntimeResult<()> {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.child.id() as i32), libc::SIGKILL);
        }
        self.child.kill().map_err(RuntimeError::from)
    }

    pub fn try_wait(&mut self) -> RuntimeResult<Option<ExitStatus>> {
        self.child.try_wait().map_err(RuntimeError::from)
    }

    pub fn wait_timeout(mut self, timeout: Duration) -> RuntimeResult<ExitStatus> {
        let started = Instant::now();
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            if started.elapsed() >= timeout {
                let _ = self.kill();
                return Err(RuntimeError::ProcessTimeout);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

pub struct SandboxCommand {
    profile: SandboxProfile,
    program: PathBuf,
    args: Vec<OsString>,
    cwd: PathBuf,
    env: Vec<(OsString, OsString)>,
}

impl SandboxCommand {
    pub fn new(
        profile: SandboxProfile,
        program: impl Into<PathBuf>,
        cwd: impl Into<PathBuf>,
    ) -> RuntimeResult<Self> {
        let cwd = cwd.into();
        if !cwd.starts_with(&profile.root) {
            return Err(RuntimeError::UnauthorizedPath);
        }
        Ok(Self {
            profile,
            program: program.into(),
            args: Vec::new(),
            cwd,
            env: Vec::new(),
        })
    }
    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }
    pub fn env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((name.into(), value.into()));
        self
    }
    pub fn spawn(self) -> RuntimeResult<SandboxChild> {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command
            .arg("-p")
            .arg(self.profile.sbpl())
            .arg(&self.program)
            .args(&self.args)
            .current_dir(self.cwd)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .envs(self.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command
            .spawn()
            .map(|child| SandboxChild { child })
            .map_err(|e| {
                RuntimeError::IsolationUnavailable(format!("sandbox process unavailable: {e}"))
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProbeResult {
    pub probe_challenge: String,
    #[serde(default)]
    pub profile_digest: String,
    #[serde(default)]
    pub runtime_digest: String,
    #[serde(default)]
    pub probe_digest: String,
    pub project_write: bool,
    pub outside_read_blocked: bool,
    pub credential_read_blocked: bool,
    pub symlink_read_blocked: bool,
    pub subprocess_escape_blocked: bool,
    pub network_blocked: bool,
}

impl ProbeResult {
    pub fn valid(&self) -> bool {
        self.project_write
            && self.outside_read_blocked
            && self.credential_read_blocked
            && self.symlink_read_blocked
            && self.subprocess_escape_blocked
            && self.network_blocked
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeProvenance {
    pub(crate) canonical_root: PathBuf,
    pub(crate) profile_digest: String,
    pub(crate) runtime_digest: String,
    pub(crate) probe_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeEvidence {
    pub(crate) result: ProbeResult,
    pub(crate) provenance: ProbeProvenance,
}

impl ProbeEvidence {
    pub(crate) fn is_bound_to(&self, profile: &SandboxProfile) -> bool {
        let runtime_digest = runtime_path().and_then(|path| digest_file(&path));
        let probe_digest = bundled_probe_path()
            .and_then(|path| fs::canonicalize(path).map_err(RuntimeError::from))
            .and_then(|path| digest_file(&path));
        self.provenance.canonical_root == profile.root
            && self.provenance.profile_digest == profile.digest()
            && runtime_digest.ok().as_deref() == Some(self.provenance.runtime_digest.as_str())
            && probe_digest.ok().as_deref() == Some(self.provenance.probe_digest.as_str())
    }
}

/// Resolve the only probe identity accepted by the runtime.
///
/// The probe is bundled beside the runtime executable. Test binaries are in a
/// `deps` directory, so their sibling bundle directory is used in that case.
/// No caller supplied path or environment variable can change this identity.
pub fn bundled_probe_path() -> RuntimeResult<PathBuf> {
    let runtime = std::env::current_exe().map_err(|e| {
        RuntimeError::IsolationUnavailable(format!("runtime path unavailable: {e}"))
    })?;
    let runtime = fs::canonicalize(runtime).map_err(|e| {
        RuntimeError::IsolationUnavailable(format!("runtime path unavailable: {e}"))
    })?;
    let runtime_dir = runtime.parent().ok_or_else(|| {
        RuntimeError::IsolationUnavailable("runtime has no parent directory".into())
    })?;
    let bundle_dir = if matches!(
        runtime_dir.file_name().and_then(|name| name.to_str()),
        Some("deps") | Some("examples")
    ) {
        runtime_dir.parent().ok_or_else(|| {
            RuntimeError::IsolationUnavailable("runtime deps directory has no parent".into())
        })?
    } else {
        runtime_dir
    };
    Ok(bundle_dir.join(BUNDLED_PROBE_NAME))
}

fn validated_probe_path(probe_program: &Path) -> RuntimeResult<PathBuf> {
    if probe_program.file_name().and_then(|name| name.to_str()) != Some(BUNDLED_PROBE_NAME) {
        return Err(RuntimeError::UnauthorizedPath);
    }

    let expected = fs::canonicalize(bundled_probe_path()?).map_err(|e| {
        RuntimeError::IsolationUnavailable(format!("bundled isolation probe unavailable: {e}"))
    })?;
    let candidate = fs::canonicalize(probe_program)
        .map_err(|e| RuntimeError::PathUnavailable(e.to_string()))?;
    if candidate != expected {
        return Err(RuntimeError::UnauthorizedPath);
    }
    if !candidate.is_file() {
        return Err(RuntimeError::IsolationUnavailable(
            "bundled isolation probe is not a regular file".into(),
        ));
    }
    Ok(candidate)
}

fn digest_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn digest_file(path: &Path) -> RuntimeResult<String> {
    let mut file = File::open(path).map_err(|e| {
        RuntimeError::IsolationUnavailable(format!("cannot inspect trusted executable: {e}"))
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| {
            RuntimeError::IsolationUnavailable(format!("cannot hash trusted executable: {e}"))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn runtime_path() -> RuntimeResult<PathBuf> {
    let runtime = std::env::current_exe().map_err(|e| {
        RuntimeError::IsolationUnavailable(format!("runtime path unavailable: {e}"))
    })?;
    fs::canonicalize(runtime)
        .map_err(|e| RuntimeError::IsolationUnavailable(format!("runtime path unavailable: {e}")))
}

pub(crate) fn run_probe_attested(
    profile: &SandboxProfile,
    probe_program: &Path,
    args: &[OsString],
) -> RuntimeResult<ProbeEvidence> {
    let probe_program = validated_probe_path(probe_program)?;
    let runtime_path = runtime_path()?;
    let runtime_digest = digest_file(&runtime_path)?;
    let probe_digest = digest_file(&probe_program)?;
    let profile_digest = profile.digest();

    let mut command =
        SandboxCommand::new(profile.clone(), probe_program.clone(), profile.root.clone())?;
    for arg in args {
        command = command.arg(arg.clone());
    }
    let mut child = command.spawn()?;
    let mut stdout = String::new();
    if let Some(mut pipe) = child.child.stdout.take() {
        pipe.read_to_string(&mut stdout)
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
    }
    let status = child.wait()?;
    if !status.success() {
        return Err(RuntimeError::IsolationUnavailable(
            "isolation probe failed to execute".into(),
        ));
    }

    if digest_file(&runtime_path)? != runtime_digest
        || digest_file(&bundled_probe_path()?)? != probe_digest
    {
        return Err(RuntimeError::IsolationUnavailable(
            "trusted runtime or isolation probe changed during validation".into(),
        ));
    }

    let result = serde_json::from_str(&stdout).map_err(|e| {
        RuntimeError::IsolationUnavailable(format!("invalid isolation probe result: {e}"))
    })?;
    let mut result: ProbeResult = result;
    result.profile_digest = profile_digest.clone();
    result.runtime_digest = runtime_digest.clone();
    result.probe_digest = probe_digest.clone();
    Ok(ProbeEvidence {
        result,
        provenance: ProbeProvenance {
            canonical_root: profile.root.clone(),
            profile_digest,
            runtime_digest,
            probe_digest,
        },
    })
}

pub fn run_probe(
    profile: &SandboxProfile,
    probe_program: &Path,
    args: &[OsString],
) -> RuntimeResult<ProbeResult> {
    Ok(run_probe_attested(profile, probe_program, args)?.result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_denies_network_and_credential_paths() {
        let root = std::env::temp_dir();
        let profile = SandboxProfile::new(&root).unwrap();
        let text = profile.sbpl();
        assert!(text.contains("deny network"));
        assert!(text.contains(".ssh"));
        assert!(text.contains(".codex"));
        assert!(text.contains(".claude"));
        assert!(text.contains("file-write-create"));
    }
    #[test]
    fn relative_cwd_outside_root_is_rejected() {
        let root = std::env::temp_dir();
        let profile = SandboxProfile::new(&root).unwrap();
        assert!(SandboxCommand::new(profile, "/bin/echo", root.join("..")).is_err());
    }

    #[test]
    fn arbitrary_probe_path_is_rejected_before_execution() {
        let root = tempfile::tempdir().unwrap();
        let profile = SandboxProfile::new(root.path()).unwrap();
        let error = run_probe(&profile, Path::new("/bin/echo"), &[]).unwrap_err();
        assert!(matches!(error, RuntimeError::UnauthorizedPath));
    }

    #[test]
    fn profile_digest_changes_with_root_and_network_policy() {
        let first_root = tempfile::tempdir().unwrap();
        let second_root = tempfile::tempdir().unwrap();
        let first = SandboxProfile::new(first_root.path()).unwrap();
        let second = SandboxProfile::new(second_root.path()).unwrap();
        let network = SandboxProfile::new_with_network(first_root.path(), true).unwrap();

        assert_ne!(first.digest(), second.digest());
        assert_ne!(first.digest(), network.digest());
    }

    #[test]
    fn probe_evidence_requires_matching_profile_and_digests() {
        let root = tempfile::tempdir().unwrap();
        let other_root = tempfile::tempdir().unwrap();
        let profile = SandboxProfile::new(root.path()).unwrap();
        let other_profile = SandboxProfile::new(other_root.path()).unwrap();
        let result = ProbeResult {
            probe_challenge: "challenge".into(),
            profile_digest: String::new(),
            runtime_digest: String::new(),
            probe_digest: String::new(),
            project_write: true,
            outside_read_blocked: true,
            credential_read_blocked: true,
            symlink_read_blocked: true,
            subprocess_escape_blocked: true,
            network_blocked: true,
        };
        let evidence = ProbeEvidence {
            result,
            provenance: ProbeProvenance {
                canonical_root: profile.root.clone(),
                profile_digest: profile.digest(),
                runtime_digest: digest_file(&runtime_path().unwrap()).unwrap(),
                probe_digest: digest_file(
                    &fs::canonicalize(bundled_probe_path().unwrap()).unwrap(),
                )
                .unwrap(),
            },
        };

        assert!(evidence.is_bound_to(&profile));
        assert!(!evidence.is_bound_to(&other_profile));
    }
}
