use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::adapter::AdapterKind;
use crate::error::{RuntimeError, RuntimeResult};
use crate::paths::AuthorizedRoot;

#[path = "discovery_walk.rs"]
mod bounded;
pub use bounded::{
    DiscoveryLimits, DiscoveryPage, DiscoverySkips, DiscoveryState, SessionDiscovery,
};

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

/// LEGACY compatibility API. The caller's timestamp filter is inherently lossy
/// (ties, backdated files and same-mtime rewrites); never advance an indexing
/// watermark using this result. Use [`SessionDiscovery`] without mtime filtering
/// and the coordinator's content-derived revisions for indexing.
///
/// Like the original API, oversized files are skipped and reaching max_files
/// returns the selected traversal prefix, sorted below, without visiting later
/// roots. Zero max_files returns an empty list without filesystem access.
/// This list never proves traversal completeness or globally oldest results.
/// Other traversal omissions and work-budget exhaustion still return an error.
/// At most 32 roots, 1024 results and 65,536 work units for a nonempty request.
/// Metadata revisions are legacy hints only, never evidence of unchanged bytes.
pub fn discover_session_files(
    roots: &[(AuthorizedRoot, Uuid, AdapterKind)],
    cursor: DiscoveryCursor,
    extensions: &[&str],
    max_files: usize,
    max_size_bytes: u64,
) -> RuntimeResult<Vec<DiscoveredSessionFile>> {
    if max_files == 0 {
        return Ok(Vec::new());
    }
    let limited = || {
        RuntimeError::AdapterUnavailable(
            "legacy discovery limits exceeded; use SessionDiscovery continuation".into(),
        )
    };
    if roots.len() > 32 || max_files > 1024 {
        return Err(limited());
    }
    let mut found = Vec::new();
    let mut work = 0;
    'roots: for (root, project_id, adapter) in roots {
        if project_id.is_nil() {
            return Err(RuntimeError::UnauthorizedPath);
        }
        let mut walk = SessionDiscovery::new(
            root,
            extensions,
            DiscoveryLimits {
                // The cursor may filter earlier pages. Yield one candidate
                // at a time so we never prefetch past the final accepted file.
                max_files: 1,
                max_entries: 1024,
                max_file_bytes: max_size_bytes,
                ..DiscoveryLimits::default()
            },
        )?;
        loop {
            // Reserve the maximum page cost before traversing it.
            if work > 65_536 - 1024 {
                return Err(limited());
            }
            let page = walk.next_page()?;
            work += page.work_units;
            // Oversize is the legacy API's requested size filter, not an
            // incomplete traversal error. Keep all other bounded omissions
            // fail-closed; the walker's stricter state is unchanged.
            if work > 65_536
                || page.skipped.depth_limited != 0
                || page.skipped.path_limited != 0
                || page.skipped.unavailable != 0
                || page.skipped.cross_device_or_cycle != 0
            {
                return Err(limited());
            }
            for (relative, (modified_at, size_bytes)) in
                page.candidates.into_iter().zip(page.observations)
            {
                let modified_ms = modified_at.timestamp_millis() as i128;
                if modified_ms <= cursor.modified_after_unix_ms {
                    continue;
                }
                let local_path = root.canonical().join(relative);
                found.push(DiscoveredSessionFile {
                    session_index_id: stable_session_id(*project_id, *adapter, &local_path),
                    adapter: *adapter,
                    project_id: *project_id,
                    local_path,
                    source_revision: modified_ms as u64 ^ size_bytes,
                    modified_at,
                    size_bytes,
                });
                if found.len() == max_files {
                    break 'roots;
                }
            }
            if page.state != DiscoveryState::More {
                break;
            }
            if work >= 65_536 {
                return Err(limited());
            }
        }
    }
    found.sort_by(|a, b| {
        a.modified_at
            .cmp(&b.modified_at)
            .then(a.local_path.cmp(&b.local_path))
    });
    Ok(found)
}

pub(crate) fn stable_session_id(
    project_id: Uuid,
    adapter: AdapterKind,
    path: &std::path::Path,
) -> Uuid {
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
    /// Parse a complete, already bounded snapshot without reopening its path.
    /// The default never falls back to the legacy path-based reader.
    fn parse_snapshot_bytes(
        &self,
        _bytes: &[u8],
        _max_events: usize,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        Err(RuntimeError::AdapterUnavailable(
            "bounded snapshot parsing is unavailable".into(),
        ))
    }

    /// Parse a bounded snapshot for indexing while distinguishing an ordinary
    /// empty/unsupported projection from a Codex rollback proven to remove all
    /// previously visible text. Existing parsers keep their conservative
    /// behavior through this default implementation.
    fn parse_index_snapshot(
        &self,
        bytes: &[u8],
        max_events: usize,
    ) -> RuntimeResult<ParsedIndexSnapshot> {
        let events = self.parse_snapshot_bytes(bytes, max_events)?;
        Ok(if events.is_empty() {
            ParsedIndexSnapshot::UnconfirmedEmpty
        } else {
            ParsedIndexSnapshot::Events(events)
        })
    }

    /// Legacy trusted-input seam: this does not authorize or bound file reads.
    /// Security-sensitive indexing must use `parse_snapshot_bytes` instead.
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedIndexSnapshot {
    Events(Vec<SessionEvent>),
    /// Empty input/projection without affirmative deletion evidence.
    UnconfirmedEmpty,
    /// Codex replay observed a valid rollback remove prior visible text and
    /// the fully replayed indexable history is empty.
    ConfirmedEmptyCodexRollback,
}

/// Phase 5 / task 1: text projection of Claude's visible main conversation.
/// Reference: anthropics/claude-agent-sdk-python, commit
/// 3be907edb9c86269d30d1427a77937dd788d6419, _internal/sessions.py:
/// _build_conversation_chain, _recover_orphaned_parallel_tool_results,
/// _is_visible_message. Latest main leaf is chosen by FILE order, not time.
///
/// Deliberately stricter than that SDK: malformed JSON/graph data, duplicate
/// IDs, dangling parents, cycles and mixed UUID/UUID-less messages fail closed.
/// No partial transcript is returned. IDs are nonempty opaque strings (the SDK
/// does not require RFC UUID syntax). logicalParentUuid is never traversed.
///
/// UUID-less compatibility is ONLY for flat user/assistant fixtures without
/// graph/session/compaction/response identity. It is not vendor compatibility
/// evidence. Both entry points share these rules, including JSON validation.
/// The snapshot caller bounds bytes; graph work additionally caps at 65,536
/// records. max_events counts only nonempty visible text after reconstruction.
/// As in the SDK, progress/system/attachment without a string uuid are not
/// graph nodes; a missing parentUuid means a root. Missing referenced parents
/// are errors rather than the SDK's silently truncated chain. Tool-only orphan
/// results need no text recovery; mixed orphan result text is unsupported and
/// returns an error until full tool-call reconciliation has been implemented.
/// No installed CLI, persistent discovery, permissions or egress changes here.
pub struct ClaudeJsonlParser;

impl SessionParser for ClaudeJsonlParser {
    fn parse_increment(
        &self,
        path: &std::path::Path,
        _source_revision: u64,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        Self::parse_text(&fs::read_to_string(path)?, usize::MAX)
    }

    fn parse_snapshot_bytes(
        &self,
        bytes: &[u8],
        max_events: usize,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| claude_error("session snapshot is not UTF-8"))?;
        Self::parse_text(text, max_events)
    }
}

fn claude_error(reason: &'static str) -> RuntimeError {
    // Fixed messages only, never JSON, identifiers, paths or transcript text.
    RuntimeError::AdapterUnavailable(reason.into())
}

struct ClaudeEntry {
    value: serde_json::Value,
    seq: u64,
    visible: bool,
}

