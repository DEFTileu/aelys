//! Explicit macOS Keychain credential access for a vendor CLI.
//!
//! Credentials are fetched only for the fixed provider mapping. They are held in memory,
//! passed to the sandbox child environment, and never serialized or logged.
use crate::error::{RuntimeError, RuntimeResult};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::process::Command;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCredential {
    ClaudeApiKey,
    OpenAiApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialLease {
    pub lease_id: Uuid,
    pub run_id: Uuid,
    pub device_id: Uuid,
    pub project_id: Uuid,
    pub grant_id: Uuid,
    pub provider: ProviderCredential,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub nonce: [u8; 32],
    pub signed_payload: String,
    pub signature: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct CredentialLeaseClaims {
    lease_id: Uuid,
    run_id: Uuid,
    device_id: Uuid,
    project_id: Uuid,
    grant_id: Uuid,
    provider: ProviderCredential,
    issued_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    nonce: [u8; 32],
}

#[derive(Clone, Default)]
pub struct CredentialReplayGuard {
    seen_nonces: Arc<Mutex<HashSet<[u8; 32]>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CredentialLeaseSpec {
    pub run_id: Uuid,
    pub device_id: Uuid,
    pub project_id: Uuid,
    pub grant_id: Uuid,
    pub provider: ProviderCredential,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub nonce: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CredentialScope {
    pub run_id: Uuid,
    pub device_id: Uuid,
    pub project_id: Uuid,
    pub grant_id: Uuid,
}

pub struct CredentialVerifier<'a> {
    pub now: DateTime<Utc>,
    pub scope: CredentialScope,
    pub trusted_backend_key: &'a VerifyingKey,
    pub replay_guard: &'a CredentialReplayGuard,
}

impl CredentialLease {
    pub fn issue(spec: CredentialLeaseSpec, key: &SigningKey) -> RuntimeResult<Self> {
        let claims = CredentialLeaseClaims {
            lease_id: Uuid::new_v4(),
            run_id: spec.run_id,
            device_id: spec.device_id,
            project_id: spec.project_id,
            grant_id: spec.grant_id,
            provider: spec.provider,
            issued_at: spec.issued_at,
            expires_at: spec.expires_at,
            nonce: spec.nonce,
        };
        let signed_payload = serde_json::to_string(&claims)?;
        Ok(Self {
            lease_id: claims.lease_id,
            run_id: claims.run_id,
            device_id: claims.device_id,
            project_id: claims.project_id,
            grant_id: claims.grant_id,
            provider: claims.provider,
            issued_at: claims.issued_at,
            expires_at: claims.expires_at,
            nonce: claims.nonce,
            signature: key.sign(signed_payload.as_bytes()).to_bytes().to_vec(),
            signed_payload,
        })
    }

    pub fn verify(&self, verifier: &CredentialVerifier<'_>) -> RuntimeResult<()> {
        let scope = verifier.scope;
        if self.run_id != scope.run_id
            || self.device_id != scope.device_id
            || self.project_id != scope.project_id
            || self.grant_id != scope.grant_id
            || self.expires_at <= verifier.now
            || self.issued_at > verifier.now + chrono::Duration::seconds(30)
            || self.expires_at > self.issued_at + chrono::Duration::minutes(10)
        {
            return Err(RuntimeError::AdapterUnavailable(
                "credential lease scope or lifetime is invalid".into(),
            ));
        }
        let claims = CredentialLeaseClaims {
            lease_id: self.lease_id,
            run_id: self.run_id,
            device_id: self.device_id,
            project_id: self.project_id,
            grant_id: self.grant_id,
            provider: self.provider,
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            nonce: self.nonce,
        };
        if self.signed_payload != serde_json::to_string(&claims)? {
            return Err(RuntimeError::AdapterUnavailable(
                "credential lease payload mismatch".into(),
            ));
        }
        let signature: [u8; 64] = self.signature.as_slice().try_into().map_err(|_| {
            RuntimeError::AdapterUnavailable("credential lease signature length is invalid".into())
        })?;
        verifier
            .trusted_backend_key
            .verify(
                self.signed_payload.as_bytes(),
                &Signature::from_bytes(&signature),
            )
            .map_err(|_| {
                RuntimeError::AdapterUnavailable("credential lease signature is invalid".into())
            })?;
        let mut seen = verifier.replay_guard.seen_nonces.lock().unwrap();
        if !seen.insert(self.nonce) {
            return Err(RuntimeError::AdapterUnavailable(
                "credential lease was already used".into(),
            ));
        }
        Ok(())
    }
}
impl ProviderCredential {
    pub fn env_name(self) -> &'static str {
        match self {
            Self::ClaudeApiKey => "ANTHROPIC_API_KEY",
            Self::OpenAiApiKey => "OPENAI_API_KEY",
        }
    }

    pub fn keychain_service(self) -> &'static str {
        match self {
            Self::ClaudeApiKey => "com.aelys.claude",
            Self::OpenAiApiKey => "com.aelys.openai",
        }
    }
}
pub trait KeychainReader: Send + Sync {
    fn read_password(&self, service: &str, account: &str) -> RuntimeResult<String>;
}
pub struct MacOsKeychainReader;
impl KeychainReader for MacOsKeychainReader {
    fn read_password(&self, service: &str, account: &str) -> RuntimeResult<String> {
        if service.is_empty()
            || account != "default"
            || !matches!(service, "com.aelys.claude" | "com.aelys.openai")
        {
            return Err(RuntimeError::Channel(
                "keychain service/account required".into(),
            ));
        }
        let output = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .map_err(|e| RuntimeError::Channel(format!("keychain unavailable: {e}")))?;
        if !output.status.success() {
            return Err(RuntimeError::Channel(
                "keychain credential unavailable".into(),
            ));
        }
        let value = String::from_utf8(output.stdout)
            .map_err(|_| RuntimeError::Channel("keychain returned invalid credential".into()))?
            .trim()
            .to_owned();
        if value.is_empty() || value.len() > 4096 {
            return Err(RuntimeError::Channel(
                "keychain credential length is invalid".into(),
            ));
        }
        Ok(value)
    }
}
pub fn load_cli_credential(
    reader: &dyn KeychainReader,
    provider: ProviderCredential,
) -> RuntimeResult<(String, String)> {
    let service = provider.keychain_service();
    let account = "default";
    Ok((
        provider.env_name().to_owned(),
        reader.read_password(service, account)?,
    ))
}

pub fn load_brokered_credential(
    reader: &dyn KeychainReader,
    lease: &CredentialLease,
    verifier: &CredentialVerifier<'_>,
) -> RuntimeResult<(String, String)> {
    lease.verify(verifier)?;
    load_cli_credential(reader, lease.provider)
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fake;
    impl KeychainReader for Fake {
        fn read_password(&self, _: &str, _: &str) -> RuntimeResult<String> {
            Ok("secret".into())
        }
    }
    #[test]
    fn provider_env_is_explicit() {
        let (n, v) = load_cli_credential(&Fake, ProviderCredential::ClaudeApiKey).unwrap();
        assert_eq!(n, "ANTHROPIC_API_KEY");
        assert_eq!(v, "secret");
    }

    #[test]
    fn provider_reference_is_namespace_bound() {
        let (n, _) = load_cli_credential(&Fake, ProviderCredential::ClaudeApiKey).unwrap();
        assert_eq!(n, "ANTHROPIC_API_KEY");
    }

    #[test]
    fn brokered_lease_is_scoped_and_single_use() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let run_id = Uuid::new_v4();
        let device_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        let grant_id = Uuid::new_v4();
        let now = Utc::now();
        let lease = CredentialLease::issue(
            CredentialLeaseSpec {
                run_id,
                device_id,
                project_id,
                grant_id,
                provider: ProviderCredential::ClaudeApiKey,
                issued_at: now,
                expires_at: now + chrono::Duration::minutes(1),
                nonce: [9; 32],
            },
            &key,
        )
        .unwrap();
        let replay = CredentialReplayGuard::default();
        let verifier = CredentialVerifier {
            now,
            scope: CredentialScope {
                run_id,
                device_id,
                project_id,
                grant_id,
            },
            trusted_backend_key: &key.verifying_key(),
            replay_guard: &replay,
        };
        lease.verify(&verifier).unwrap();
        assert!(lease.verify(&verifier).is_err());
        let wrong_scope = CredentialVerifier {
            scope: CredentialScope {
                project_id: Uuid::new_v4(),
                ..verifier.scope
            },
            replay_guard: &CredentialReplayGuard::default(),
            ..verifier
        };
        assert!(lease.verify(&wrong_scope).is_err());
    }
}
