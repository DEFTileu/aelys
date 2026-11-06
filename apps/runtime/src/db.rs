use chrono::{DateTime, Utc};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
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

/// Metadata only. The caller must enforce an active source grant; project
/// membership by itself is not authorization to reveal a session.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LocalSessionSummary {
    pub session_index_id: Uuid,
    pub project_id: Uuid,
    pub adapter: String,
    pub started_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub state: String,
    pub message_count: u64,
}

/// A bounded message returned from an explicitly scoped local session read.
/// `content_truncated` is true when the message exceeded the response byte cap.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LocalSessionContentItem {
    pub seq: u64,
    pub role: String,
    pub content: String,
    pub occurred_at: Option<String>,
    pub content_truncated: bool,
    /// Resume at this character offset when truncated; `None` means this
    /// message is complete and subsequent pages start after its sequence.
    pub next_cursor: Option<LocalSessionCursor>,
}

/// Cursor used for keyset pagination and continuation within a long message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LocalSessionCursor {
    pub seq: u64,
    pub source_revision: u64,
    pub query_hash: Option<[u8; 32]>,
    /// `Some(n)` resumes within this message at Unicode character offset `n`.
    /// `None` resumes after this sequence.
    pub char_offset: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSessionReadRequest {
    pub project_id: Uuid,
    pub adapter: AdapterKind,
    pub session_id: Uuid,
    pub cursor: Option<LocalSessionCursor>,
    pub limit: usize,
    pub max_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalSessionSearchRequest {
    pub project_id: Uuid,
    pub adapter: AdapterKind,
    pub session_id: Uuid,
    pub query: String,
    pub cursor: Option<LocalSessionCursor>,
    pub limit: usize,
    pub max_bytes: usize,
}

/// A bounded excerpt found by literal substring matching in one scoped session.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LocalLiteralSearchHit {
    pub seq: u64,
    pub role: String,
    pub excerpt: String,
    pub excerpt_truncated: bool,
    pub next_cursor: Option<LocalSessionCursor>,
}