impl ClaudeEntry {
    fn kind(&self) -> &str {
        self.value["type"].as_str().unwrap_or_default()
    }

    fn is_message(&self) -> bool {
        matches!(self.kind(), "user" | "assistant")
    }

    fn response_id(&self) -> Option<&str> {
        (self.kind() == "assistant")
            .then(|| self.value["message"]["id"].as_str())
            .flatten()
    }

    fn event(&self) -> RuntimeResult<Option<SessionEvent>> {
        if !self.visible {
            return Ok(None);
        }
        let message = self.value["message"]
            .as_object()
            .ok_or_else(|| claude_error("invalid Claude message"))?;
        if message
            .get("role")
            .is_some_and(|role| role.as_str() != Some(self.kind()))
        {
            return Err(claude_error("inconsistent Claude role"));
        }
        let body = match message.get("content") {
            Some(serde_json::Value::String(text)) => text.clone(),
            Some(serde_json::Value::Array(blocks)) => {
                let mut text = String::new();
                for block in blocks {
                    if block.get("type").and_then(|kind| kind.as_str()) == Some("text") {
                        text.push_str(
                            block["text"]
                                .as_str()
                                .ok_or_else(|| claude_error("invalid Claude text block"))?,
                        );
                    }
                }
                text
            }
            _ => return Err(claude_error("invalid Claude message content")),
        };
        if body.is_empty() {
            return Ok(None);
        }
        Ok(Some(SessionEvent {
            seq: self.seq,
            role: self.kind().to_owned(),
            content: body,
            occurred_at: self
                .value
                .get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse().ok()),
        }))
    }
}

impl ClaudeJsonlParser {
    fn parse_text(text: &str, max_events: usize) -> RuntimeResult<Vec<SessionEvent>> {
        use std::collections::HashMap;
        const MAX_RECORDS: usize = 65_536;
        let mut entries = Vec::new();
        let mut records = 0;
        let mut has_ids = false;
        let mut has_flat = false;
        let mut session_id: Option<String> = None;
        for (index, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            records += 1;
            if records > MAX_RECORDS {
                return Err(claude_error("Claude record limit exceeded"));
            }
            let value: serde_json::Value = serde_json::from_str(line)
                .map_err(|_| claude_error("session snapshot contains invalid JSON"))?;
            let object = value
                .as_object()
                .ok_or_else(|| claude_error("invalid Claude record"))?;
            let kind = object
                .get("type")
                .and_then(|v| v.as_str())
                .ok_or_else(|| claude_error("invalid Claude record type"))?;
            if !matches!(
                kind,
                "user" | "assistant" | "progress" | "system" | "attachment"
            ) {
                // Known SDK graph node kinds only; other records aren't messages.
                continue;
            }
            if !matches!(kind, "user" | "assistant")
                && value.get("uuid").and_then(|v| v.as_str()).is_none()
            {
                // SDK _parse_transcript_entries retains only string-uuid nodes.
                // Unlinked service records must not activate fixture mode.
                continue;
            }
            let mut hidden = false;
            for flag in ["isMeta", "isSidechain", "isCompactSummary"] {
                if let Some(flag_value) = value.get(flag) {
                    let enabled = flag_value
                        .as_bool()
                        .ok_or_else(|| claude_error("invalid Claude visibility flag"))?;
                    if flag != "isCompactSummary" {
                        hidden |= enabled;
                    }
                }
            }
            if let Some(team) = value.get("teamName").filter(|v| !v.is_null()) {
                hidden |= !team
                    .as_str()
                    .ok_or_else(|| claude_error("invalid Claude team marker"))?
                    .is_empty();
            }
            if let Some(id) = value.get("uuid") {
                if id.as_str().is_none_or(|id| id.is_empty()) {
                    return Err(claude_error("invalid Claude entry identity"));
                }
                has_ids = true;
                match value.get("parentUuid") {
                    None | Some(serde_json::Value::Null) => {}
                    Some(serde_json::Value::String(id)) if !id.is_empty() => {}
                    _ => return Err(claude_error("invalid Claude parent identity")),
                }
                if let Some(id) = value.get("sessionId") {
                    let id = id
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| claude_error("invalid Claude session identity"))?;
                    if session_id.as_deref().is_some_and(|previous| previous != id) {
                        return Err(claude_error("mixed Claude session identities"));
                    }
                    session_id = Some(id.to_owned());
                }
            } else {
                has_flat = true;
                // Do not invent chain links or discard identity-bearing records.
                if !matches!(kind, "user" | "assistant")
                    || [
                        "parentUuid",
                        "logicalParentUuid",
                        "sessionId",
                        "agentId",
                        "sourceToolAssistantUUID",
                        "isCompactSummary",
                    ]
                    .iter()
                    .any(|field| value.get(*field).is_some())
                    || value["message"].get("id").is_some()
                {
                    return Err(claude_error("unsupported UUID-less Claude graph"));
                }
            }
            if has_ids && has_flat {
                return Err(claude_error("mixed Claude entry identity modes"));
            }
            if let Some(id) = value["message"].get("id") {
                if id.as_str().is_none_or(|id| id.is_empty()) {
                    return Err(claude_error("invalid Claude response identity"));
                }
            }
            let visible = matches!(kind, "user" | "assistant") && !hidden;
            entries.push(ClaudeEntry {
                value,
                seq: index as u64 + 1,
                visible,
            });
        }
        if !has_ids {
            return Self::project(
                &entries,
                &(0..entries.len()).collect::<Vec<_>>(),
                max_events,
            );
        }

        let mut by_id = HashMap::new();
        for (index, entry) in entries.iter().enumerate() {
            if by_id
                .insert(entry.value["uuid"].as_str().unwrap(), index)
                .is_some()
            {
                return Err(claude_error("duplicate Claude entry identity"));
            }
        }
        let mut parents = Vec::with_capacity(entries.len());
        let mut has_child = vec![false; entries.len()];
        for entry in &entries {
            let parent = entry.value["parentUuid"]
                .as_str()
                .map(|id| {
                    by_id
                        .get(id)
                        .copied()
                        .ok_or_else(|| claude_error("missing Claude parent"))
                })
                .transpose()?;
            if let Some(index) = parent {
                has_child[index] = true;
            }
            parents.push(parent);
        }
        // Validate ALL components in linear time, including disconnected cycles.
        let mut colors = vec![0u8; entries.len()];
        let mut nearest_message = vec![None; entries.len()];
        for start in 0..entries.len() {
            let mut walk = Vec::new();
            let mut current = Some(start);
            while let Some(index) = current {
                if colors[index] == 2 {
                    break;
                }
                if colors[index] == 1 {
                    return Err(claude_error("cyclic Claude graph"));
                }
                colors[index] = 1;
                walk.push(index);
                current = parents[index];
            }
            for index in walk.into_iter().rev() {
                nearest_message[index] = if entries[index].is_message() {
                    Some(index)
                } else {
                    parents[index].and_then(|parent| nearest_message[parent])
                };
                colors[index] = 2;
            }
        }
        let mut latest_main = None;
        let mut latest_any = None;
        for index in 0..entries.len() {
            if !has_child[index] {
                if let Some(leaf) = nearest_message[index] {
                    latest_any =
                        Some(latest_any.map_or(leaf, |previous: usize| previous.max(leaf)));
                    if entries[leaf].visible {
                        latest_main =
                            Some(latest_main.map_or(leaf, |previous: usize| previous.max(leaf)));
                    }
                }
            }
        }
        // SDK fallback to a hidden leaf still permits visible ancestors; hidden
        // leaves themselves are never projected. No message leaves => no text.
        let mut chain = Vec::new();
        let mut current = latest_main.or(latest_any);
        while let Some(index) = current {
            chain.push(index);
            current = parents[index];
        }
        chain.reverse();

