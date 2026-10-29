use crate::sandbox::ProbeResult;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use crate::error::{RuntimeError, RuntimeResult};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeConnectionState {
    Online,
    Offline,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceIdentity {
    pub device_id: Uuid,
    pub public_key: [u8; 32],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OutboundRequest {
    pub request_id: Uuid,
    pub device_id: Uuid,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub nonce: [u8; 32],
    pub body: OutboundBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum OutboundBody {
    Heartbeat {
        lease_id: Uuid,
    },
    MetadataBatch {
        items: Vec<crate::metadata::CloudSessionMetadata>,
    },
    SearchResult {
        request_id: Uuid,
        hit_count: u32,
    },
    RunEvent {
        run_id: Uuid,
        state: String,
    },
    IsolationAttestation {
        grant_id: Uuid,
        project_id: Uuid,
        nonce: String,
        evidence: ProbeResult,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignedOutboundRequest {
    pub request: OutboundRequest,
    pub signed_payload: String,
    pub public_key: [u8; 32],
    pub signature: Vec<u8>,
}

impl DeviceIdentity {
    pub fn from_signing_key(device_id: Uuid, key: &SigningKey) -> Self {
        Self {
            device_id,
            public_key: key.verifying_key().to_bytes(),
        }
    }

    pub fn generate() -> (Self, SigningKey) {
        let key = SigningKey::from_bytes(&rand::random::<[u8; 32]>());
        (Self::from_signing_key(Uuid::new_v4(), &key), key)
    }

    pub fn public_key_base64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.public_key)
    }
}

#[derive(Clone, Default)]
pub struct ReplayGuard {
    seen_nonces: Arc<Mutex<HashSet<[u8; 32]>>>,
}

impl ReplayGuard {
    pub fn accept_once(
        &self,
        envelope: &SignedOutboundRequest,
        now: DateTime<Utc>,
        identity: &DeviceIdentity,
    ) -> RuntimeResult<()> {
        envelope.verify(now, identity)?;
        let mut seen = self.seen_nonces.lock().unwrap();
        if !seen.insert(envelope.request.nonce) {
            return Err(RuntimeError::AdapterUnavailable(
                "replayed request nonce".into(),
            ));
        }
        Ok(())
    }
}

impl SignedOutboundRequest {
    pub fn sign(request: OutboundRequest, key: &SigningKey) -> RuntimeResult<Self> {
        let public_key = key.verifying_key().to_bytes();
        let signed_payload = serde_json::to_string(&request)?;
        let bytes = signed_payload.as_bytes();
        let signature = key.sign(bytes).to_bytes();
        Ok(Self {
            request,
            signed_payload,
            public_key,
            signature: signature.to_vec(),
        })
    }

    pub fn verify(&self, now: DateTime<Utc>, identity: &DeviceIdentity) -> RuntimeResult<()> {
        if self.request.device_id != identity.device_id || self.public_key != identity.public_key {
            return Err(RuntimeError::AdapterUnavailable(
                "device binding mismatch".into(),
            ));
        }
        if self.request.expires_at <= now || self.request.issued_at > now {
            return Err(RuntimeError::AdapterUnavailable(
                "request expired or issued in the future".into(),
            ));
        }
        let verifying_key = VerifyingKey::from_bytes(&self.public_key)
            .map_err(|_| RuntimeError::AdapterUnavailable("invalid device public key".into()))?;
        let signature_bytes: [u8; 64] = self
            .signature
            .as_slice()
            .try_into()
            .map_err(|_| RuntimeError::AdapterUnavailable("invalid signature length".into()))?;
        let signature = Signature::from_bytes(&signature_bytes);
        let bytes = self.signed_payload.as_bytes();
        if self.signed_payload
            != serde_json::to_string(&self.request).map_err(|_| {
                RuntimeError::AdapterUnavailable("invalid signed request payload".into())
            })?
        {
            return Err(RuntimeError::AdapterUnavailable(
                "signed payload mismatch".into(),
            ));
        }
        verifying_key
            .verify(bytes, &signature)
            .map_err(|_| RuntimeError::AdapterUnavailable("invalid request signature".into()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelAvailability {
    Online,
    Offline,
}

#[derive(Debug, Clone, Copy)]
pub struct RuntimeChannel {
    availability: ChannelAvailability,
}

impl RuntimeChannel {
    pub fn online() -> Self {
        Self {
            availability: ChannelAvailability::Online,
        }
    }
    pub fn offline() -> Self {
        Self {
            availability: ChannelAvailability::Offline,
        }
    }
    pub fn availability(&self) -> ChannelAvailability {
        self.availability
    }
    pub fn require_online(&self) -> RuntimeResult<()> {
        match self.availability {
            ChannelAvailability::Online => Ok(()),
            ChannelAvailability::Offline => Err(RuntimeError::Offline),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeaseEnvelope {
    pub run_id: Uuid,
    pub device_id: Uuid,
    pub lease_id: Uuid,
    pub lease_until: DateTime<Utc>,
    pub task: String,
}
