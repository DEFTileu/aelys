use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Cloud-safe allowlist. Adding a content field here requires an explicit ADR.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CloudSessionMetadata {
    pub session_index_id: Uuid,
    pub device_id: Uuid,
    pub project_id: Option<Uuid>,
    pub adapter: String,
    pub started_at: Option<DateTime<Utc>>,
    pub last_activity_at: Option<DateTime<Utc>>,
    pub state: String,
    pub message_count: Option<u64>,
}

impl CloudSessionMetadata {
    pub fn to_cloud_json(&self) -> serde_json::Result<serde_json::Value> {
        serde_json::to_value(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalSessionMetadata {
    pub session_index_id: Uuid,
    pub native_session_id: String,
    pub local_session_ref: String,
    pub project_id: Uuid,
    pub adapter: String,
    pub source_revision: u64,
    pub started_at: Option<DateTime<Utc>>,
    pub last_activity_at: Option<DateTime<Utc>>,
    pub state: String,
    pub message_count: u64,
}

impl LocalSessionMetadata {
    pub fn cloud_projection(&self, device_id: Uuid) -> CloudSessionMetadata {
        CloudSessionMetadata {
            session_index_id: self.session_index_id,
            device_id,
            project_id: Some(self.project_id),
            adapter: self.adapter.clone(),
            started_at: self.started_at,
            last_activity_at: self.last_activity_at,
            state: self.state.clone(),
            message_count: Some(self.message_count),
        }
    }
}