        // SDK recovery can put off-chain blocks of an on-chain assistant API
        // response back after its last block. Tools remain excluded from text.
        let mut anchors = HashMap::new();
        for &index in &chain {
            if let Some(id) = entries[index].response_id() {
                anchors.insert(id, index);
            }
        }
        let mut on_chain = vec![false; entries.len()];
        for &index in &chain {
            on_chain[index] = true;
        }
        let mut recovered: HashMap<usize, Vec<usize>> = HashMap::new();
        for (index, entry) in entries.iter().enumerate() {
            if on_chain[index] {
                continue;
            }
            if let Some(anchor) = entry.response_id().and_then(|id| anchors.get(id)) {
                // Identity collisions between writers cannot authorize recovery.
                if entry.value.get("agentId") != entries[*anchor].value.get("agentId")
                    || entry.visible != entries[*anchor].visible
                {
                    return Err(claude_error("ambiguous Claude response writer"));
                }
                recovered.entry(*anchor).or_default().push(index);
            } else if entry.visible && entry.kind() == "user" {
                // Pure tool_result blocks have no indexable text. Mixed text in
                // an off-chain result needs full SDK tool-call reconciliation;
                // never silently omit that text or guess which call it answers.
                let tool_result = entry.value["message"]["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"));
                if tool_result && entry.event()?.is_some() {
                    return Err(claude_error("unsupported Claude parallel result text"));
                }
            }
        }
        let mut ordered = Vec::with_capacity(entries.len());
        for index in chain {
            ordered.push(index);
            if let Some(mut siblings) = recovered.remove(&index) {
                // Stable timestamp order like the SDK; ties retain file order.
                siblings.sort_by(|&a, &b| {
                    entries[a].value["timestamp"]
                        .as_str()
                        .unwrap_or_default()
                        .cmp(entries[b].value["timestamp"].as_str().unwrap_or_default())
                });
                ordered.extend(siblings);
            }
        }
        Self::project(&entries, &ordered, max_events)
    }

    fn project(
        entries: &[ClaudeEntry],
        order: &[usize],
        max_events: usize,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        let mut events = Vec::new();
        for &index in order {
            if let Some(mut event) = entries[index].event()? {
                if events.len() >= max_events {
                    return Err(RuntimeError::SessionEventLimitExceeded);
                }
                // SQLite and its cursors order by seq, so persist the rebuilt
                // conversation order rather than the original JSONL line.
                event.seq = events.len() as u64 + 1;
                events.push(event);
            }
        }
        Ok(events)
    }
}

/// Text-only projection of Codex rollout messages using app-server turn
/// boundaries. Compaction is a structural marker; replacement_history remains
/// model context and is never exposed as transcript text.
pub struct CodexJsonlParser;
impl SessionParser for CodexJsonlParser {
    fn parse_increment(
        &self,
        path: &std::path::Path,
        _source_revision: u64,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        Ok(Self::parse_text(&fs::read_to_string(path)?, usize::MAX, false)?.into_events())
    }

    fn parse_snapshot_bytes(
        &self,
        bytes: &[u8],
        max_events: usize,
    ) -> RuntimeResult<Vec<SessionEvent>> {
        let text = std::str::from_utf8(bytes).map_err(|_| {
            RuntimeError::AdapterUnavailable("session snapshot is not UTF-8".into())
        })?;
        Ok(Self::parse_text(text, max_events, true)?.into_events())
    }

    fn parse_index_snapshot(
        &self,
        bytes: &[u8],
        max_events: usize,
    ) -> RuntimeResult<ParsedIndexSnapshot> {
        let text =
            std::str::from_utf8(bytes).map_err(|_| codex_error("session snapshot is not UTF-8"))?;
        Self::parse_text(text, max_events, true)
    }
}

fn codex_error(reason: &'static str) -> RuntimeError {
    RuntimeError::AdapterUnavailable(reason.into())
}

#[derive(Default)]
struct CodexTurn {
    events: Vec<SessionEvent>,
    boundary_text: String,
    has_user_event: bool,
    has_user_boundary: bool,
    turn_id: Option<String>,
    opened_explicitly: bool,
    saw_compaction: bool,
    saw_tool_item: bool,
}

#[derive(Default)]
struct CodexHistory {
    prefix: Vec<SessionEvent>,
    turns: Vec<CodexTurn>,
    current_turn: Option<CodexTurn>,
    pending_user_event: Option<String>,
    pending_agent_event: Option<String>,
    saw_recognized_record: bool,
    saw_rollback: bool,
    compaction_without_explicit_turn: bool,
    unsupported_rollback_boundary: bool,
    rollback_removed_visible_text: bool,
}

impl CodexHistory {
    fn ensure_turn(&mut self) -> &mut CodexTurn {
        self.current_turn.get_or_insert_with(CodexTurn::default)
    }

    fn finish_turn(&mut self) {
        if let Some(turn) = self.current_turn.take() {
            if !turn.events.is_empty()
                || turn.has_user_boundary
                || turn.saw_compaction
                || turn.saw_tool_item
                || turn.opened_explicitly
            {
                self.turns.push(turn);
            }
        }
    }

    fn turn_started(&mut self, turn_id: &str) {
        self.finish_turn();
        self.current_turn = Some(CodexTurn {
            turn_id: Some(turn_id.to_owned()),
            opened_explicitly: true,
            ..CodexTurn::default()
        });
        self.saw_recognized_record = true;
    }

    fn turn_completed(&mut self, turn_id: &str) {
        if !self
            .current_turn
            .as_ref()
            .is_some_and(|turn| turn.turn_id.as_deref() == Some(turn_id))
        {
            self.unsupported_rollback_boundary = true;
            return;
        }
        self.finish_turn();
        self.saw_recognized_record = true;
    }

    fn user_event(&mut self, message: &str) -> RuntimeResult<()> {
        if let Some(turn) = self.current_turn.as_mut().filter(|turn| {
            !turn.has_user_event && turn.boundary_text == message && !turn.boundary_text.is_empty()
        }) {
            turn.has_user_event = true;
            self.saw_recognized_record = true;
            return Ok(());
        }
        let starts_implicit_turn = self.current_turn.as_ref().is_some_and(|turn| {
            !turn.opened_explicitly && !(turn.saw_compaction && turn.events.is_empty())
        });
        if starts_implicit_turn {
            self.finish_turn();
        }
        self.saw_recognized_record = true;
        self.pending_user_event = Some(message.to_owned());
        let turn = self.ensure_turn();
        if turn.has_user_event {
            return Err(codex_error("ambiguous Codex user-message event"));
        }
        turn.has_user_event = true;
        turn.has_user_boundary = true;
        turn.boundary_text = message.to_owned();
        if !message.is_empty() && !is_codex_contextual_fragment(message) {
            turn.events.push(SessionEvent {
                seq: 0,
                role: "user".to_owned(),
                content: message.to_owned(),
                occurred_at: None,
            });
        } else if is_codex_contextual_fragment(message) {
            self.unsupported_rollback_boundary = true;
        }
        Ok(())
    }

    fn agent_event(&mut self, message: &str) {
        self.saw_recognized_record = true;
        if message.is_empty() || is_codex_inter_agent_message(message) {
            if is_codex_inter_agent_message(message) {
                self.unsupported_rollback_boundary = true;
            }
            return;
        }
        let turn = self.ensure_turn();
        turn.events.push(SessionEvent {
            seq: 0,
            role: "assistant".to_owned(),
            content: message.to_owned(),
            occurred_at: None,
        });
        self.pending_agent_event = Some(message.to_owned());
    }

    fn compacted(&mut self) {
        if !self
            .current_turn
            .as_ref()
            .is_some_and(|turn| turn.opened_explicitly)
        {
            self.compaction_without_explicit_turn = true;
        }
        self.ensure_turn().saw_compaction = true;
        self.saw_recognized_record = true;
    }

