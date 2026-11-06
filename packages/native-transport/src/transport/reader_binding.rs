//! Phase 5 / task 4: native reader identity and fail-closed offline state.
//!
//! A binding authorizes identity checks only, not filesystem access, provider
//! egress, automation or execution. It is Rust-only and holds no credentials.
//! Reader calls never resume Keychain credentials, refresh tokens, publish
//! diagnostics or send local paths, search queries or transcript contents.
//! Assumption: remote revocation is observed by fresh checks, not an atomic
//! server/local transaction. Offline authority and packaged reader acceptance
//! remain OPEN; this module does not register IPC or enable a release reader.

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
mod tests;

/// Non-serializable authority for one in-memory session. Even an identical
/// login/resume replaces its identity and permanently invalidates old grants.
#[derive(Clone)]
pub struct NativeSessionBinding(Arc<SessionBinding>);

struct SessionBinding {
    origin: String,
    owner_id: String,
    device_id: String,
    expires_at: Instant,
    active: AtomicBool,
}

impl NativeSessionBinding {
    pub(super) fn new(origin: &str, owner_id: &str, device_id: &str, expires_at: Instant) -> Self {
        Self(Arc::new(SessionBinding {
            origin: origin.into(),
            owner_id: owner_id.into(),
            device_id: device_id.into(),
            expires_at,
            active: AtomicBool::new(true),
        }))
    }

    // CLI commands create a temporary NativeState. Its drop must invalidate
    // only its own authority, never the owning CLI session's reader binding.
    #[cfg(any(target_os = "macos", test))]
    pub(super) fn detached(&self) -> Self {
        let binding = Self::new(
            &self.0.origin,
            &self.0.owner_id,
            &self.0.device_id,
            self.0.expires_at,
        );
        binding
            .0
            .active
            .store(self.0.active.load(Ordering::SeqCst), Ordering::SeqCst);
        binding
    }

    pub fn ensure_active(&self) -> Result<(), String> {
        if self.0.active.load(Ordering::SeqCst) && Instant::now() < self.0.expires_at {
            Ok(())
        } else {
            Err(err("SIGN_IN_REQUIRED"))
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.binding.0.active.store(false, Ordering::SeqCst);
    }
}

/// Device auth does not return expires_in. Read only exp from its bounded JWT
/// envelope as a conservative local deadline, never as proof of identity or
/// signature validity. Unknown/expired lifetimes disable only reader authority;
/// the existing device login and CLI/MCP contracts remain unchanged. Every
/// reader validation still requires the authenticated server's /me response.
pub(super) fn device_deadline(access: &str) -> Instant {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let now = Instant::now();
    let deadline = || -> Option<Instant> {
        if access.len() > 16 * 1024 {
            return None;
        }
        let mut parts = access.split('.');
        let header = parts.next()?;
        let payload = parts.next()?;
        let signature = parts.next()?;
        if header.is_empty() || signature.is_empty() || parts.next().is_some() {
            return None;
        }
        #[derive(Deserialize)]
        struct Expiry {
            exp: u64,
        }
        let claims: Expiry = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
        let remaining = Duration::from_secs(claims.exp)
            .checked_sub(SystemTime::now().duration_since(UNIX_EPOCH).ok()?)?;
        now.checked_add(remaining)
    };
    deadline().unwrap_or(now)
}

// Reader ownership checks need a distinct not-found result. Keep the existing
// generic/typed MCP and CLI error contracts unchanged. This GET-only path uses
// the same no-redirect/no-proxy client, size bounds and redacted failures.
async fn identity_get<T: DeserializeOwned>(url: &str, access: &str) -> Result<T, String> {
    let mut response = client()?
        .get(url)
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| err("NETWORK_ERROR"))?;
    if !response.status().is_success() {
        return Err(err(match response.status() {
            StatusCode::UNAUTHORIZED => "UNAUTHORIZED",
            StatusCode::FORBIDDEN => "FORBIDDEN",
            StatusCode::NOT_FOUND => "NOT_FOUND",
            _ => "BACKEND_ERROR",
        }));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_JSON as u64)
    {
        return Err(err("RESPONSE_TOO_LARGE"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| err("NETWORK_ERROR"))? {
        if bytes.len().saturating_add(chunk.len()) > MAX_JSON {
            return Err(err("RESPONSE_TOO_LARGE"));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| err("INVALID_RESPONSE"))
}

impl NativeState {
    /// No caller-selected owner/device/origin and no implicit Keychain resume.
    pub async fn session_binding(&self) -> Result<NativeSessionBinding, String> {
        let guard = self.0.lock().await;
        let session = guard.as_ref().ok_or_else(|| err("SIGN_IN_REQUIRED"))?;
        session.binding.ensure_active()?;
        Ok(session.binding.clone())
    }

    async fn binding_request<T: DeserializeOwned>(
        &self,
        binding: &NativeSessionBinding,
        path: &str,
    ) -> Result<T, String> {
        let access = {
            let guard = self.0.lock().await;
            binding.ensure_active()?;
            guard
                .as_ref()
                .filter(|session| Arc::ptr_eq(&session.binding.0, &binding.0))
                .map(|session| session.access.clone())
                .ok_or_else(|| err("SIGN_IN_REQUIRED"))?
        };
        let response = identity_get(&format!("{}{path}", binding.0.origin), &access).await;
        let mut guard = self.0.lock().await;
        binding.ensure_active()?;
        if !guard
            .as_ref()
            .is_some_and(|session| Arc::ptr_eq(&session.binding.0, &binding.0))
        {
            return Err(err("SIGN_IN_REQUIRED"));
        }
        if response
            .as_ref()
            .is_err_and(|error| error == "UNAUTHORIZED")
        {
            *guard = None;
            return Err(err("SIGN_IN_REQUIRED"));
        }
        response
    }

    /// Fresh owner/device check. Cached status, offline responses and token
    /// claims cannot grant access. A late response cannot cross session changes.
    pub async fn validate_session_binding(
        &self,
        binding: &NativeSessionBinding,
    ) -> Result<(), String> {
        let me: DeviceOwner = self.binding_request(binding, "/api/v1/me").await?;
        if me.id != binding.0.owner_id || me.device_id.as_deref() != Some(&binding.0.device_id) {
            binding.0.active.store(false, Ordering::SeqCst);
            return Err(err("SIGN_IN_REQUIRED"));
        }
        binding.ensure_active()
    }

    /// Project ownership is distinct from filesystem or remote execution grants.
    /// Only fixed authenticated GETs leave the process; no local data are sent.
    pub async fn validate_session_project(
        &self,
        binding: &NativeSessionBinding,
        project_id: &str,
    ) -> Result<(), String> {
        if !valid_id(project_id) {
            return Err(err("VALIDATION_ERROR"));
        }
        self.validate_session_binding(binding).await?;
        #[derive(Deserialize)]
        struct OwnedProject {
            id: String,
        }
        let project: OwnedProject = match self
            .binding_request(binding, &format!("/api/v1/projects/{project_id}"))
            .await
        {
            Ok(project) => project,
            Err(code) if code == "NOT_FOUND" => return Err(err("READER_PROJECT_UNAVAILABLE")),
            Err(code) => return Err(code),
        };
        if project.id != project_id {
            return Err(err("INVALID_RESPONSE"));
        }
        binding.ensure_active()
    }
}
