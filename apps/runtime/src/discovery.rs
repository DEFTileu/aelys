use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::adapter::AdapterKind;
use crate::error::{RuntimeError, RuntimeResult};
use crate::paths::AuthorizedRoot;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DiscoveryCursor {
    pub modified_after_unix_ms: i128,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscoveredSessionFile {
    pub session_index_id: Uuid,
    pub adapter: AdapterKind,
    pub project_id: Uuid,
    pub local_path: PathBuf,
    pub source_revision: u64,
    pub modified_at: DateTime<Utc>,
    pub size_bytes: u64,
}

struct DiscoverySpec<'a> {
    project_id: Uuid,
    adapter: AdapterKind,
    cursor: DiscoveryCursor,
    extensions: &'a [&'a str],
    max_files: usize,
    max_size_bytes: u64,
}

/// Walks only roots explicitly selected by the owner. It does not infer
/// vendor directories or parse vendor formats. The caller supplies the
/// adapter and project binding for each authorized root.
pub fn discover_session_files(
    roots: &[(AuthorizedRoot, Uuid, AdapterKind)],
    cursor: DiscoveryCursor,
    extensions: &[&str],
    max_files: usize,
    max_size_bytes: u64,
) -> RuntimeResult<Vec<DiscoveredSessionFile>> {
    let mut found = Vec::new();
    for (root, project_id, adapter) in roots {
        let spec = DiscoverySpec {
            project_id: *project_id,
            adapter: *adapter,
            cursor,
            extensions,
            max_files,
            max_size_bytes,
        };
        walk(root, root.canonical(), &spec, &mut found)?;
    }
    found.sort_by(|a, b| {
        a.modified_at
            .cmp(&b.modified_at)
            .then(a.local_path.cmp(&b.local_path))
    });
    Ok(found)
}

fn walk(
    root: &AuthorizedRoot,
    directory: &std::path::Path,
    spec: &DiscoverySpec<'_>,
    output: &mut Vec<DiscoveredSessionFile>,
) -> RuntimeResult<()> {
    if output.len() >= spec.max_files {
        return Ok(());
    }
    for entry in fs::read_dir(directory)? {
        if output.len() >= spec.max_files {
            break;
        }
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            walk(root, &path, spec, output)?;
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !spec.extensions.is_empty()
            && !spec
                .extensions
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(extension))
        {
            continue;
        }
        if metadata.len() > spec.max_size_bytes {
            continue;
        }
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let modified_ms = modified
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_millis() as i128;
        if modified_ms <= spec.cursor.modified_after_unix_ms {
            continue;
        }
        let authorized = root.authorize_existing(&path)?;
        let revision = modified_ms as u64 ^ metadata.len();
        output.push(DiscoveredSessionFile {
            session_index_id: stable_session_id(spec.project_id, spec.adapter, &authorized),
            adapter: spec.adapter,
            project_id: spec.project_id,
            local_path: authorized,
            source_revision: revision,
            modified_at: DateTime::<Utc>::from(modified),
            size_bytes: metadata.len(),
        });
    }
    Ok(())
}

fn stable_session_id(project_id: Uuid, adapter: AdapterKind, path: &std::path::Path) -> Uuid {
    let mut digest = Sha256::new();
    digest.update(project_id.as_bytes());
    digest.update(format!("{adapter:?}").as_bytes());
    digest.update(path.as_os_str().to_string_lossy().as_bytes());
    let bytes = digest.finalize();
    let mut id = [0u8; 16];
    id.copy_from_slice(&bytes[..16]);
    Uuid::from_bytes(id)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionEvent {
    pub seq: u64,
    pub role: String,
    pub content: String,
    pub occurred_at: Option<DateTime<Utc>>,
}

/// Safe vendor parser seam. The native Claude/Codex formats are intentionally
/// not guessed. A future adapter may implement this after a compatibility
/// spike against an installed version.
pub trait SessionParser: Send + Sync {
    fn parse_increment(
        &self,
        _path: &std::path::Path,
        _source_revision: u64,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        Err(RuntimeError::AdapterUnavailable(
            "vendor session format is unknown; parser is a safe stub".into(),
        ))
    }
}

/// Parser for the observed Claude Code JSONL envelope. It intentionally
/// extracts only user/assistant text blocks and ignores tool inputs, paths,
/// diagnostics, and other metadata. Unknown records are skipped so a vendor
/// format change cannot turn into a false transcript import.
pub struct ClaudeJsonlParser;

impl SessionParser for ClaudeJsonlParser {
    fn parse_increment(
        &self,
        path: &std::path::Path,
        _source_revision: u64,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        let text = fs::read_to_string(path)?;
        let mut events = Vec::new();
        for (index, line) in text.lines().enumerate() {
            let value: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let kind = value
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if kind != "user" && kind != "assistant" {
                continue;
            }
            let message = value.get("message").and_then(|v| v.as_object());
            let role = message
                .and_then(|m| m.get("role"))
                .and_then(|v| v.as_str())
                .unwrap_or(kind);
            if role != "user" && role != "assistant" {
                continue;
            }
            let content = message.and_then(|m| m.get("content"));
            let body = match content {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(items)) => items
                    .iter()
                    .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            if !body.is_empty() {
                events.push(SessionEvent {
                    seq: index as u64 + 1,
                    role: role.to_owned(),
                    content: body,
                    occurred_at: value
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse().ok()),
                });
            }
        }
        Ok(events)
    }
}

/// Parser for the observed Codex rollout envelope. It reads only
/// `response_item` messages with `role=user|assistant`; tool calls, encrypted
/// summaries, world state, and turn metadata are ignored.
pub struct CodexJsonlParser;
impl SessionParser for CodexJsonlParser {
    fn parse_increment(
        &self,
        path: &std::path::Path,
        _source_revision: u64,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        let text = fs::read_to_string(path)?;
        let mut events = Vec::new();
        for (index, line) in text.lines().enumerate() {
            let value: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if value.get("type").and_then(|v| v.as_str()) != Some("response_item") {
                continue;
            }
            let payload = match value.get("payload").and_then(|v| v.as_object()) {
                Some(v) => v,
                None => continue,
            };
            let role = match payload.get("role").and_then(|v| v.as_str()) {
                Some("user") => "user",
                Some("assistant") => "assistant",
                _ => continue,
            };
            let content = payload.get("content");
            let body = match content {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(items)) => items
                    .iter()
                    .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            if !body.is_empty() {
                events.push(SessionEvent {
                    seq: index as u64 + 1,
                    role: role.into(),
                    content: body,
                    occurred_at: value
                        .get("timestamp")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse().ok()),
                });
            }
        }
        Ok(events)
    }
}

#[cfg(test)]
mod parser_tests {
    use super::*;
    #[test]
    fn claude_parser_extracts_text_and_ignores_tools() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        fs::write(&path,r#"{"type":"user","message":{"role":"user","content":"hello"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"world"},{"type":"tool_use","input":{"secret":"ignore"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","input":{"path":"/private"}}]}}"#).unwrap();
        let events = ClaudeJsonlParser.parse_increment(&path, 1).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].content, "hello");
        assert_eq!(events[1].content, "world");
    }
    #[test]
    fn codex_parser_extracts_response_items_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        fs::write(&path,r#"{"type":"session_meta","payload":{"session_id":"s"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"hello"}]}}
{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"secret"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"world"}]}}"#).unwrap();
        let events = CodexJsonlParser.parse_increment(&path, 1).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].content, "world");
    }
}