    fn response_message(&mut self, value: &serde_json::Value) -> RuntimeResult<()> {
        let payload = value
            .get("payload")
            .and_then(|v| v.as_object())
            .ok_or_else(|| codex_error("invalid Codex response item"))?;
        let item_type = payload
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| codex_error("invalid Codex response item type"))?;
        if item_type != "message" {
            match payload.get("type").and_then(|v| v.as_str()) {
                Some(
                    "function_call"
                    | "function_call_output"
                    | "reasoning"
                    | "web_search_call"
                    | "web_search_output"
                    | "custom_tool_call"
                    | "custom_tool_call_output"
                    | "local_shell_call"
                    | "image_generation_call"
                    | "image_generation_output"
                    | "compaction"
                    | "context_compaction"
                    | "tool_search_call"
                    | "tool_search_output",
                ) => {
                    self.ensure_turn().saw_tool_item = true;
                }
                // AgentMessage and future/unknown item kinds can carry user-turn
                // boundaries that this text projection cannot reconstruct.
                _ => self.unsupported_rollback_boundary = true,
            }
            return Ok(());
        }
        let Some(role_value) = payload.get("role").and_then(|v| v.as_str()) else {
            return Err(codex_error("invalid Codex message role"));
        };
        let role = match Some(role_value) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => return Ok(()),
        };
        self.saw_recognized_record = true;
        let raw_content = match payload.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(items)) => items
                .iter()
                .filter(|item| {
                    matches!(
                        item.get("type").and_then(|v| v.as_str()),
                        Some("input_text" | "output_text")
                    )
                })
                .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join(""),
            Some(serde_json::Value::Null) => String::new(),
            _ => return Err(codex_error("invalid Codex message content")),
        };
        let (content, contains_contextual_input) = if role == "user" {
            codex_visible_user_content(payload, &raw_content)
        } else {
            (raw_content.clone(), false)
        };
        if contains_contextual_input || (role == "user" && is_codex_summary(&raw_content)) {
            self.unsupported_rollback_boundary = true;
        }
        if role == "assistant" && is_codex_inter_agent_message(&content) {
            self.unsupported_rollback_boundary = true;
            return Ok(());
        }
        // An image-only or empty user message can still begin a turn. Only
        // fully contextual messages are excluded from turn reconstruction.
        let mut paired_user_event = false;
        if role == "user" && (!contains_contextual_input || !content.is_empty()) {
            paired_user_event = if let Some(pending) = self.pending_user_event.take() {
                if pending != raw_content {
                    return Err(codex_error("mismatched Codex user-message event"));
                }
                true
            } else {
                false
            };
            if !paired_user_event {
                self.finish_turn_if_implicit_user_boundary();
                let turn = self.ensure_turn();
                turn.boundary_text = raw_content;
                turn.has_user_event = false;
                turn.has_user_boundary = true;
            }
        }
        if !content.is_empty() && !paired_user_event {
            let event = SessionEvent {
                seq: 0,
                role: role.to_owned(),
                content,
                occurred_at: value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse().ok()),
            };
            if role == "user" && self.pending_user_event.is_none() {
                self.ensure_turn().events.push(event);
            } else if role == "assistant" {
                if self.pending_agent_event.as_deref() == Some(event.content.as_str()) {
                    self.pending_agent_event = None;
                } else if let Some(turn) = self.current_turn.as_mut() {
                    turn.events.push(event);
                } else {
                    self.prefix.push(event);
                }
            } else if let Some(turn) = self.current_turn.as_mut() {
                turn.events.push(event);
            } else {
                self.prefix.push(event);
            }
        }
        Ok(())
    }

    fn rollback(&mut self, num_turns: usize) -> RuntimeResult<()> {
        self.saw_rollback = true;
        if self.compaction_without_explicit_turn {
            return Err(codex_error(
                "Codex compaction rollback lacks explicit turn boundaries",
            ));
        }
        if self.unsupported_rollback_boundary {
            return Err(codex_error("unsupported Codex rollback boundary"));
        }
        if self.pending_user_event.is_some() || self.pending_agent_event.is_some() {
            return Err(codex_error("unmatched Codex user-message event"));
        }
        self.finish_turn();
        if num_turns == 0 || self.turns.is_empty() {
            return Ok(());
        }
        let remove = num_turns.min(self.turns.len());
        let first_removed = self.turns.len() - remove;
        let removed_text = self.turns[first_removed..]
            .iter()
            .any(|turn| !turn.events.is_empty());
        self.turns.truncate(first_removed);
        if removed_text && self.current_events().is_empty() {
            self.rollback_removed_visible_text = true;
        } else if removed_text {
            self.rollback_removed_visible_text = false;
        }
        Ok(())
    }

    fn replace_from_compaction(&mut self, value: &serde_json::Value) -> RuntimeResult<()> {
        if self.saw_rollback {
            return Err(codex_error(
                "Codex compaction after rollback cannot be projected as a transcript",
            ));
        }
        if self.current_events().is_empty() {
            return Err(codex_error(
                "Codex transcript before compaction unavailable",
            ));
        }
        let payload = value
            .get("payload")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| codex_error("invalid Codex compaction record"))?;
        if !payload
            .get("message")
            .is_some_and(serde_json::Value::is_string)
            || payload
                .get("replacement_history")
                .is_some_and(|history| !history.is_array())
        {
            return Err(codex_error("invalid Codex compaction record"));
        }
        // Upstream app-server treats Compacted as a history marker while
        // projecting transcript turns. replacement_history is a model-context
        // checkpoint, so deliberately do not replay or expose its contents.
        self.compacted();
        Ok(())
    }

    fn finish_turn_if_implicit_user_boundary(&mut self) {
        if self
            .current_turn
            .as_ref()
            .is_some_and(|turn| !turn.opened_explicitly && !turn.saw_compaction)
        {
            self.finish_turn();
        }
    }

    fn current_events(&self) -> Vec<SessionEvent> {
        self.prefix
            .iter()
            .cloned()
            .chain(
                self.turns
                    .iter()
                    .flat_map(|turn| turn.events.iter().cloned()),
            )
            .chain(
                self.current_turn
                    .iter()
                    .flat_map(|turn| turn.events.iter().cloned()),
            )
            .collect()
    }
}

fn codex_visible_user_content(
    payload: &serde_json::Map<String, serde_json::Value>,
    fallback: &str,
) -> (String, bool) {
    let Some(items) = payload.get("content").and_then(serde_json::Value::as_array) else {
        let contextual = is_codex_contextual_fragment(fallback);
        return (
            if contextual {
                String::new()
            } else {
                fallback.to_owned()
            },
            contextual,
        );
    };
    let kinds = payload
        .get("internal_chat_message_metadata_passthrough")
        .and_then(|metadata| metadata.get("content_item_kinds"))
        .and_then(serde_json::Value::as_array)
        .filter(|kinds| kinds.len() == items.len());
    let mut contextual = false;
    let visible = items
        .iter()
        .enumerate()
        .filter(|(_, item)| item.get("type").and_then(|v| v.as_str()) == Some("input_text"))
        .filter_map(|(index, item)| {
            let text = item.get("text").and_then(serde_json::Value::as_str)?;
            let kind = kinds
                .and_then(|kinds| kinds.get(index))
                .and_then(serde_json::Value::as_str);
            let hidden =
                kind.is_some_and(is_codex_contextual_kind) || is_codex_contextual_fragment(text);
            contextual |= hidden;
            (!hidden).then_some(text)
        })
        .collect::<Vec<_>>()
        .join("");
    (visible, contextual)
}