const MAX_LOCAL_CONTENT_ITEMS: usize = 100;
const MIN_LOCAL_CONTENT_BYTES: usize = 4;
const MAX_LOCAL_CONTENT_BYTES: usize = 64 * 1024;
const MAX_LOCAL_SEARCH_QUERY_BYTES: usize = 4 * 1024;

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
               content_generation INTEGER NOT NULL DEFAULT 1,
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
        let has_content_generation: bool = self.connection.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('local_agent_sessions') WHERE name='content_generation'",
            [], |row| row.get::<_, i64>(0),
        )? == 1;
        if !has_content_generation {
            self.connection.execute("ALTER TABLE local_agent_sessions ADD COLUMN content_generation INTEGER NOT NULL DEFAULT 1", [])?;
        }
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
        let changed = self.connection.execute(
            "INSERT INTO local_agent_sessions
             (session_index_id,native_session_id,local_session_ref,project_id,adapter,source_revision,started_at,last_activity_at,state,message_count,deleted_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL)
             ON CONFLICT(session_index_id) DO UPDATE SET
               source_revision=excluded.source_revision, last_activity_at=excluded.last_activity_at,
               state=excluded.state, message_count=excluded.message_count, deleted_at=NULL,
               content_generation=local_agent_sessions.content_generation+1
             WHERE local_agent_sessions.project_id=excluded.project_id
               AND local_agent_sessions.adapter=excluded.adapter
               AND local_agent_sessions.content_generation < 9223372036854775807",
            params![metadata.session_index_id.to_string(), metadata.native_session_id, metadata.local_session_ref,
                    metadata.project_id.to_string(), metadata.adapter, metadata.source_revision,
                    metadata.started_at.map(|x| x.to_rfc3339()), metadata.last_activity_at.map(|x| x.to_rfc3339()),
                    metadata.state, metadata.message_count],
        )?;
        if changed != 1 {
            return Err(crate::error::RuntimeError::UnauthorizedPath);
        }
        Ok(())
    }

    pub fn index_events(
        &self,
        session_id: Uuid,
        project_id: Uuid,
        events: &[SessionEvent],
    ) -> RuntimeResult<()> {
        if events.iter().any(|event| event.content.contains('\0')) {
            return Err(crate::error::RuntimeError::Channel(
                "unsupported session text".into(),
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        if transaction.execute("UPDATE local_agent_sessions SET content_generation=content_generation+1 WHERE session_index_id=?1 AND project_id=?2 AND deleted_at IS NULL AND content_generation < 9223372036854775807", params![session_id.to_string(), project_id.to_string()])? != 1 {
            return Err(crate::error::RuntimeError::UnauthorizedPath);
        }
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

    /// Replace a complete parsed snapshot. Unlike `index_events`, this removes
    /// events no longer present when a source file is truncated or rewritten.
    pub fn replace_session_events(
        &self,
        session_id: Uuid,
        project_id: Uuid,
        events: &[SessionEvent],
    ) -> RuntimeResult<()> {
        if events.iter().any(|event| event.content.contains('\0')) {
            return Err(crate::error::RuntimeError::Channel(
                "unsupported session text".into(),
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        let belongs_to_project: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_agent_sessions WHERE session_index_id=?1 AND project_id=?2 AND deleted_at IS NULL)",
            params![session_id.to_string(), project_id.to_string()],
            |row| row.get(0),
        )?;
        if !belongs_to_project {
            return Err(crate::error::RuntimeError::UnauthorizedPath);
        }
        if transaction.execute("UPDATE local_agent_sessions SET content_generation=content_generation+1 WHERE session_index_id=?1 AND content_generation < 9223372036854775807", params![session_id.to_string()])? != 1 {
            return Err(crate::error::RuntimeError::UnauthorizedPath);
        }
        transaction.execute(
            "DELETE FROM local_agent_messages_fts WHERE session_index_id=?1",
            params![session_id.to_string()],
        )?;
        transaction.execute(
            "DELETE FROM local_agent_messages WHERE session_index_id=?1",
            params![session_id.to_string()],
        )?;
        for event in events {
            let source_ref = format!("{}:{}", session_id, event.seq);
            transaction.execute(
                "INSERT INTO local_agent_messages(session_index_id,seq,role,content,occurred_at,source_ref) VALUES (?1,?2,?3,?4,?5,?6)",
                params![session_id.to_string(), event.seq, event.role, event.content, event.occurred_at.map(|x| x.to_rfc3339()), source_ref],
            )?;
            transaction.execute(
                "INSERT INTO local_agent_messages_fts(content,session_index_id,seq,project_id,source_ref) VALUES (?1,?2,?3,?4,?5)",
                params![event.content, session_id.to_string(), event.seq, project_id.to_string(), source_ref],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Commit metadata and the corresponding complete message snapshot together.
    /// A failed parse must never be passed as an empty successful snapshot.
    pub fn store_session_snapshot(
        &self,
        metadata: &LocalSessionMetadata,
        events: &[SessionEvent],
    ) -> RuntimeResult<()> {
        if metadata.message_count != events.len() as u64
            || events.iter().any(|event| event.content.contains('\0'))
        {
            return Err(crate::error::RuntimeError::Channel(
                "snapshot count mismatch".into(),
            ));
        }
        let transaction = self.connection.unchecked_transaction()?;
        let session_id = metadata.session_index_id.to_string();
        let project_id = metadata.project_id.to_string();
        let existing_project: Option<String> = transaction
            .query_row(
                "SELECT project_id FROM local_agent_sessions WHERE session_index_id=?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing_project
            .as_deref()
            .is_some_and(|id| id != project_id)
        {
            return Err(crate::error::RuntimeError::UnauthorizedPath);
        }
        if existing_project.is_some() && transaction.execute("UPDATE local_agent_sessions SET content_generation=content_generation+1 WHERE session_index_id=?1 AND content_generation < 9223372036854775807", params![session_id])? != 1 {
            return Err(crate::error::RuntimeError::UnauthorizedPath);
        }
        transaction.execute(
            "INSERT INTO local_agent_sessions
             (session_index_id,native_session_id,local_session_ref,project_id,adapter,source_revision,started_at,last_activity_at,state,message_count,deleted_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL)
             ON CONFLICT(session_index_id) DO UPDATE SET
               native_session_id=excluded.native_session_id, local_session_ref=excluded.local_session_ref,
               adapter=excluded.adapter, source_revision=excluded.source_revision, started_at=excluded.started_at,
               last_activity_at=excluded.last_activity_at, state=excluded.state, message_count=excluded.message_count, deleted_at=NULL",
            params![session_id, metadata.native_session_id, metadata.local_session_ref, project_id,
                metadata.adapter, metadata.source_revision, metadata.started_at.map(|x| x.to_rfc3339()),
                metadata.last_activity_at.map(|x| x.to_rfc3339()), metadata.state, metadata.message_count],
        )?;
        transaction.execute(
            "DELETE FROM local_agent_messages_fts WHERE session_index_id=?1",
            params![session_id],
        )?;
        transaction.execute(
            "DELETE FROM local_agent_messages WHERE session_index_id=?1",
            params![session_id],
        )?;
        for event in events {
            let source_ref = format!("{}:{}", metadata.session_index_id, event.seq);
            transaction.execute(
                "INSERT INTO local_agent_messages(session_index_id,seq,role,content,occurred_at,source_ref) VALUES (?1,?2,?3,?4,?5,?6)",
                params![session_id, event.seq, event.role, event.content, event.occurred_at.map(|x| x.to_rfc3339()), source_ref],
            )?;
            transaction.execute(
                "INSERT INTO local_agent_messages_fts(content,session_index_id,seq,project_id,source_ref) VALUES (?1,?2,?3,?4,?5)",
                params![event.content, session_id, event.seq, project_id, source_ref],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn tombstone_session(&self, session_id: Uuid, at: DateTime<Utc>) -> RuntimeResult<()> {
        self.connection.execute(
            "UPDATE local_agent_sessions SET deleted_at=?2,state='deleted',content_generation=content_generation+1 WHERE session_index_id=?1 AND content_generation < 9223372036854775807",
            params![session_id.to_string(), at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Local-only provenance used to refuse an unverifiable plain -> compressed
    /// replacement. Never serialize or sync this source path.
    pub(crate) fn session_snapshot_source(
        &self,
        session_id: Uuid,
    ) -> RuntimeResult<Option<String>> {
        Ok(self.connection.query_row(
            "SELECT local_session_ref FROM local_agent_sessions WHERE session_index_id=?1 AND deleted_at IS NULL",
            params![session_id.to_string()], |row| row.get(0),
        ).optional()?)
    }

    /// Read summaries from an isolated, grant-owned store. A grant check and
    /// store isolation are the caller's responsibility; this does not grant
    /// access and must not be used to expose a shared project-wide store.
    pub fn grant_session_summaries(
        &self,
        project_id: Uuid,
        adapter: AdapterKind,
        after: Option<Uuid>,
        limit: usize,
    ) -> RuntimeResult<Vec<LocalSessionSummary>> {
        if project_id.is_nil() || limit == 0 || limit > 100 {
            return Err(crate::error::RuntimeError::UnauthorizedPath);
        }
        let adapter_name = match adapter {
            AdapterKind::ClaudeCode => "claude_code",
            AdapterKind::CodexCli => "codex_cli",
        };
        let mut statement = self.connection.prepare(
            "SELECT session_index_id, started_at, last_activity_at, state, message_count
             FROM local_agent_sessions WHERE project_id=?1 AND adapter=?2 AND deleted_at IS NULL
               AND (?3 IS NULL OR session_index_id > ?3)
             ORDER BY session_index_id LIMIT ?4",
        )?;
        let mut rows = statement.query(params![
            project_id.to_string(),
            adapter_name,
            after.map(|x| x.to_string()),
            limit as i64
        ])?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let session_index_id = Uuid::parse_str(&id).map_err(|_| {
                crate::error::RuntimeError::Channel("invalid local session id".into())
            })?;
            result.push(LocalSessionSummary {
                session_index_id,
                project_id,
                adapter: adapter_name.to_owned(),
                started_at: row.get(1)?,
                last_activity_at: row.get(2)?,
                state: row.get(3)?,
                message_count: row.get(4)?,
            });
        }
        Ok(result)
    }

    /// Read messages from an isolated, grant-owned store. The caller must
    /// authorize the active source grant before calling; this method also
    /// checks the exact project, adapter, session and tombstone state. It does
    /// not return native IDs, source refs, or filesystem paths and never logs
    /// message content.
    ///
    /// A cursor with `char_offset: Some(n)` resumes inside the message at
    /// Unicode character n; a cursor with `None` resumes after its sequence.
    /// Each returned item carries the cursor to use for the next request.
    pub fn read_grant_session_content(
        &self,
        request: &LocalSessionReadRequest,
    ) -> RuntimeResult<Vec<LocalSessionContentItem>> {
        validate_local_content_bounds(
            request.project_id,
            request.session_id,
            request.cursor,
            request.limit,
            request.max_bytes,
        )?;
        // Keep scope, revision and message rows in the same SQLite snapshot.
        let _read_transaction = self.connection.unchecked_transaction()?;
        let adapter = adapter_name(request.adapter);
        let revision =
            self.require_active_session_scope(request.project_id, adapter, request.session_id)?;
        if request
            .cursor
            .is_some_and(|cursor| cursor.source_revision != revision || cursor.query_hash.is_some())
        {
            return Err(crate::error::RuntimeError::Channel(
                "stale session cursor".into(),
            ));
        }

        let cursor_seq = request.cursor.map(|cursor| cursor.seq);
        let resume_offset = request
            .cursor
            .and_then(|cursor| cursor.char_offset)
            .unwrap_or(0);
        let mut statement = self.connection.prepare(
            "SELECT seq, role,
                    substr(content, CASE WHEN seq=?2 AND ?5=1 THEN ?3+1 ELSE 1 END, ?1), occurred_at,
                    length(CAST(substr(content, CASE WHEN seq=?2 AND ?5=1 THEN ?3+1 ELSE 1 END) AS BLOB))
             FROM local_agent_messages
             WHERE session_index_id=?4 AND (?2 IS NULL OR seq>?2 OR (seq=?2 AND ?5=1))
             ORDER BY seq LIMIT ?6",
        )?;
        let mut rows = statement.query(params![
            request.max_bytes as i64,
            cursor_seq.map(|seq| seq as i64),
            if cursor_seq.is_some() {
                resume_offset as i64
            } else {
                0
            },
            request.session_id.to_string(),
            request
                .cursor
                .is_some_and(|cursor| cursor.char_offset.is_some()) as i64,
            request.limit as i64
        ])?;
        let mut result = Vec::new();
        let mut bytes_used = 0usize;
        while let Some(row) = rows.next()? {
            let remaining = request.max_bytes.saturating_sub(bytes_used);
            if remaining == 0 {
                break;
            }
            let seq = row.get::<_, i64>(0)? as u64;
            let role: String = row.get(1)?;
            // SQLite's substr counts Unicode characters. Limit returned UTF-8
            // bytes again here because a character may occupy multiple bytes.
            let stored_prefix: String = row.get(2)?;
            let occurred_at: Option<String> = row.get(3)?;
            let remaining_message_bytes: i64 = row.get(4)?;
            let content = utf8_prefix(&stored_prefix, remaining).to_owned();
            let content_truncated = remaining_message_bytes.max(0) as usize > content.len();
            // The remaining budget may not fit the next UTF-8 character after
            // earlier items. Return the preceding cursor instead of a zero-byte
            // fragment that cannot advance.
            if content.is_empty() && content_truncated {
                break;
            }
            let character_offset = if cursor_seq == Some(seq) {
                resume_offset
            } else {
                0
            };
            let next_cursor = if content_truncated {
                Some(LocalSessionCursor {
                    seq,
                    source_revision: revision,
                    query_hash: None,
                    char_offset: Some(character_offset + content.chars().count() as u64),
                })
            } else {
                Some(LocalSessionCursor {
                    seq,
                    source_revision: revision,
                    query_hash: None,
                    char_offset: None,
                })
            };
            bytes_used += content.len();
            result.push(LocalSessionContentItem {
                seq,
                role,
                content,
                occurred_at,
                content_truncated,
                next_cursor,
            });
            if content_truncated {
                break;
            }
        }
        Ok(result)
    }

    /// Search one scoped session using literal substring matching (`instr`),
    /// avoiding FTS query syntax. Results and excerpts are bounded, and the
    /// caller must enforce the active source grant before calling.
    pub fn search_grant_session_literal(
        &self,
        request: &LocalSessionSearchRequest,
    ) -> RuntimeResult<Vec<LocalLiteralSearchHit>> {
        validate_local_content_bounds(
            request.project_id,
            request.session_id,
            request.cursor,
            request.limit,
            request.max_bytes,
        )?;
        if request.query.is_empty() || request.query.len() > MAX_LOCAL_SEARCH_QUERY_BYTES {
            return Err(crate::error::RuntimeError::UnauthorizedPath);
        }
        let _read_transaction = self.connection.unchecked_transaction()?;
        let adapter = adapter_name(request.adapter);
        let revision =
            self.require_active_session_scope(request.project_id, adapter, request.session_id)?;
        use sha2::{Digest, Sha256};
        let query_hash: [u8; 32] = Sha256::digest(request.query.as_bytes()).into();
        if request.cursor.is_some_and(|cursor| {
            cursor.source_revision != revision || cursor.query_hash != Some(query_hash)
        }) {
            return Err(crate::error::RuntimeError::Channel(
                "stale session cursor".into(),
            ));
        }

        let cursor_seq = request.cursor.map(|cursor| cursor.seq);
        let resume_offset = request
            .cursor
            .and_then(|cursor| cursor.char_offset)
            .unwrap_or(0);
        let mut statement = self.connection.prepare(
            "SELECT seq, role,
                    substr(content, CASE WHEN seq=?2 AND ?3>0
                      THEN ?3+1
                      ELSE instr(content, ?5) END, ?1),
                    length(CAST(substr(content,
                      CASE WHEN seq=?2 AND ?3>0
                        THEN ?3+1
                        ELSE instr(content, ?5) END) AS BLOB)),
                    CASE WHEN seq=?2 AND ?3>0
                      THEN ?3
                      ELSE instr(content, ?5) - 1 END
             FROM local_agent_messages
             WHERE session_index_id=?4 AND (?2 IS NULL OR seq>?2 OR (seq=?2 AND ?6=1))
               AND ((seq=?2 AND ?3>0) OR instr(content, ?5)>0)
             ORDER BY seq LIMIT ?7",
        )?;
        let mut rows = statement.query(params![
            request.max_bytes as i64,
            cursor_seq.map(|seq| seq as i64),
            resume_offset as i64,
            request.session_id.to_string(),
            request.query,
            request
                .cursor
                .is_some_and(|cursor| cursor.char_offset.is_some()) as i64,
            request.limit as i64
        ])?;
        let mut result = Vec::new();
        let mut bytes_used = 0usize;
        while let Some(row) = rows.next()? {
            let remaining = request.max_bytes.saturating_sub(bytes_used);
            if remaining == 0 {
                break;
            }
            let seq = row.get::<_, i64>(0)? as u64;
            let role: String = row.get(1)?;
            let stored_prefix: String = row.get(2)?;
            let remaining_excerpt_bytes: i64 = row.get(3)?;
            let character_offset: u64 = row.get(4)?;
            let excerpt = utf8_prefix(&stored_prefix, remaining).to_owned();
            let excerpt_truncated = remaining_excerpt_bytes.max(0) as usize > excerpt.len();
            if excerpt.is_empty() && excerpt_truncated {
                break;
            }
            let next_cursor = if excerpt_truncated {
                Some(LocalSessionCursor {
                    seq,
                    source_revision: revision,
                    query_hash: Some(query_hash),
                    char_offset: Some(character_offset + excerpt.chars().count() as u64),
                })
            } else {
                Some(LocalSessionCursor {
                    seq,
                    source_revision: revision,
                    query_hash: Some(query_hash),
                    char_offset: None,
                })
            };
            bytes_used += excerpt.len();
            result.push(LocalLiteralSearchHit {
                seq,
                role,
                excerpt,
                excerpt_truncated,
                next_cursor,
            });
            if excerpt_truncated {
                break;
            }
        }
        Ok(result)
    }

    fn require_active_session_scope(
        &self,
        project_id: Uuid,
        adapter: &str,
        session_id: Uuid,
    ) -> RuntimeResult<u64> {
        self.connection
            .query_row(
                "SELECT content_generation FROM local_agent_sessions
             WHERE session_index_id=?1 AND project_id=?2 AND adapter=?3 AND deleted_at IS NULL",
                params![session_id.to_string(), project_id.to_string(), adapter],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(crate::error::RuntimeError::UnauthorizedPath)
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
        let project_placeholders = vec!["?"; allowed_projects.len()].join(",");
        let sql = format!(
            "SELECT f.session_index_id, f.seq, f.project_id, f.source_ref,
                    snippet(local_agent_messages_fts, 0, '[', ']', '…', 12)
             FROM local_agent_messages_fts f
             JOIN local_agent_sessions s ON s.session_index_id=f.session_index_id
             WHERE local_agent_messages_fts MATCH ? AND s.deleted_at IS NULL
               AND s.project_id IN ({project_placeholders}) AND f.project_id=s.project_id
             ORDER BY rank LIMIT ?"
        );
        let mut parameters = Vec::with_capacity(allowed_projects.len() + 2);
        parameters.push(Value::Text(query.to_owned()));
        parameters.extend(
            allowed_projects
                .iter()
                .map(|id| Value::Text(id.to_string())),
        );
        parameters.push(Value::Integer(i64::try_from(limit).unwrap_or(i64::MAX)));
        let mut statement = self.connection.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(parameters))?;
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

fn validate_local_content_bounds(
    project_id: Uuid,
    session_id: Uuid,
    cursor: Option<LocalSessionCursor>,
    limit: usize,
    max_bytes: usize,
) -> RuntimeResult<()> {
    if project_id.is_nil()
        || session_id.is_nil()
        || cursor.is_some_and(|value| {
            value.seq > i64::MAX as u64
                || value
                    .char_offset
                    .is_some_and(|offset| offset > i64::MAX as u64)
        })
        || limit == 0
        || limit > MAX_LOCAL_CONTENT_ITEMS
        || !(MIN_LOCAL_CONTENT_BYTES..=MAX_LOCAL_CONTENT_BYTES).contains(&max_bytes)
    {
        return Err(crate::error::RuntimeError::UnauthorizedPath);
    }
    Ok(())
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    let mut end = value.len().min(max_bytes);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
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

    fn test_session(
        store: &LocalStore,
        project_id: Uuid,
        adapter: &str,
        events: &[(&str, &str)],
    ) -> Uuid {
        let session_index_id = Uuid::new_v4();
        let metadata = LocalSessionMetadata {
            session_index_id,
            native_session_id: "native-id-must-not-leak".into(),
            local_session_ref: "/private/session/path".into(),
            project_id,
            adapter: adapter.into(),
            source_revision: 1,
            started_at: None,
            last_activity_at: None,
            state: "indexed".into(),
            message_count: events.len() as u64,
        };
        let session_events = events
            .iter()
            .enumerate()
            .map(|(index, (role, content))| SessionEvent {
                seq: (index + 1) as u64,
                role: (*role).into(),
                content: (*content).into(),
                occurred_at: None,
            })
            .collect::<Vec<_>>();
        store
            .store_session_snapshot(&metadata, &session_events)
            .unwrap();
        session_index_id
    }

    fn read_request(
        project_id: Uuid,
        adapter: AdapterKind,
        session_id: Uuid,
        cursor: Option<LocalSessionCursor>,
        limit: usize,
        max_bytes: usize,
    ) -> LocalSessionReadRequest {
        LocalSessionReadRequest {
            project_id,
            adapter,
            session_id,
            cursor,
            limit,
            max_bytes,
        }
    }

    fn search_request(
        project_id: Uuid,
        adapter: AdapterKind,
        session_id: Uuid,
        query: &str,
        cursor: Option<LocalSessionCursor>,
        limit: usize,
        max_bytes: usize,
    ) -> LocalSessionSearchRequest {
        LocalSessionSearchRequest {
            project_id,
            adapter,
            session_id,
            query: query.into(),
            cursor,
            limit,
            max_bytes,
        }
    }

    #[test]
    fn grant_session_content_is_scoped_keyset_paginated_and_bounded_utf8() {
        let store = LocalStore::open_in_memory().unwrap();
        let project = Uuid::new_v4();
        let other_project = Uuid::new_v4();
        let session = test_session(
            &store,
            project,
            "codex_cli",
            &[("user", "A🦀BC"), ("assistant", "second")],
        );
        let other_session = test_session(
            &store,
            other_project,
            "codex_cli",
            &[("user", "other secret")],
        );

        let first = store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                None,
                10,
                4,
            ))
            .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].content, "A");
        assert!(first[0].content_truncated);
        assert_eq!(first[0].seq, 1);
        let next = store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                first[0].next_cursor,
                1,
                4,
            ))
            .unwrap();
        assert_eq!(next[0].seq, 1);
        assert_eq!(next[0].content, "🦀");
        assert!(next[0].content_truncated);
        let tail = store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                next[0].next_cursor,
                10,
                20,
            ))
            .unwrap();
        assert_eq!(tail[0].content, "BC");
        assert!(!tail[0].content_truncated);
        let following = store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                tail[0].next_cursor,
                10,
                20,
            ))
            .unwrap();
        assert_eq!(following[0].seq, 2);
        assert_eq!(following[0].content, "second");

        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                None,
                1,
                20
            ))
            .is_err());
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                other_session,
                None,
                1,
                20
            ))
            .is_err());
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                Uuid::new_v4(),
                None,
                1,
                20
            ))
            .is_err());
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                Some(LocalSessionCursor {
                    seq: u64::MAX,
                    source_revision: 1,
                    query_hash: None,
                    char_offset: None
                }),
                1,
                20
            ))
            .is_err());
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                None,
                101,
                20
            ))
            .is_err());
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                None,
                1,
                MAX_LOCAL_CONTENT_BYTES + 1
            ))
            .is_err());

        let serialized = serde_json::to_string(&next).unwrap();
        assert!(!serialized.contains("native-id"));
        assert!(!serialized.contains("private/session/path"));
        assert!(!serialized.contains("project_id"));
    }

    #[test]
    fn content_cursor_preserves_next_multibyte_message_and_rejects_new_revision() {
        let store = LocalStore::open_in_memory().unwrap();
        let project = Uuid::new_v4();
        let session = test_session(
            &store,
            project,
            "codex_cli",
            &[("user", "abc"), ("assistant", "🦀end")],
        );
        let first = store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                None,
                10,
                4,
            ))
            .unwrap();
        assert_eq!(first.len(), 1);
        let cursor = first[0].next_cursor;
        let second = store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                cursor,
                10,
                4,
            ))
            .unwrap();
        assert_eq!(second[0].content, "🦀");
        let tail = store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                second[0].next_cursor,
                10,
                4,
            ))
            .unwrap();
        assert_eq!(tail[0].content, "end");
        let same_revision = LocalSessionMetadata {
            session_index_id: session,
            native_session_id: "native".into(),
            local_session_ref: "/private".into(),
            project_id: project,
            adapter: "codex_cli".into(),
            source_revision: 1,
            started_at: None,
            last_activity_at: None,
            state: "indexed".into(),
            message_count: 1,
        };
        store
            .store_session_snapshot(
                &same_revision,
                &[SessionEvent {
                    seq: 1,
                    role: "user".into(),
                    content: "changed".into(),
                    occurred_at: None,
                }],
            )
            .unwrap();
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                cursor,
                10,
                4
            ))
            .is_err());
        let metadata = LocalSessionMetadata {
            session_index_id: session,
            native_session_id: "native".into(),
            local_session_ref: "/private".into(),
            project_id: project,
            adapter: "codex_cli".into(),
            source_revision: 2,
            started_at: None,
            last_activity_at: None,
            state: "indexed".into(),
            message_count: 1,
        };
        store
            .store_session_snapshot(
                &metadata,
                &[SessionEvent {
                    seq: 1,
                    role: "user".into(),
                    content: "replacement".into(),
                    occurred_at: None,
                }],
            )
            .unwrap();
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                cursor,
                10,
                4
            ))
            .is_err());
        assert!(store
            .search_grant_session_literal(&search_request(
                project,
                AdapterKind::CodexCli,
                session,
                "replacement",
                cursor,
                10,
                20
            ))
            .is_err());
    }

    #[test]
    fn legacy_mutations_invalidate_cursors_and_reject_embedded_nul() {
        let store = LocalStore::open_in_memory().unwrap();
        let project = Uuid::new_v4();
        let session = test_session(&store, project, "codex_cli", &[("user", "abcdefgh")]);
        let request = read_request(project, AdapterKind::CodexCli, session, None, 1, 4);
        let cursor = store.read_grant_session_content(&request).unwrap()[0].next_cursor;
        let replacement = SessionEvent {
            seq: 1,
            role: "user".into(),
            content: "12345678".into(),
            occurred_at: None,
        };
        store
            .replace_session_events(session, project, std::slice::from_ref(&replacement))
            .unwrap();
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                cursor,
                1,
                4
            ))
            .is_err());
        let cursor = store.read_grant_session_content(&request).unwrap()[0].next_cursor;
        store
            .index_events(session, project, &[replacement])
            .unwrap();
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                cursor,
                1,
                4
            ))
            .is_err());
        let invalid = SessionEvent {
            seq: 1,
            role: "user".into(),
            content: "a\0secret".into(),
            occurred_at: None,
        };
        assert!(store.index_events(session, project, &[invalid]).is_err());
    }

    #[test]
    fn deletion_and_restoration_do_not_revalidate_an_old_cursor() {
        let store = LocalStore::open_in_memory().unwrap();
        let project = Uuid::new_v4();
        let session = test_session(&store, project, "codex_cli", &[("user", "abcdefgh")]);
        let cursor = store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                None,
                1,
                4,
            ))
            .unwrap()[0]
            .next_cursor;
        store.tombstone_session(session, Utc::now()).unwrap();
        let metadata = LocalSessionMetadata {
            session_index_id: session,
            native_session_id: "native".into(),
            local_session_ref: "/private".into(),
            project_id: project,
            adapter: "codex_cli".into(),
            source_revision: 1,
            started_at: None,
            last_activity_at: None,
            state: "indexed".into(),
            message_count: 1,
        };
        store.upsert_session(&metadata).unwrap();
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::CodexCli,
                session,
                cursor,
                1,
                4
            ))
            .is_err());
    }

    #[test]
    fn grant_content_rejects_tombstones_and_literal_search_avoids_fts_syntax() {
        let store = LocalStore::open_in_memory().unwrap();
        let project = Uuid::new_v4();
        let session = test_session(
            &store,
            project,
            "claude_code",
            &[
                ("assistant", "alpha OR beta 🦀 trailing"),
                ("user", "beta only"),
            ],
        );
        let hits = store
            .search_grant_session_literal(&search_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                "alpha OR beta",
                None,
                10,
                10,
            ))
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].seq, 1);
        assert!(hits[0].excerpt.starts_with("alpha OR b"));
        assert!(hits[0].excerpt_truncated);
        let continued = store
            .search_grant_session_literal(&search_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                "alpha OR beta",
                hits[0].next_cursor,
                10,
                100,
            ))
            .unwrap();
        assert_eq!(continued[0].excerpt, "eta 🦀 trailing");
        assert!(!continued[0].excerpt_truncated);
        assert!(store
            .search_grant_session_literal(&search_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                "different",
                hits[0].next_cursor,
                10,
                100
            ))
            .is_err());
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                hits[0].next_cursor,
                10,
                100
            ))
            .is_err());
        assert!(store
            .search_grant_session_literal(&search_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                "alpha OR missing",
                None,
                10,
                100
            ))
            .unwrap()
            .is_empty());
        assert!(store
            .search_grant_session_literal(&search_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                "",
                None,
                10,
                100
            ))
            .is_err());
        assert!(store
            .search_grant_session_literal(&search_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                "alpha",
                None,
                10,
                MAX_LOCAL_CONTENT_BYTES + 1
            ))
            .is_err());

        store.tombstone_session(session, Utc::now()).unwrap();
        assert!(store
            .read_grant_session_content(&read_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                None,
                10,
                100
            ))
            .is_err());
        assert!(store
            .search_grant_session_literal(&search_request(
                project,
                AdapterKind::ClaudeCode,
                session,
                "alpha",
                None,
                10,
                100
            ))
            .is_err());
    }

    #[test]
    fn grant_summaries_are_scoped_bounded_and_exclude_private_fields() {
        let store = LocalStore::open_in_memory().unwrap();
        let project = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut ids = Vec::new();
        for (binding, adapter) in [
            (project, "codex_cli"),
            (project, "codex_cli"),
            (other, "codex_cli"),
            (project, "claude_code"),
        ] {
            let item = LocalSessionMetadata {
                session_index_id: Uuid::new_v4(),
                native_session_id: "private_native".into(),
                local_session_ref: "/private/path".into(),
                project_id: binding,
                adapter: adapter.into(),
                source_revision: 1,
                started_at: None,
                last_activity_at: None,
                state: "indexed".into(),
                message_count: 1,
            };
            store
                .store_session_snapshot(
                    &item,
                    &[SessionEvent {
                        seq: 1,
                        role: "user".into(),
                        content: "private_content".into(),
                        occurred_at: None,
                    }],
                )
                .unwrap();
            if binding == project && adapter == "codex_cli" {
                ids.push(item.session_index_id);
            }
        }
        ids.sort();
        let first = store
            .grant_session_summaries(project, AdapterKind::CodexCli, None, 1)
            .unwrap();
        let second = store
            .grant_session_summaries(
                project,
                AdapterKind::CodexCli,
                Some(first[0].session_index_id),
                1,
            )
            .unwrap();
        assert_eq!(first[0].session_index_id, ids[0]);
        assert_eq!(second[0].session_index_id, ids[1]);
        let json = serde_json::to_string(&first).unwrap();
        assert!(!json.contains("private"));
        store.tombstone_session(ids[1], Utc::now()).unwrap();
        assert!(store
            .grant_session_summaries(project, AdapterKind::CodexCli, Some(ids[0]), 1)
            .unwrap()
            .is_empty());
        assert!(store
            .grant_session_summaries(project, AdapterKind::CodexCli, None, 101)
            .is_err());
    }

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
    fn local_fts_limits_results_after_project_filtering() {
        let store = LocalStore::open_in_memory().unwrap();
        let allowed = Uuid::new_v4();
        let other = Uuid::new_v4();
        for project in [other, allowed] {
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
                        role: "user".into(),
                        content: "shared search term".into(),
                        occurred_at: None,
                    }],
                )
                .unwrap();
        }
        let hits = store.search("shared", &[allowed], 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].project_id, allowed);
        assert!(store.search("shared", &[], 1).unwrap().is_empty());
    }

    #[test]
    fn replacing_snapshot_removes_stale_hits_and_rolls_back_on_failure() {
        let store = LocalStore::open_in_memory().unwrap();
        let project = Uuid::new_v4();
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
            message_count: 2,
        };
        store.upsert_session(&session).unwrap();
        let event = |seq, content: &str| SessionEvent {
            seq,
            role: "user".into(),
            content: content.into(),
            occurred_at: None,
        };
        store
            .replace_session_events(
                session.session_index_id,
                project,
                &[event(1, "kept"), event(2, "obsolete")],
            )
            .unwrap();
        assert!(store
            .replace_session_events(session.session_index_id, Uuid::new_v4(), &[])
            .is_err());
        assert!(store
            .replace_session_events(
                session.session_index_id,
                project,
                &[event(1, "broken"), event(1, "duplicate")]
            )
            .is_err());
        assert_eq!(store.search("obsolete", &[project], 10).unwrap().len(), 1);
        store
            .replace_session_events(session.session_index_id, project, &[event(1, "updated")])
            .unwrap();
        assert!(store.search("obsolete", &[project], 10).unwrap().is_empty());
        assert!(store.search("kept", &[project], 10).unwrap().is_empty());
        assert_eq!(store.search("updated", &[project], 10).unwrap().len(), 1);
        store
            .replace_session_events(session.session_index_id, project, &[])
            .unwrap();
        assert!(store.search("updated", &[project], 10).unwrap().is_empty());
    }

    #[test]
    fn snapshot_metadata_and_content_commit_or_roll_back_together() {
        let store = LocalStore::open_in_memory().unwrap();
        let mut metadata = LocalSessionMetadata {
            session_index_id: Uuid::new_v4(),
            native_session_id: "native".into(),
            local_session_ref: "/tmp/local".into(),
            project_id: Uuid::new_v4(),
            adapter: "codex_cli".into(),
            source_revision: 1,
            started_at: None,
            last_activity_at: None,
            state: "indexed".into(),
            message_count: 1,
        };
        let event = |seq, content: &str| SessionEvent {
            seq,
            role: "user".into(),
            content: content.into(),
            occurred_at: None,
        };
        store
            .store_session_snapshot(&metadata, &[event(1, "original")])
            .unwrap();
        metadata.source_revision = 2;
        metadata.message_count = 2;
        assert!(store
            .store_session_snapshot(&metadata, &[event(1, "new"), event(1, "duplicate")])
            .is_err());
        let revision: u64 = store
            .connection
            .query_row(
                "SELECT source_revision FROM local_agent_sessions WHERE session_index_id=?1",
                params![metadata.session_index_id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(revision, 1);
        assert_eq!(
            store
                .search("original", &[metadata.project_id], 10)
                .unwrap()
                .len(),
            1
        );
        assert!(store
            .search("new", &[metadata.project_id], 10)
            .unwrap()
            .is_empty());
        metadata.message_count = 1;
        store
            .store_session_snapshot(&metadata, &[event(1, "new")])
            .unwrap();
        assert!(store
            .search("original", &[metadata.project_id], 10)
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .search("new", &[metadata.project_id], 10)
                .unwrap()
                .len(),
            1
        );
        metadata.project_id = Uuid::new_v4();
        assert!(store
            .store_session_snapshot(&metadata, &[event(1, "leak")])
            .is_err());
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
