use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::adapter::AdapterKind;
use crate::discovery::SessionEvent;
use crate::error::RuntimeResult;
use crate::metadata::LocalSessionMetadata;
use crate::runs::{RunPersistence, RunRecord, RunState};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSearchHit {
    pub session_id: Uuid,
    pub seq: u64,
    pub project_id: Uuid,
    pub source_ref: String,
    pub snippet: String,
}

pub struct LocalStore {
    connection: Connection,
}

impl LocalStore {
    pub fn open_in_memory() -> RuntimeResult<Self> {
        let connection = Connection::open_in_memory()?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<std::path::Path>) -> RuntimeResult<Self> {
        let connection = Connection::open(path)?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    pub fn migrate(&self) -> RuntimeResult<()> {
        self.connection.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS local_agent_sessions (
               session_index_id TEXT PRIMARY KEY,
               native_session_id TEXT NOT NULL,
               local_session_ref TEXT NOT NULL,
               project_id TEXT NOT NULL,
               adapter TEXT NOT NULL,
               source_revision INTEGER NOT NULL,
               started_at TEXT,
               last_activity_at TEXT,
               state TEXT NOT NULL,
               message_count INTEGER NOT NULL DEFAULT 0,
               deleted_at TEXT
             );
             CREATE TABLE IF NOT EXISTS local_agent_messages (
               session_index_id TEXT NOT NULL,
               seq INTEGER NOT NULL,
               role TEXT NOT NULL,
               content TEXT NOT NULL,
               occurred_at TEXT,
               source_ref TEXT NOT NULL,
               PRIMARY KEY (session_index_id, seq),
               FOREIGN KEY (session_index_id) REFERENCES local_agent_sessions(session_index_id)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS local_agent_messages_fts USING fts5(
               content, session_index_id UNINDEXED, seq UNINDEXED, project_id UNINDEXED, source_ref UNINDEXED,
               tokenize = 'unicode61'
             );
             CREATE TABLE IF NOT EXISTS local_sync_outbox (
               session_index_id TEXT PRIMARY KEY,
               metadata_json TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS local_agent_runs (
               run_id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               adapter TEXT NOT NULL,
               status TEXT NOT NULL,
               lease_id TEXT,
               lease_until TEXT,
               cancellation_requested INTEGER NOT NULL DEFAULT 0,
               record_json TEXT NOT NULL DEFAULT '{}'
             );"
        )?;
        let has_record_json: bool = self.connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('local_agent_runs') WHERE name='record_json'",
            [],
            |row| row.get::<_, i64>(0),
        )? == 1;
        if !has_record_json {
            self.connection.execute(
                "ALTER TABLE local_agent_runs ADD COLUMN record_json TEXT NOT NULL DEFAULT '{}'",
                [],
            )?;
        }
        Ok(())
    }

    pub fn upsert_session(&self, metadata: &LocalSessionMetadata) -> RuntimeResult<()> {
        self.connection.execute(
            "INSERT INTO local_agent_sessions
             (session_index_id,native_session_id,local_session_ref,project_id,adapter,source_revision,started_at,last_activity_at,state,message_count,deleted_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL)
             ON CONFLICT(session_index_id) DO UPDATE SET
               source_revision=excluded.source_revision, last_activity_at=excluded.last_activity_at,
               state=excluded.state, message_count=excluded.message_count, deleted_at=NULL",
            params![metadata.session_index_id.to_string(), metadata.native_session_id, metadata.local_session_ref,
                    metadata.project_id.to_string(), metadata.adapter, metadata.source_revision,
                    metadata.started_at.map(|x| x.to_rfc3339()), metadata.last_activity_at.map(|x| x.to_rfc3339()),
                    metadata.state, metadata.message_count],
        )?;
        Ok(())
    }

    pub fn index_events(
        &self,
        session_id: Uuid,
        project_id: Uuid,
        events: &[SessionEvent],
    ) -> RuntimeResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for event in events {
            let source_ref = format!("{}:{}", session_id, event.seq);
            transaction.execute(
                "INSERT OR REPLACE INTO local_agent_messages(session_index_id,seq,role,content,occurred_at,source_ref)
                 VALUES (?1,?2,?3,?4,?5,?6)",
                params![session_id.to_string(), event.seq, event.role, event.content,
                        event.occurred_at.map(|x| x.to_rfc3339()), source_ref],
            )?;
            transaction.execute(
                "DELETE FROM local_agent_messages_fts WHERE session_index_id=?1 AND seq=?2",
                params![session_id.to_string(), event.seq],
            )?;
            transaction.execute(
                "INSERT INTO local_agent_messages_fts(content,session_index_id,seq,project_id,source_ref)
                 VALUES (?1,?2,?3,?4,?5)",
                params![event.content, session_id.to_string(), event.seq, project_id.to_string(), source_ref],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn tombstone_session(&self, session_id: Uuid, at: DateTime<Utc>) -> RuntimeResult<()> {
        self.connection.execute(
            "UPDATE local_agent_sessions SET deleted_at=?2,state='deleted' WHERE session_index_id=?1",
            params![session_id.to_string(), at.to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn search(
        &self,
        query: &str,
        allowed_projects: &[Uuid],
        limit: usize,
    ) -> RuntimeResult<Vec<LocalSearchHit>> {
        if allowed_projects.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self.connection.prepare(
            "SELECT f.session_index_id, f.seq, f.project_id, f.source_ref,
                    snippet(local_agent_messages_fts, 0, '[', ']', '…', 12)
             FROM local_agent_messages_fts f
             JOIN local_agent_sessions s ON s.session_index_id=f.session_index_id
             WHERE local_agent_messages_fts MATCH ?1 AND s.deleted_at IS NULL
             ORDER BY rank LIMIT ?2",
        )?;
        let mut rows = statement.query(params![query, limit as i64])?;
        let mut hits = Vec::new();
        while let Some(row) = rows.next()? {
            let project_id =
                Uuid::parse_str(row.get::<_, String>(2)?.as_str()).unwrap_or(Uuid::nil());
            if allowed_projects.contains(&project_id) {
                hits.push(LocalSearchHit {
                    session_id: Uuid::parse_str(row.get::<_, String>(0)?.as_str())
                        .unwrap_or(Uuid::nil()),
                    seq: row.get::<_, i64>(1)? as u64,
                    project_id,
                    source_ref: row.get(3)?,
                    snippet: row.get(4)?,
                });
            }
        }
        Ok(hits)
    }

    pub fn queue_cloud_metadata(
        &self,
        metadata: &crate::metadata::CloudSessionMetadata,
    ) -> RuntimeResult<()> {
        let json = serde_json::to_string(metadata)?;
        self.connection.execute(
            "INSERT OR REPLACE INTO local_sync_outbox(session_index_id,metadata_json,created_at) VALUES (?1,?2,?3)",
            params![metadata.session_index_id.to_string(), json, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn cloud_outbox_json(&self, session_id: Uuid) -> RuntimeResult<Option<String>> {
        Ok(self
            .connection
            .query_row(
                "SELECT metadata_json FROM local_sync_outbox WHERE session_index_id=?1",
                params![session_id.to_string()],
                |row| row.get(0),
            )
            .optional()?)
    }
}

/// Durable run state backed by the same local SQLite schema used by session data.
/// It deliberately stores the redacted task record only; process output remains local
/// to the supervised child and is never part of the persistence payload.
pub struct DurableRunStore {
    path: PathBuf,
}

impl DurableRunStore {
    pub fn open(path: impl AsRef<Path>) -> RuntimeResult<Self> {
        let store = Self {
            path: path.as_ref().to_path_buf(),
        };
        let connection = Connection::open(&store.path)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_agent_runs (
               run_id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               adapter TEXT NOT NULL,
               status TEXT NOT NULL,
               lease_id TEXT,
               lease_until TEXT,
               cancellation_requested INTEGER NOT NULL DEFAULT 0,
               record_json TEXT NOT NULL DEFAULT '{}'
             );",
        )?;
        let has_record_json: bool = connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('local_agent_runs') WHERE name='record_json'",
            [],
            |row| row.get::<_, i64>(0),
        )? == 1;
        if !has_record_json {
            connection.execute(
                "ALTER TABLE local_agent_runs ADD COLUMN record_json TEXT NOT NULL DEFAULT '{}'",
                [],
            )?;
        }
        Ok(store)
    }

    fn connection(&self) -> RuntimeResult<Connection> {
        Ok(Connection::open(&self.path)?)
    }
}

impl RunPersistence for DurableRunStore {
    fn save(&self, record: &RunRecord) -> RuntimeResult<()> {
        let connection = self.connection()?;
        let json = serde_json::to_string(&run_record_json(record))?;
        connection.execute(
            "INSERT INTO local_agent_runs
             (run_id,project_id,adapter,status,lease_id,lease_until,cancellation_requested,record_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(run_id) DO UPDATE SET
               project_id=excluded.project_id, adapter=excluded.adapter, status=excluded.status,
               lease_id=excluded.lease_id, lease_until=excluded.lease_until,
               cancellation_requested=excluded.cancellation_requested, record_json=excluded.record_json",
            params![
                record.run_id.to_string(),
                record.project_id.to_string(),
                adapter_name(record.adapter),
                record.state.to_string(),
                record.lease_id.map(|id| id.to_string()),
                record.lease_until.map(|value| value.to_rfc3339()),
                record.cancellation_requested as i64,
                json,
            ],
        )?;
        Ok(())
    }

    fn restore_after_restart(&self) -> RuntimeResult<Vec<RunRecord>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("SELECT record_json FROM local_agent_runs")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut restored = Vec::new();
        for row in rows {
            let json = row?;
            if json == "{}" {
                continue;
            }
            let mut record = run_record_from_json(&serde_json::from_str(&json)?)?;
            if matches!(
                record.state,
                RunState::Queued
                    | RunState::Starting
                    | RunState::Running
                    | RunState::WaitingApproval
            ) {
                record.state = RunState::Failed;
                record.lease_id = None;
                record.lease_until = None;
                record.cancellation_requested = false;
                let updated = serde_json::to_string(&run_record_json(&record))?;
                connection.execute(
                    "UPDATE local_agent_runs SET status='failed', lease_id=NULL, lease_until=NULL, cancellation_requested=0, record_json=?2 WHERE run_id=?1",
                    params![record.run_id.to_string(), updated],
                )?;
            }
            restored.push(record);
        }
        Ok(restored)
    }
}

fn adapter_name(adapter: AdapterKind) -> &'static str {
    match adapter {
        AdapterKind::ClaudeCode => "claude_code",
        AdapterKind::CodexCli => "codex_cli",
    }
}

fn parse_adapter(value: &str) -> RuntimeResult<AdapterKind> {
    match value {
        "claude_code" => Ok(AdapterKind::ClaudeCode),
        "codex_cli" => Ok(AdapterKind::CodexCli),
        other => Err(crate::error::RuntimeError::Channel(format!(
            "invalid persisted adapter: {other}"
        ))),
    }
}

fn run_record_json(record: &RunRecord) -> serde_json::Value {
    serde_json::json!({
        "run_id": record.run_id,
        "idempotency_key": record.idempotency_key,
        "project_id": record.project_id,
        "adapter": adapter_name(record.adapter),
        "task": record.task,
        "state": record.state.to_string(),
        "lease_id": record.lease_id,
        "lease_until": record.lease_until.map(|value| value.to_rfc3339()),
        "cancellation_requested": record.cancellation_requested,
    })
}

fn run_record_from_json(value: &serde_json::Value) -> RuntimeResult<RunRecord> {
    let get = |key: &str| {
        value.get(key).ok_or_else(|| {
            crate::error::RuntimeError::Channel(format!("missing persisted run field: {key}"))
        })
    };
    let state = match get("state")?.as_str().unwrap_or_default() {
        "queued" => RunState::Queued,
        "starting" => RunState::Starting,
        "running" => RunState::Running,
        "waiting_approval" => RunState::WaitingApproval,
        "completed" => RunState::Completed,
        "failed" => RunState::Failed,
        "cancelled" => RunState::Cancelled,
        "expired" => RunState::Expired,
        other => {
            return Err(crate::error::RuntimeError::Channel(format!(
                "invalid persisted run state: {other}"
            )))
        }
    };
    let parse_uuid = |key: &str| -> RuntimeResult<Uuid> {
        Uuid::parse_str(get(key)?.as_str().unwrap_or_default()).map_err(|_| {
            crate::error::RuntimeError::Channel(format!("invalid persisted run uuid: {key}"))
        })
    };
    let lease_id = value
        .get("lease_id")
        .and_then(|item| item.as_str())
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| crate::error::RuntimeError::Channel("invalid persisted lease id".into()))?;
    let lease_until = value
        .get("lease_until")
        .and_then(|item| item.as_str())
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| crate::error::RuntimeError::Channel("invalid persisted lease time".into()))?
        .map(|value| value.with_timezone(&Utc));
    Ok(RunRecord {
        run_id: parse_uuid("run_id")?,
        idempotency_key: get("idempotency_key")?
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        project_id: parse_uuid("project_id")?,
        adapter: parse_adapter(get("adapter")?.as_str().unwrap_or_default())?,
        task: get("task")?.as_str().unwrap_or_default().to_owned(),
        state,
        lease_id,
        lease_until,
        cancellation_requested: value
            .get("cancellation_requested")
            .and_then(|item| item.as_bool())
            .unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_fts_returns_only_allowed_project_hits() {
        let store = LocalStore::open_in_memory().unwrap();
        let project = Uuid::new_v4();
        let other = Uuid::new_v4();
        let session = LocalSessionMetadata {
            session_index_id: Uuid::new_v4(),
            native_session_id: "native".into(),
            local_session_ref: "/tmp/local".into(),
            project_id: project,
            adapter: "codex_cli".into(),
            source_revision: 1,
            started_at: None,
            last_activity_at: None,
            state: "active".into(),
            message_count: 1,
        };
        store.upsert_session(&session).unwrap();
        store
            .index_events(
                session.session_index_id,
                project,
                &[SessionEvent {
                    seq: 1,
                    role: "assistant".into(),
                    content: "secret project text".into(),
                    occurred_at: None,
                }],
            )
            .unwrap();
        assert_eq!(store.search("secret", &[other], 10).unwrap().len(), 0);
        assert_eq!(store.search("secret", &[project], 10).unwrap().len(), 1);
    }

    #[test]
    fn cloud_outbox_contains_allowlisted_metadata_only() {
        let store = LocalStore::open_in_memory().unwrap();
        let metadata = crate::metadata::CloudSessionMetadata {
            session_index_id: Uuid::new_v4(),
            device_id: Uuid::new_v4(),
            project_id: None,
            adapter: "claude_code".into(),
            started_at: None,
            last_activity_at: None,
            state: "active".into(),
            message_count: Some(2),
        };
        store.queue_cloud_metadata(&metadata).unwrap();
        let json = store
            .cloud_outbox_json(metadata.session_index_id)
            .unwrap()
            .unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("content"));
        assert!(!json.contains("path"));
    }
}