fn is_codex_contextual_kind(kind: &str) -> bool {
    matches!(
        kind,
        "environments.environment_context"
            | "agents_md.instructions"
            | "additional_context.user_fragment"
            | "agent_message_board.notification"
            | "codex_skills.skill_prompt"
            | "user_shell.command"
            | "turn_aborted.notice"
            | "subagent.notification"
            | "internal_model.context"
            | "recommended_plugins.instructions"
            | "legacy_unified_exec.process_limit_warning"
            | "legacy_apply_patch.exec_command_warning"
            | "legacy_model_mismatch.warning"
            | "guardian_retained_instructions"
    ) || kind.ends_with(".internal_context")
        || kind.starts_with("additional_content.")
}

#[derive(serde::Deserialize)]
#[serde(rename = "hook_prompt")]
struct CodexHookPrompt {
    #[serde(rename = "@hook_run_id")]
    hook_run_id: String,
    #[serde(rename = "$text")]
    _text: String,
}

fn is_codex_contextual_fragment(text: &str) -> bool {
    let trimmed = text.trim();
    let hook_prompt_root = trimmed
        .strip_prefix("<hook_prompt")
        .and_then(|suffix| suffix.chars().next())
        .is_some_and(|delimiter| matches!(delimiter, ' ' | '\t' | '\r' | '\n' | '>'));
    if hook_prompt_root
        && quick_xml::de::from_str::<CodexHookPrompt>(trimmed)
            .is_ok_and(|fragment| !fragment.hook_run_id.trim().is_empty())
    {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    const WRAPPED: &[(&str, &str)] = &[
        ("<environment_context>", "</environment_context>"),
        ("<environment_context_v2>", "</environment_context_v2>"),
        ("<subagent_notification>", "</subagent_notification>"),
        ("<recommended_plugins>", "</recommended_plugins>"),
        ("<additional_context>", "</additional_context>"),
        ("<turn_aborted>", "</turn_aborted>"),
        ("<skill>", "</skill>"),
    ];
    if WRAPPED.iter().any(|(open, close)| {
        lower.starts_with(open) && lower.ends_with(close) && lower.len() >= open.len() + close.len()
    }) {
        return true;
    }
    if trimmed.starts_with("<goal_context>") && trimmed.ends_with("</goal_context>") {
        return true;
    }
    if let Some(rest) = trimmed.strip_prefix("<external_") {
        if let Some((key, body)) = rest.split_once('>') {
            if body.ends_with(&format!("</external_{key}>")) {
                return true;
            }
        }
    }
    if let Some(rest) = trimmed.strip_prefix("<codex_internal_context source=\"") {
        if let Some((source, body)) = rest.split_once("\">") {
            let mut chars = source.chars();
            if chars.next().is_some_and(|c| c.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                && body.ends_with("</codex_internal_context>")
            {
                return true;
            }
        }
    }
    lower.starts_with("# agents.md instructions") && lower.ends_with("</instructions>")
}

fn is_codex_summary(text: &str) -> bool {
    text.starts_with("Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\n")
}

fn is_codex_inter_agent_message(text: &str) -> bool {
    let trimmed = text.trim_start();
    if trimmed.starts_with("<subagent_notification>")
        || (trimmed.starts_with("Message Type:")
            && trimmed
                .lines()
                .nth(1)
                .is_some_and(|line| line.starts_with("Task name:"))
            && trimmed
                .lines()
                .nth(2)
                .is_some_and(|line| line.starts_with("Sender:")))
    {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(trimmed)
        .ok()
        .is_some_and(|value| {
            value.get("author").and_then(|v| v.as_str()).is_some()
                && value.get("recipient").and_then(|v| v.as_str()).is_some()
                && value.get("content").and_then(|v| v.as_str()).is_some()
                && value
                    .get("trigger_turn")
                    .and_then(|v| v.as_bool())
                    .is_some()
        })
}

impl ParsedIndexSnapshot {
    fn into_events(self) -> Vec<SessionEvent> {
        match self {
            Self::Events(events) => events,
            Self::UnconfirmedEmpty | Self::ConfirmedEmptyCodexRollback => Vec::new(),
        }
    }
}

impl CodexJsonlParser {
    fn parse_text(
        text: &str,
        max_events: usize,
        strict: bool,
    ) -> RuntimeResult<ParsedIndexSnapshot> {
        const MAX_RECORDS: usize = 65_536;
        let mut history = CodexHistory::default();
        let mut records = 0usize;
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            records = records.saturating_add(1);
            if records > MAX_RECORDS {
                return Err(codex_error("Codex record limit exceeded"));
            }
            let value: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) if !strict => continue,
                Err(_) => return Err(codex_error("session snapshot contains invalid JSON")),
            };
            match value.get("type").and_then(|v| v.as_str()) {
                Some("response_item") => history.response_message(&value)?,
                Some("event_msg") if value["payload"]["type"] == "thread_rolled_back" => {
                    history.saw_recognized_record = true;
                    let count = value["payload"]["num_turns"]
                        .as_u64()
                        .filter(|n| *n <= u32::MAX as u64)
                        .ok_or_else(|| codex_error("invalid Codex rollback count"))?;
                    history.rollback(count as usize)?;
                }
                Some("event_msg") if value["payload"]["type"] == "user_message" => {
                    history.saw_recognized_record = true;
                    let message = value["payload"]["message"]
                        .as_str()
                        .ok_or_else(|| codex_error("invalid Codex user-message event"))?;
                    history.user_event(message)?;
                }
                Some("event_msg") if value["payload"]["type"] == "agent_message" => {
                    let message = value["payload"]["message"]
                        .as_str()
                        .ok_or_else(|| codex_error("invalid Codex agent-message event"))?;
                    history.agent_event(message);
                }
                Some("event_msg") if value["payload"]["type"] == "turn_started" => {
                    let turn_id = value["payload"]["turn_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| codex_error("invalid Codex turn-start event"))?;
                    history.turn_started(turn_id);
                }
                Some("event_msg") if value["payload"]["type"] == "turn_complete" => {
                    let turn_id = value["payload"]["turn_id"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or_else(|| codex_error("invalid Codex turn-complete event"))?;
                    history.turn_completed(turn_id);
                }
                Some("compacted") => history.replace_from_compaction(&value)?,
                Some("inter_agent_communication") => history.unsupported_rollback_boundary = true,
                _ => {}
            }
        }
        let mut events = history.current_events();
        if history.rollback_removed_visible_text && events.is_empty() {
            return Ok(ParsedIndexSnapshot::ConfirmedEmptyCodexRollback);
        }
        if events.is_empty() {
            return Ok(ParsedIndexSnapshot::UnconfirmedEmpty);
        }
        if events.len() > max_events {
            return Err(RuntimeError::SessionEventLimitExceeded);
        }
        for (index, event) in events.iter_mut().enumerate() {
            event.seq = index as u64 + 1;
        }
        Ok(ParsedIndexSnapshot::Events(events))
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
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"world"},{"type":"tool_use","text":"ignore","input":{"secret":"ignore"}}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","input":{"path":"/private"}}]}}"#).unwrap();
        let events = ClaudeJsonlParser.parse_increment(&path, 1).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].content, "hello");
        assert_eq!(events[1].content, "world");
    }
    fn claude_node(kind: &str, id: &str, parent: Option<&str>, text: &str) -> serde_json::Value {
        serde_json::json!({"type":kind,"uuid":id,"parentUuid":parent,
            "message":{"role":kind,"content":text}})
    }

    fn claude_rows(rows: &[serde_json::Value], limit: usize) -> RuntimeResult<Vec<SessionEvent>> {
        let jsonl = rows
            .iter()
            .map(|row| row.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        ClaudeJsonlParser.parse_snapshot_bytes(jsonl.as_bytes(), limit)
    }

    fn claude_text(rows: &[serde_json::Value], limit: usize) -> Vec<String> {
        claude_rows(rows, limit)
            .unwrap()
            .into_iter()
            .map(|e| e.content)
            .collect()
    }

    #[test]
    fn claude_latest_main_leaf_uses_file_order_not_timestamp_or_depth() {
        let root = claude_node("user", "u", None, "root");
        let mut old = claude_node("assistant", "old", Some("u"), "discarded");
        old["timestamp"] = "2030-01-01T00:00:00Z".into();
        let mut latest = claude_node("assistant", "new", Some("u"), "current");
        latest["timestamp"] = "2020-01-01T00:00:00Z".into();
        let rows = [
            root,
            old,
            claude_node("user", "old-child", Some("old"), "also discarded"),
            latest,
        ];
        assert_eq!(claude_text(&rows, 2), ["root", "current"]);
        let events = claude_rows(&rows, 2).unwrap();
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(
            events[1].occurred_at.unwrap().to_rfc3339(),
            "2020-01-01T00:00:00+00:00"
        );
    }

    #[test]
    fn claude_filters_meta_sidechain_and_team_without_breaking_chain_links() {
        for (flag, value) in [
            ("isMeta", serde_json::json!(true)),
            ("isSidechain", serde_json::json!(true)),
            ("teamName", serde_json::json!("team")),
        ] {
            let mut hidden = claude_node("user", "hidden", Some("u"), "hidden");
            hidden[flag] = value.clone();
            let mut side_leaf = claude_node("assistant", "side", Some("u"), "side");
            side_leaf[flag] = value;
            let rows = [
                claude_node("user", "u", None, "root"),
                hidden,
                claude_node("assistant", "a", Some("hidden"), "answer"),
                side_leaf,
            ];
            assert_eq!(claude_text(&rows, 2), ["root", "answer"]);
        }
        // SDK fallback when every terminal message is hidden keeps ancestors.
        let mut hidden = claude_node("assistant", "h", Some("u"), "hidden");
        hidden["isMeta"] = true.into();
        assert_eq!(
            claude_text(&[claude_node("user", "u", None, "root"), hidden], 1),
            ["root"]
        );
    }

    #[test]
    fn claude_uuidless_service_records_do_not_mix_identity_modes() {
        let mut root = claude_node("user", "u", None, "root");
        root.as_object_mut().unwrap().remove("parentUuid"); // SDK treats absence as root.
        let rows = [
            serde_json::json!({"type":"progress","parentUuid":"not-a-link"}),
            root,
            serde_json::json!({"type":"system","uuid":null,"subtype":"status"}),
            serde_json::json!({"type":"attachment","uuid":42,"parentUuid":"ignored"}),
            claude_node("assistant", "a", Some("u"), "answer"),
        ];
        assert_eq!(claude_text(&rows, 2), ["root", "answer"]);
        assert_eq!(claude_rows(&rows, 2).unwrap()[1].seq, 2);
        assert!(claude_rows(&[serde_json::json!({"type":"progress"})], 0)
            .unwrap()
            .is_empty());
        assert_eq!(
            claude_text(
                &[
                    serde_json::json!({"type":"system"}),
                    serde_json::json!({"type":"user","message":{"content":"fixture"}})
                ],
                1
            ),
            ["fixture"]
        );
    }

    #[test]
    fn claude_linked_service_nodes_and_terminal_tails_preserve_main_leaf() {
        let rows = [
            claude_node("user", "u", None, "root"),
            serde_json::json!({"type":"progress","uuid":"p","parentUuid":"u"}),
            serde_json::json!({"type":"attachment","uuid":"at","parentUuid":"p"}),
            claude_node("assistant", "a", Some("at"), "answer"),
            serde_json::json!({"type":"system","uuid":"tail","parentUuid":"a"}),
        ];
        assert_eq!(claude_text(&rows, 2), ["root", "answer"]);
    }

    #[test]
    fn claude_compaction_follows_parent_not_logical_parent_and_keeps_summary() {
        let mut boundary = serde_json::json!({"type":"system","uuid":"b","parentUuid":null,
            "subtype":"compact_boundary","logicalParentUuid":"old"});
        let mut summary = claude_node("user", "summary", Some("b"), "summary");
        summary["isCompactSummary"] = true.into();
        let rows = [
            claude_node("user", "old", None, "precompact"),
            boundary.take(),
            summary,
            claude_node("assistant", "a", Some("summary"), "answer"),
        ];
        assert_eq!(claude_text(&rows, 2), ["summary", "answer"]);
    }

    #[test]
    fn claude_rejects_bad_graphs_without_identifier_or_content_in_errors() {
        let root = claude_node("user", "sensitive-id", None, "sensitive-content");
        let cases = vec![
            vec![root.clone(), root.clone()],
            vec![
                root.clone(),
                claude_node("assistant", "a", Some("missing-sensitive-id"), "text"),
            ],
            vec![
                root.clone(),
                claude_node("assistant", "x", Some("y"), "x"),
                claude_node("assistant", "y", Some("x"), "y"),
            ],
            vec![claude_node("user", "self", Some("self"), "text")],
            vec![
                root.clone(),
                serde_json::json!({"type":"user","message":{"content":"flat"}}),
            ],
            vec![serde_json::json!({"type":"user","uuid":null,"message":{"content":"text"}})],
            vec![serde_json::json!({"type":"user","parentUuid":null,"message":{"content":"flat"}})],
            vec![serde_json::json!({"type":"user","sessionId":"s","message":{"content":"flat"}})],
            vec![
                serde_json::json!({"type":"user","uuid":"u","parentUuid":42,"message":{"content":"text"}}),
            ],
        ];
        for rows in cases {
            let error = claude_rows(&rows, 100).unwrap_err().to_string();
            assert!(!error.contains("sensitive"));
        }
        let mut a = root.clone();
        a["sessionId"] = "one".into();
        let mut b = claude_node("assistant", "b", Some("sensitive-id"), "text");
        b["sessionId"] = "two".into();
        assert!(claude_rows(&[a, b], 100).is_err());
    }

    #[test]
    fn claude_fixture_mode_filters_flags_and_rejects_graph_hints() {
        let visible = serde_json::json!({"type":"user","message":{"content":"fixture"}});
        let mut hidden = visible.clone();
        hidden["isSidechain"] = true.into();
        assert_eq!(claude_text(&[visible.clone(), hidden], 1), ["fixture"]);
        for field in [
            "logicalParentUuid",
            "agentId",
            "sourceToolAssistantUUID",
            "isCompactSummary",
        ] {
            let mut ambiguous = visible.clone();
            ambiguous[field] = serde_json::Value::Null;
            assert!(claude_rows(&[ambiguous], 100).is_err());
        }
        let mut ambiguous = visible;
        ambiguous["message"]["id"] = "response".into();
        assert!(claude_rows(&[ambiguous], 100).is_err());
    }

    #[test]
    fn claude_recovers_same_response_text_blocks_but_not_abandoned_response() {
        let mut first = claude_node("assistant", "a", Some("u"), "first");
        first["message"]["id"] = "response".into();
        let mut sibling = claude_node("assistant", "b", Some("a"), "recovered");
        sibling["message"]["id"] = "response".into();
        let mut abandoned = claude_node("assistant", "old", Some("u"), "abandoned");
        abandoned["message"]["id"] = "different".into();
        let rows = [
            claude_node("user", "u", None, "root"),
            abandoned,
            first,
            sibling,
            claude_node("user", "continue", Some("a"), "next"),
        ];
        assert_eq!(
            claude_text(&rows, 4),
            ["root", "first", "recovered", "next"]
        );
        assert!(matches!(
            claude_rows(&rows, 3),
            Err(RuntimeError::SessionEventLimitExceeded)
        ));
        let mut conflicting = rows.clone();
        conflicting[3]["agentId"] = "other-writer".into();
        assert!(claude_rows(&conflicting, 100).is_err());
    }

    #[test]
    fn claude_event_limit_counts_only_visible_nonempty_selected_text() {
        let mut empty = claude_node("assistant", "empty", Some("u"), "");
        empty["message"]["content"] =
            serde_json::json!([{"type":"tool_use","input":{"text":"excluded"}}]);
        let rows = [
            claude_node("user", "u", None, "root"),
            claude_node("assistant", "old", Some("u"), "discarded"),
            empty,
            claude_node("assistant", "a", Some("empty"), "answer"),
        ];
        assert_eq!(claude_text(&rows, 2), ["root", "answer"]);
        assert!(matches!(
            claude_rows(&rows, 1),
            Err(RuntimeError::SessionEventLimitExceeded)
        ));
        assert!(matches!(
            claude_rows(&rows, 0),
            Err(RuntimeError::SessionEventLimitExceeded)
        ));
        assert!(claude_rows(&[], 0).unwrap().is_empty());
    }

    #[test]
    fn claude_invalid_json_and_text_are_errors_in_both_entry_points() {
        for text in [
            "{broken",
            "{}",
            "[]",
            r#"{"type":"user","message":{"content":[{"type":"text","text":42}]}}"#,
            r#"{"type":"user","message":{"role":"assistant","content":"text"}}"#,
        ] {
            assert!(ClaudeJsonlParser
                .parse_snapshot_bytes(text.as_bytes(), 100)
                .is_err());
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("synthetic.jsonl");
            fs::write(&path, text).unwrap();
            assert!(ClaudeJsonlParser.parse_increment(&path, 1).is_err());
        }
        assert!(ClaudeJsonlParser
            .parse_snapshot_bytes(&[0xff], 100)
            .is_err());
    }

    #[test]
    fn claude_record_budget_bounds_even_ignored_service_records() {
        let text = "{\"type\":\"progress\"}\n".repeat(65_536);
        assert!(ClaudeJsonlParser
            .parse_snapshot_bytes(text.as_bytes(), 0)
            .unwrap()
            .is_empty());
        assert!(ClaudeJsonlParser
            .parse_snapshot_bytes((text + "{\"type\":\"progress\"}").as_bytes(), 0)
            .is_err());
    }

    #[test]
    fn claude_forward_parent_references_and_hidden_only_files_are_supported() {
        let rows = [
            claude_node("assistant", "a", Some("u"), "answer"),
            claude_node("user", "u", None, "root"),
        ];
        assert_eq!(claude_text(&rows, 2), ["root", "answer"]);
        let mut hidden = claude_node("user", "hidden", None, "excluded");
        hidden["teamName"] = "team".into();
        assert!(claude_rows(&[hidden], 0).unwrap().is_empty());
    }

    #[test]
    fn claude_service_record_skipping_never_repairs_missing_referenced_nodes() {
        let rows = [
            serde_json::json!({"type":"progress","parentUuid":"u"}),
            claude_node("assistant", "a", Some("missing-progress-id"), "answer"),
        ];
        assert!(claude_rows(&rows, 10).is_err());
        let mut malformed = claude_node("user", "u", None, "text");
        malformed["isMeta"] = "false".into();
        assert!(claude_rows(&[malformed], 10).is_err());
    }

    #[test]
    fn claude_parallel_tool_results_exclude_tools_and_reject_ambiguous_text() {
        let root = claude_node("user", "u", None, "root");
        let mut orphan = claude_node("user", "result", Some("u"), "");
        orphan["message"]["content"] = serde_json::json!([
            {"type":"tool_result","tool_use_id":"call","content":"excluded"}
        ]);
        let answer = claude_node("assistant", "a", Some("u"), "answer");
        assert_eq!(
            claude_text(&[root.clone(), orphan.clone(), answer.clone()], 2),
            ["root", "answer"]
        );
        orphan["message"]["content"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"type":"text","text":"unsupported orphan text"}));
        assert!(claude_rows(&[root, orphan, answer], 10).is_err());
    }

    #[test]
    fn codex_parser_extracts_response_items_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        fs::write(&path,r#"{"type":"session_meta","payload":{"session_id":"s"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"type":"response_item","payload":{"type":"function_call","role":"assistant","content":"secret","name":"shell","arguments":"secret"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"world"},{"type":"tool_result","text":"private"}]}}"#).unwrap();
        let events = CodexJsonlParser.parse_increment(&path, 1).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].content, "world");
    }

    fn codex_response(role: &str, text: &str) -> String {
        let block = if role == "user" {
            "input_text"
        } else {
            "output_text"
        };
        serde_json::json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":block,"text":text}]}}).to_string()
    }

    fn codex_rollback(count: u64) -> String {
        serde_json::json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":count}}).to_string()
    }

    fn codex_index(text: &str, max_events: usize) -> RuntimeResult<ParsedIndexSnapshot> {
        CodexJsonlParser.parse_index_snapshot(text.as_bytes(), max_events)
    }

    #[test]
    fn codex_rollback_removes_the_latest_user_turn_and_resequences_projection() {
        let text = [
            codex_response("user", "first question"),
            codex_response("assistant", "first answer"),
            codex_response("user", "discard question"),
            codex_response("assistant", "discard answer"),
            codex_rollback(1),
        ]
        .join("\n");
        let ParsedIndexSnapshot::Events(events) = codex_index(&text, 2).unwrap() else {
            panic!("expected events")
        };
        assert_eq!(
            events
                .iter()
                .map(|event| (event.role.as_str(), event.content.as_str(), event.seq))
                .collect::<Vec<_>>(),
            [
                ("user", "first question", 1),
                ("assistant", "first answer", 2),
            ]
        );
    }

    #[test]
    fn codex_rollback_to_empty_is_a_distinct_confirmed_state() {
        let text = format!(
            "{}\n{}\n{}",
            codex_response("user", "remove me"),
            codex_response("assistant", "stale answer"),
            codex_rollback(1)
        );
        assert_eq!(
            codex_index(&text, 1).unwrap(),
            ParsedIndexSnapshot::ConfirmedEmptyCodexRollback
        );
        assert_eq!(
            codex_index("", 1).unwrap(),
            ParsedIndexSnapshot::UnconfirmedEmpty
        );
        assert_eq!(
            codex_index(r#"{"type":"session_meta","payload":{}}"#, 1).unwrap(),
            ParsedIndexSnapshot::UnconfirmedEmpty
        );
    }

    #[test]
    fn codex_repeated_rollbacks_replay_against_current_history() {
        let text = [
            codex_response("user", "keep question"),
            codex_response("assistant", "keep answer"),
            codex_response("user", "remove question"),
            codex_response("assistant", "remove answer"),
            codex_rollback(1),
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"replacement question"}}).to_string(),
            codex_response("user", "replacement question"),
            codex_response("assistant", "replacement answer"),
            codex_rollback(1),
        ].join("\n");
        let ParsedIndexSnapshot::Events(events) = codex_index(&text, 2).unwrap() else {
            panic!("expected surviving first turn")
        };
        assert_eq!(
            events
                .iter()
                .map(|event| event.content.as_str())
                .collect::<Vec<_>>(),
            ["keep question", "keep answer"]
        );
    }

    #[test]
    fn codex_image_only_user_turn_remains_a_rollback_boundary() {
        let image_only = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,fixture"}]}}).to_string();
        let text = [
            codex_response("user", "keep question"),
            codex_response("assistant", "keep answer"),
            image_only,
            codex_response("assistant", "remove answer"),
            codex_rollback(1),
        ]
        .join("\n");
        let ParsedIndexSnapshot::Events(events) = codex_index(&text, 10).unwrap() else {
            panic!("expected surviving turn")
        };
        assert_eq!(
            events
                .iter()
                .map(|event| event.content.as_str())
                .collect::<Vec<_>>(),
            ["keep question", "keep answer"]
        );
    }

    #[test]
    fn codex_event_before_response_counts_once_across_multiple_rollbacks() {
        let mut rows = Vec::new();
        for question in ["first question", "second question", "third question"] {
            rows.push(serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":question}}).to_string());
            rows.push(codex_response("user", question));
            rows.push(codex_response("assistant", "answer"));
        }
        rows.extend((0..3).map(|_| codex_rollback(1)));
        assert_eq!(
            codex_index(&rows.join("\n"), 10).unwrap(),
            ParsedIndexSnapshot::ConfirmedEmptyCodexRollback
        );
    }

    #[test]
    fn codex_rollback_fails_closed_for_contextual_and_inter_agent_boundaries() {
        let summary = format!(
            "{}\n{}\n{}\n{}",
            codex_response("user", "original question"),
            codex_response("assistant", "original answer"),
            codex_response("user", "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\nsummary"),
            codex_rollback(1)
        );
        assert!(codex_index(&summary, 10).is_err());
        let inter_agent = format!(
            "{}\n{}",
            codex_response(
                "assistant",
                r#"{"author":"root","recipient":"worker","content":"task","trigger_turn":true}"#
            ),
            codex_rollback(1)
        );
        assert!(codex_index(&inter_agent, 10).is_err());
        let unknown_boundary = format!(
            "{}\n{}\n{}",
            codex_response("user", "ordinary"),
            serde_json::json!({"type":"response_item","payload":{"type":"future_agent_item"}}),
            codex_rollback(1)
        );
        assert!(codex_index(&unknown_boundary, 10).is_err());
    }

    #[test]
    fn codex_contextual_fragments_are_filtered_and_user_markup_survives() {
        let context_only = serde_json::json!({
            "type":"response_item",
            "payload":{
                "type":"message","role":"user",
                "content":[{"type":"input_text","text":"<environment_context>synthetic context</environment_context>"}]
            }
        }).to_string();
        let ParsedIndexSnapshot::Events(context_and_markup) = codex_index(
            &[
                context_only.clone(),
                codex_response("user", "Explain <section> markup and <b> keep this text"),
            ]
            .join("\n"),
            10,
        )
        .unwrap() else {
            panic!("expected user markup event")
        };
        assert_eq!(context_and_markup.len(), 1);
        assert_eq!(
            context_and_markup[0].content,
            "Explain <section> markup and <b> keep this text"
        );
        assert!(codex_index(&format!("{}\n{}", context_only, codex_rollback(1)), 10).is_err());
    }

    #[test]
    fn codex_contextual_input_keeps_rollback_fail_closed() {
        let contextual = serde_json::json!({
            "type":"response_item",
            "payload":{
                "type":"message","role":"user",
                "content":[{"type":"input_text","text":"<environment_context>synthetic context</environment_context>"}]
            }
        }).to_string();
        assert!(codex_index(&format!("{}\n{}", contextual, codex_rollback(1)), 10).is_err());
    }

    #[test]
    fn codex_contextual_item_metadata_filters_only_annotated_item_in_mixed_content() {
        let message = serde_json::json!({
            "type":"response_item",
            "payload":{
                "type":"message","role":"user",
                "content":[
                    {"type":"input_text","text":"<environment_context>synthetic context</environment_context>"},
                    {"type":"input_text","text":"Please explain <section> markup"}
                ],
                "internal_chat_message_metadata_passthrough":{
                    "content_item_kinds":["environments.environment_context","user.text"]
                }
            }
        }).to_string();
        let ParsedIndexSnapshot::Events(events) = codex_index(&message, 10).unwrap() else {
            panic!("expected visible event")
        };
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].content, "Please explain <section> markup");
    }

    #[test]
    fn codex_contextual_filter_preserves_unknown_tags_and_mixed_single_item() {
        let unknown = codex_response("user", "<custom_context>retain</custom_context>");
        let mixed_marker = codex_response(
            "user",
            "Question <environment_context>maybe context</environment_context> still user text",
        );
        let ParsedIndexSnapshot::Events(events) =
            codex_index(&[unknown, mixed_marker].join("\n"), 10).unwrap()
        else {
            panic!("expected events")
        };
        assert_eq!(
            events
                .iter()
                .map(|event| event.content.as_str())
                .collect::<Vec<_>>(),
            [
                "<custom_context>retain</custom_context>",
                "Question <environment_context>maybe context</environment_context> still user text",
            ]
        );
    }

    #[test]
    fn codex_compaction_and_unmatched_event_boundaries_are_explicit_errors() {
        let compacted = serde_json::json!({"type":"compacted","payload":{"message":"summary","replacement_history":[],"window_number":1,"resume_metadata":{}}}).to_string();
        assert!(codex_index(&compacted, 10).is_err());
        let unmatched = serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"no response item"}}).to_string();
        assert!(codex_index(&format!("{}\n{}", unmatched, codex_rollback(1)), 10).is_err());
    }

    #[test]
    fn codex_compaction_keeps_rollout_transcript_and_ignores_model_replacement() {
        let compacted = serde_json::json!({
            "type":"compacted",
            "payload":{
                "message":"summary must not appear",
                "replacement_history":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"replacement must not appear"}]}
                ],
                "window_number":1,
                "resume_metadata":{}
            }
        })
        .to_string();
        let text = [
            codex_response("user", "original question"),
            codex_response("assistant", "original answer"),
            compacted,
            codex_response("user", "later question"),
            codex_response("assistant", "later answer"),
        ]
        .join("\n");
        let ParsedIndexSnapshot::Events(events) = codex_index(&text, 4).unwrap() else {
            panic!("expected transcript events")
        };
        assert_eq!(
            events
                .iter()
                .map(|event| (event.role.as_str(), event.content.as_str(), event.seq))
                .collect::<Vec<_>>(),
            [
                ("user", "original question", 1),
                ("assistant", "original answer", 2),
                ("user", "later question", 3),
                ("assistant", "later answer", 4),
            ]
        );
        assert!(!events.iter().any(|event| {
            event.content.contains("summary must not appear")
                || event.content.contains("replacement must not appear")
        }));
    }

    #[test]
    fn codex_compaction_with_rollback_fails_closed_in_either_order() {
        let compacted = serde_json::json!({
            "type":"compacted",
            "payload":{"message":"summary","replacement_history":[]}
        })
        .to_string();
        for text in [
            [
                codex_response("user", "question"),
                compacted.clone(),
                codex_rollback(1),
            ]
            .join("\n"),
            [
                codex_response("user", "question"),
                codex_rollback(1),
                compacted.clone(),
            ]
            .join("\n"),
        ] {
            assert!(codex_index(&text, 10).is_err());
        }
    }

    #[test]
    fn codex_malformed_compaction_record_fails_closed() {
        for text in [
            r#"{"type":"compacted","payload":{}}"#,
            r#"{"type":"compacted","payload":{"message":"summary","replacement_history":{}}}"#,
        ] {
            assert!(codex_index(text, 10).is_err());
        }
    }

    #[test]
    fn codex_checkpoint_without_prior_transcript_is_not_claimed_complete() {
        let checkpoint = serde_json::json!({"type":"compacted","payload":{"message":"summary","replacement_history":[]}});
        let text = format!("{checkpoint}\n{}", codex_response("assistant", "later"));
        assert!(codex_index(&text, 10).is_err());
    }

    #[test]
    fn codex_event_limit_is_checked_after_rollback_reconstruction() {
        let text = [
            codex_response("user", "keep question"),
            codex_response("assistant", "keep answer"),
            codex_response("user", "remove question"),
            codex_response("assistant", "remove answer"),
            codex_rollback(1),
        ]
        .join("\n");
        assert!(matches!(
            codex_index(&text, 1),
            Err(RuntimeError::SessionEventLimitExceeded)
        ));
        assert!(matches!(
            codex_index(&text, 2),
            Ok(ParsedIndexSnapshot::Events(_))
        ));
    }
}
