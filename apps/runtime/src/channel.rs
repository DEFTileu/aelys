use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use crate::credentials::{CredentialLease, ProviderCredential};
use crate::error::{RuntimeError, RuntimeResult};
use crate::protocol::{DeviceIdentity, OutboundBody, OutboundRequest, SignedOutboundRequest};
use crate::sandbox::ProbeResult;
use chrono::{Duration as ChronoDuration, Utc};
use ed25519_dalek::SigningKey;
use uuid::Uuid;

/// Outbound backend channel client. The bearer token is device-bound and must
/// be supplied by the enrollment flow; no provider or CLI secret is accepted.
#[derive(Debug, Clone)]
pub struct BackendChannelClient {
    endpoint: String,
    access_token: String,
}

impl BackendChannelClient {
    pub fn new(endpoint: impl Into<String>, access_token: impl Into<String>) -> Self {
        Self {
            endpoint: endpoint.into(),
            access_token: access_token.into(),
        }
    }

    pub async fn heartbeat(&self) -> RuntimeResult<()> {
        let mut socket = self.connect().await?;
        socket
            .send(Message::Text(
                json!({"type":"heartbeat"}).to_string().into(),
            ))
            .await
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        let ack = timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| RuntimeError::Offline)?;
        match ack {
            Some(Ok(Message::Text(value)))
                if serde_json::from_str::<Value>(&value)
                    .ok()
                    .map(|v| v.get("type").and_then(Value::as_str) == Some("heartbeat_ack"))
                    .unwrap_or(false) =>
            {
                Ok(())
            }
            _ => Err(RuntimeError::Channel(
                "backend heartbeat was not acknowledged".into(),
            )),
        }
    }

    pub async fn send_metadata(&self, items: Vec<Value>) -> RuntimeResult<()> {
        let message = Self::metadata_message(items)?;
        let mut socket = self.connect().await?;
        socket
            .send(Message::Text(message.into()))
            .await
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        let ack = timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| RuntimeError::Offline)?;
        match ack {
            Some(Ok(Message::Text(value)))
                if serde_json::from_str::<Value>(&value)
                    .ok()
                    .map(|v| v.get("type").and_then(Value::as_str) == Some("metadata_ack"))
                    .unwrap_or(false) =>
            {
                Ok(())
            }
            _ => Err(RuntimeError::Channel(
                "backend metadata was not acknowledged".into(),
            )),
        }
    }

    pub async fn send_run_event(
        &self,
        run_id: &str,
        lease_id: &str,
        state: &str,
        error_code: Option<&str>,
    ) -> RuntimeResult<()> {
        let mut socket = self.connect().await?;
        socket
            .send(Message::Text(
                Self::run_event_message(run_id, lease_id, state, error_code).into(),
            ))
            .await
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        let ack = timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| RuntimeError::Offline)?;
        match ack {
            Some(Ok(Message::Text(value)))
                if serde_json::from_str::<Value>(&value)
                    .ok()
                    .map(|v| v.get("type").and_then(Value::as_str) == Some("run_event_ack"))
                    .unwrap_or(false) =>
            {
                Ok(())
            }
            _ => Err(RuntimeError::Channel(
                "backend run event was not acknowledged".into(),
            )),
        }
    }

    pub async fn claim_run(&self, run_id: &str) -> RuntimeResult<String> {
        self.request_run_message("run_claim", run_id, None).await
    }

    pub async fn request_credential_lease(
        &self,
        run_id: &str,
        project_id: &str,
        grant_id: &str,
        provider: ProviderCredential,
    ) -> RuntimeResult<CredentialLease> {
        let mut socket = self.connect().await?;
        socket
            .send(Message::Text(
                json!({"type":"credential_lease","run_id":run_id,"project_id":project_id,"grant_id":grant_id,"provider":provider})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        let response = timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| RuntimeError::Offline)?;
        match response {
            Some(Ok(Message::Text(value))) => {
                let parsed: Value = serde_json::from_str(&value)
                    .map_err(|e| RuntimeError::Channel(e.to_string()))?;
                if parsed.get("type").and_then(Value::as_str) != Some("credential_lease_ack") {
                    return Err(RuntimeError::Channel(value.to_string()));
                }
                serde_json::from_value(parsed.get("lease").cloned().ok_or_else(|| {
                    RuntimeError::Channel("credential lease response missing lease".into())
                })?)
                .map_err(|e| RuntimeError::Channel(e.to_string()))
            }
            _ => Err(RuntimeError::Channel(
                "backend credential lease response missing".into(),
            )),
        }
    }

    pub async fn heartbeat_run(&self, run_id: &str, lease_id: &str) -> RuntimeResult<String> {
        self.request_run_message("run_heartbeat", run_id, Some(lease_id))
            .await
    }

    pub async fn cancel_run(&self, run_id: &str, lease_id: &str) -> RuntimeResult<String> {
        self.request_run_message("run_cancel", run_id, Some(lease_id))
            .await
    }

    async fn request_run_message(
        &self,
        kind: &str,
        run_id: &str,
        lease_id: Option<&str>,
    ) -> RuntimeResult<String> {
        let mut socket = self.connect().await?;
        socket
            .send(Message::Text(
                json!({"type":kind,"run_id":run_id,"lease_id":lease_id})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        let response = timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| RuntimeError::Offline)?;
        match response {
            Some(Ok(Message::Text(value))) => {
                let parsed: Value = serde_json::from_str(&value)
                    .map_err(|e| RuntimeError::Channel(e.to_string()))?;
                if parsed
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|t| t.ends_with("_ack"))
                    .unwrap_or(false)
                {
                    Ok(value.to_string())
                } else {
                    Err(RuntimeError::Channel(value.to_string()))
                }
            }
            _ => Err(RuntimeError::Channel(
                "backend run lease response missing".into(),
            )),
        }
    }

    pub async fn send_isolation_attestation(&self, envelope_json: &str) -> RuntimeResult<()> {
        let envelope: Value = serde_json::from_str(envelope_json)
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        let mut socket = self.connect().await?;
        socket
            .send(Message::Text(
                json!({"type":"isolation_attestation","envelope":envelope})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        let ack = timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| RuntimeError::Offline)?;
        match ack {
            Some(Ok(Message::Text(value)))
                if serde_json::from_str::<Value>(&value)
                    .ok()
                    .map(|v| {
                        v.get("type").and_then(Value::as_str) == Some("isolation_attestation_ack")
                    })
                    .unwrap_or(false) =>
            {
                Ok(())
            }
            Some(Ok(Message::Text(value))) => Err(RuntimeError::Channel(format!(
                "backend isolation attestation was not acknowledged: {value}"
            ))),
            _ => Err(RuntimeError::Channel(
                "backend isolation attestation was not acknowledged".into(),
            )),
        }
    }

    async fn connect(
        &self,
    ) -> RuntimeResult<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    > {
        if !Self::endpoint_allowed(&self.endpoint) {
            return Err(RuntimeError::Channel(
                "runtime channel requires wss://; ws:// is limited to loopback development".into(),
            ));
        }
        let mut request = self
            .endpoint
            .clone()
            .into_client_request()
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        request.headers_mut().insert(
            "authorization",
            format!("Bearer {}", self.access_token)
                .parse()
                .map_err(|_| RuntimeError::Channel("invalid authorization header".into()))?,
        );
        let (mut socket, _) = connect_async(request)
            .await
            .map_err(|e| RuntimeError::Channel(e.to_string()))?;
        let ready = timeout(Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| RuntimeError::Offline)?;
        match ready {
            Some(Ok(Message::Text(value)))
                if serde_json::from_str::<Value>(&value)
                    .ok()
                    .map(|v| v.get("type").and_then(Value::as_str) == Some("ready"))
                    .unwrap_or(false) => {}
            _ => {
                return Err(RuntimeError::Channel(
                    "backend channel handshake failed".into(),
                ))
            }
        }
        Ok(socket)
    }

    fn endpoint_allowed(endpoint: &str) -> bool {
        endpoint.starts_with("wss://")
            || endpoint.starts_with("ws://127.0.0.1")
            || endpoint.starts_with("ws://localhost")
            || endpoint.starts_with("ws://[::1]")
    }

    pub fn metadata_message(items: Vec<Value>) -> RuntimeResult<String> {
        for item in &items {
            let allowed = [
                "session_index_id",
                "device_id",
                "project_id",
                "adapter",
                "started_at",
                "last_activity_at",
                "state",
                "message_count",
            ];
            if item
                .as_object()
                .map(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
                .unwrap_or(true)
            {
                return Err(RuntimeError::Channel(
                    "metadata contains a non-allowlisted field".into(),
                ));
            }
        }
        Ok(json!({"type":"metadata_batch","items":items}).to_string())
    }

    pub fn run_event_message(
        run_id: &str,
        lease_id: &str,
        state: &str,
        error_code: Option<&str>,
    ) -> String {
        let mut value =
            json!({"type":"run_event","run_id":run_id,"lease_id":lease_id,"state":state});
        if let Some(code) = error_code {
            value["error_code"] = Value::String(code.to_owned());
        }
        value.to_string()
    }

    pub fn isolation_attestation_message(
        identity: &DeviceIdentity,
        key: &SigningKey,
        grant_id: Uuid,
        project_id: Uuid,
        nonce: String,
        evidence: ProbeResult,
    ) -> RuntimeResult<String> {
        let now = Utc::now();
        let request = OutboundRequest {
            request_id: Uuid::new_v4(),
            device_id: identity.device_id,
            issued_at: now,
            expires_at: now + ChronoDuration::minutes(5),
            nonce: rand::random(),
            body: OutboundBody::IsolationAttestation {
                grant_id,
                project_id,
                nonce,
                evidence,
            },
        };
        serde_json::to_string(&SignedOutboundRequest::sign(request, key)?)
            .map_err(RuntimeError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_message_rejects_content_fields() {
        let result = BackendChannelClient::metadata_message(vec![
            json!({"session_index_id":"s","content":"private"}),
        ]);
        assert!(result.is_err());
    }

    #[test]
    fn run_event_contains_only_redacted_status() {
        let message = BackendChannelClient::run_event_message("run", "lease", "completed", None);
        assert!(message.contains("completed"));
        assert!(!message.contains("transcript"));
    }

    #[test]
    fn channel_endpoint_requires_tls_outside_loopback() {
        assert!(BackendChannelClient::endpoint_allowed(
            "wss://example.test/channel"
        ));
        assert!(BackendChannelClient::endpoint_allowed(
            "ws://127.0.0.1:8000/channel"
        ));
        assert!(!BackendChannelClient::endpoint_allowed(
            "ws://example.test/channel"
        ));
    }
}
