//! Phase 5 / local session-reader integration prototype (task 2).
//!
//! Task notes: native owner/device session and project ownership are checked
//! online before consent/work and before returning metadata to Tauri; offline access fails
//! closed until a revocable offline authority protocol exists. Root
//! selection and every indexing/metadata release require native mediation.
//! Grants are process-lifetime only; each owns a separate in-memory LocalStore.
//! No shared/persistent database, cloud outbox, CLI probe or execution. Only
//! fixed native auth/ownership GETs use the network; local data never do.
//! Native dialogs/packaged lifecycle and OS isolation still need acceptance;
//! release remains disabled. Backup/provider egress decisions remain OPEN.
//! Metadata listing uses only the bounded accessor on that grant-owned store.
//!
//! The bounded walker/indexer are application controls, NOT an OS sandbox.
//! Same-device mounts, hostile renames, syscall latency and live-file snapshots
//! retain the limitations documented by the runtime. Dropping/revoking a grant
//! is not secure erasure of process memory, swap or an already delivered reply.
//! Content open/search IPC is unconditionally disabled, even in debug: Tauri
//! serializes/delivers after the handler returns, outside the reader's checks.
//! Metadata/index replies may still arrive after revoke if already returned to
//! Tauri; no atomic revoke-versus-delivery guarantee is provided. Remote revoke
//! is observed through fresh GETs, not push; previously delivered data cannot
//! be recalled. Content worker helpers below are synthetic test prototypes only.
//! Inactive stores are dropped at the next worker boundary, not synchronously
//! by logout. Reader consent is separate from remote-run ProjectGrant policy.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use crate::native::{NativeSessionBinding, NativeState};
use aelys_runtime::adapter::AdapterKind;
#[cfg(test)]
use aelys_runtime::db::{
    LocalLiteralSearchHit, LocalSessionContentItem, LocalSessionReadRequest,
    LocalSessionSearchRequest,
};
use aelys_runtime::db::{LocalSessionCursor, LocalStore};
use aelys_runtime::discovery::{DiscoveryLimits, DiscoveryState, SessionDiscovery};
use aelys_runtime::indexing::{CandidateStatus, IndexingLimits, SessionIndexingCoordinator};
use aelys_runtime::paths::AuthorizedRoot;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewWindow};
use uuid::Uuid;

#[path = "session_reader_native.rs"]
mod native_ui;

type Result<T> = std::result::Result<T, String>;
const MAX_GRANTS: usize = 4;
const MAX_GRANT_BYTES: usize = 16 * 1024 * 1024;
// Match the runtime's default bounded snapshot size; discovery and reading
// must use the same cap so eligible files are not silently excluded.
const MAX_SESSION_BYTES: usize = 4 * 1024 * 1024;
const MAX_GRANT_CANDIDATES: usize = 128;
const MAX_GRANT_WORK: usize = 16_384;
const MAX_PENDING_CANDIDATES: usize = 4;
#[cfg(test)]
const MAX_CONTENT_ITEMS: usize = 100;
#[cfg(test)]
const MIN_CONTENT_BYTES: usize = 4;
#[cfg(test)]
const MAX_CONTENT_BYTES: usize = 64 * 1024;

#[derive(Clone)]
enum ReaderIdentity {
    Native(NativeSessionBinding),
    // Worker tests use synthetic authority only. No test constructor or bypass
    // exists in the production transport or IPC contract.
    #[cfg(test)]
    Fixture(Arc<AtomicBool>),
}

impl ReaderIdentity {
    fn check(&self) -> Result<()> {
        match self {
            Self::Native(binding) => binding.ensure_active(),
            #[cfg(test)]
            Self::Fixture(active) => {
                if active.load(Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err("SIGN_IN_REQUIRED".into())
                }
            }
        }
    }

    fn native(&self) -> Result<&NativeSessionBinding> {
        match self {
            Self::Native(binding) => Ok(binding),
            #[cfg(test)]
            Self::Fixture(_) => Err("READER_IDENTITY_UNAVAILABLE".into()),
        }
    }
}

#[derive(Clone)]
struct ReaderAccess {
    active: Arc<AtomicBool>,
    identity: ReaderIdentity,
    project_id: Uuid,
}

impl ReaderAccess {
    fn check(&self) -> Result<()> {
        if let Err(error) = self.identity.check() {
            self.active.store(false, Ordering::SeqCst);
            return Err(error);
        }
        if !self.active.load(Ordering::SeqCst) {
            return Err("READER_GRANT_REVOKED".into());
        }
        Ok(())
    }

    async fn authorize(&self, native: &NativeState) -> Result<()> {
        self.check()?;
        let result = native
            .validate_session_project(self.identity.native()?, &self.project_id.to_string())
            .await;
        if result.as_ref().is_err_and(|error| {
            matches!(
                error.as_str(),
                "SIGN_IN_REQUIRED" | "READER_PROJECT_UNAVAILABLE"
            )
        }) {
            self.active.store(false, Ordering::SeqCst);
        }
        result?;
        self.check()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReaderAdapter {
    ClaudeCode,
    CodexCli,
}

impl ReaderAdapter {
    fn kind(self) -> AdapterKind {
        match self {
            Self::ClaudeCode => AdapterKind::ClaudeCode,
            Self::CodexCli => AdapterKind::CodexCli,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::CodexCli => "codex_cli",
        }
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["jsonl"],
            Self::CodexCli => &["jsonl", "jsonl.zst"],
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GrantInfo {
    grant_id: Uuid,
    project_id: Uuid,
    adapter: ReaderAdapter,
    persistent: bool,
}

#[derive(Debug, Serialize)]
pub struct IndexPage {
    entries_visited: usize,
    work_units: usize,
    attempted: usize,
    indexed: usize,
    rejected: usize,
    oversized: usize,
    inaccessible: usize,
    unsupported: usize,
    event_limit: usize,
    compression_rejected: usize,
    expanded_limit: usize,
    representation_conflict: usize,
    indexed_events: usize,
    bytes_charged: usize,
    expanded_bytes_charged: usize,
    discovery_state: &'static str,
    budget_exhausted: bool,
}

struct Grant {
    project_id: Uuid,
    adapter: ReaderAdapter,
    root: AuthorizedRoot,
    store: LocalStore,
    discovery: SessionDiscovery,
    pending_candidates: VecDeque<PathBuf>,
    pending_page_state: Option<DiscoveryState>,
    active: Arc<AtomicBool>,
    identity: ReaderIdentity,
    bytes_charged: usize,
    expanded_bytes_charged: usize,
    candidates_attempted: usize,
    work_units: usize,
    finished: bool,
}

impl Grant {
    fn check(&self) -> Result<()> {
        if let Err(error) = self.identity.check() {
            self.active.store(false, Ordering::SeqCst);
            return Err(error);
        }
        if !self.active.load(Ordering::SeqCst) {
            return Err("READER_GRANT_REVOKED".into());
        }
        // Revalidate the pinned descriptor against its namespace, including
        // before a future metadata list that would otherwise read only SQLite.
        // A zero-work new walker does not enumerate or read session contents.
        SessionDiscovery::new(&self.root, self.adapter.extensions(), discovery_limits())
            .map_err(|_| "READER_ROOT_UNAVAILABLE".to_string())?;
        Ok(())
    }

    fn index_next(&mut self) -> Result<IndexPage> {
        self.check()?;
        if self.finished {
            return Err("READER_PASS_FINISHED".into());
        }
        if MAX_GRANT_BYTES.saturating_sub(self.bytes_charged) < MAX_SESSION_BYTES
            || self.candidates_attempted >= MAX_GRANT_CANDIDATES
            || self.work_units > MAX_GRANT_WORK - 256
        {
            return Err("READER_BUDGET_EXHAUSTED".into());
        }
        let (entries_visited, page_work_units, oversized, inaccessible) =
            if self.pending_page_state.is_none() {
                let page = self
                    .discovery
                    .next_page()
                    .map_err(|_| "READER_DISCOVERY_FAILED".to_string())?;
                self.check()?;
                if page.candidates.len() > MAX_PENDING_CANDIDATES {
                    return Err("READER_DISCOVERY_FAILED".into());
                }
                self.pending_candidates.extend(page.candidates);
                self.pending_page_state = Some(page.state);
                self.work_units += page.work_units;
                (
                    page.entries_visited,
                    page.work_units,
                    page.skipped.oversized,
                    page.skipped.unavailable
                        + page.skipped.depth_limited
                        + page.skipped.path_limited
                        + page.skipped.cross_device_or_cycle,
                )
            } else {
                (0, 0, 0, 0)
            };
        let page_state = self
            .pending_page_state
            .ok_or_else(|| "READER_DISCOVERY_FAILED".to_string())?;
        // An exhausted decompression budget must not block plain files already
        // in this bounded discovery page. Preserve all compressed candidates.
        let expanded_remaining = MAX_GRANT_BYTES.saturating_sub(self.expanded_bytes_charged);
        if expanded_remaining < MAX_SESSION_BYTES {
            let mut plain = VecDeque::new();
            let mut compressed = VecDeque::new();
            for path in self.pending_candidates.drain(..) {
                if self.adapter == ReaderAdapter::CodexCli
                    && path
                        .to_str()
                        .is_some_and(|s| s.to_ascii_lowercase().ends_with(".jsonl.zst"))
                {
                    compressed.push_back(path);
                } else {
                    plain.push_back(path);
                }
            }
            plain.extend(compressed);
            self.pending_candidates = plain;
        }
        let candidates: Vec<_> = self
            .pending_candidates
            .iter()
            .take(4.min(MAX_GRANT_CANDIDATES - self.candidates_attempted))
            .cloned()
            .collect();
        let report = SessionIndexingCoordinator::new(&self.store)
            .index_batch_with_expanded_budget(
                &self.root,
                self.project_id,
                self.adapter.kind(),
                &candidates,
                IndexingLimits {
                    max_files: 4.min(MAX_GRANT_CANDIDATES - self.candidates_attempted),
                    max_file_bytes: MAX_SESSION_BYTES,
                    max_batch_bytes: MAX_SESSION_BYTES.min(MAX_GRANT_BYTES - self.bytes_charged),
                    max_events: 10_000,
                },
                expanded_remaining,
            )
            .map_err(|_| "READER_INDEX_FAILED".to_string())?;
        if report.outcomes.len() > candidates.len()
            || report.unattempted != candidates.len() - report.outcomes.len()
        {
            return Err("READER_INDEX_FAILED".into());
        }
        for _ in 0..report.outcomes.len() {
            self.pending_candidates.pop_front();
        }
        self.bytes_charged += report.bytes_charged;
        self.expanded_bytes_charged += report.expanded_bytes_charged;
        self.candidates_attempted += report.outcomes.len();
        let stopped_with_unattempted = !self.pending_candidates.is_empty();
        if !stopped_with_unattempted {
            self.pending_page_state = None;
            self.finished = page_state != DiscoveryState::More;
        }
        let indexed = report
            .outcomes
            .iter()
            .filter(|outcome| outcome.status == CandidateStatus::Indexed)
            .count();
        self.check()?;
        Ok(IndexPage {
            entries_visited,
            work_units: page_work_units,
            attempted: report.outcomes.len(),
            indexed,
            rejected: report.outcomes.len() - indexed,
            oversized,
            inaccessible: inaccessible
                + report
                    .outcomes
                    .iter()
                    .filter(|item| item.status == CandidateStatus::ReadRejected)
                    .count(),
            unsupported: report
                .outcomes
                .iter()
                .filter(|item| {
                    matches!(
                        item.status,
                        CandidateStatus::ParseRejected | CandidateStatus::EmptySnapshot
                    )
                })
                .count(),
            event_limit: report
                .outcomes
                .iter()
                .filter(|item| item.status == CandidateStatus::EventLimitExceeded)
                .count(),
            compression_rejected: report
                .outcomes
                .iter()
                .filter(|item| item.status == CandidateStatus::CompressionRejected)
                .count(),
            expanded_limit: report
                .outcomes
                .iter()
                .filter(|item| item.status == CandidateStatus::ExpandedLimitExceeded)
                .count(),
            representation_conflict: report
                .outcomes
                .iter()
                .filter(|item| item.status == CandidateStatus::RepresentationConflict)
                .count(),
            indexed_events: report.indexed_events,
            bytes_charged: report.bytes_charged,
            expanded_bytes_charged: report.expanded_bytes_charged,
            discovery_state: if stopped_with_unattempted {
                "more"
            } else {
                match page_state {
                    DiscoveryState::More => "more",
                    DiscoveryState::Exhausted => "exhausted",
                    DiscoveryState::ExhaustedWithOmissions => "exhausted_with_omissions",
                }
            },
            budget_exhausted: !self.finished
                && (MAX_GRANT_BYTES.saturating_sub(self.bytes_charged) < MAX_SESSION_BYTES
                    || (MAX_GRANT_BYTES.saturating_sub(self.expanded_bytes_charged)
                        < MAX_SESSION_BYTES
                        && self.pending_candidates.front().is_some_and(|path| {
                            self.adapter == ReaderAdapter::CodexCli
                                && path
                                    .to_str()
                                    .is_some_and(|s| s.to_ascii_lowercase().ends_with(".jsonl.zst"))
                        }))
                    || self.candidates_attempted >= MAX_GRANT_CANDIDATES
                    || self.work_units > MAX_GRANT_WORK - 256),
        })
    }

    fn list(&self, after: Option<Uuid>, limit: usize) -> Result<ReaderSessionPage> {
        validate_page_limit(limit)?;
        self.check()?;
        let rows = self
            .store
            .grant_session_summaries(self.project_id, self.adapter.kind(), after, limit)
            .map_err(|_| "READER_METADATA_FAILED".to_string())?;
        self.check()?;
        // Deliberate projection: future additions to the runtime DTO cannot
        // silently expand the desktop IPC allowlist.
        let sessions: Vec<_> = rows
            .into_iter()
            .map(|row| ReaderSessionMetadata {
                session_index_id: row.session_index_id,
                project_id: self.project_id,
                adapter: self.adapter,
                started_at: row.started_at,
                last_activity_at: row.last_activity_at,
                state: "indexed_snapshot",
                message_count: row.message_count,
            })
            .collect();
        let next_after = if sessions.len() == limit {
            sessions.last().map(|s| s.session_index_id)
        } else {
            None
        };
        Ok(ReaderSessionPage {
            sessions,
            next_after,
        })
    }

    #[cfg(test)]
    fn open(
        &self,
        session_id: Uuid,
        cursor: Option<LocalSessionCursor>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Vec<LocalSessionContentItem>> {
        validate_content_bounds(limit, max_bytes)?;
        self.check()?;
        let result = self
            .store
            .read_grant_session_content(&LocalSessionReadRequest {
                project_id: self.project_id,
                adapter: self.adapter.kind(),
                session_id,
                cursor,
                limit,
                max_bytes,
            })
            .map_err(|_| "READER_CONTENT_UNAVAILABLE".to_string())?;
        self.check()?;
        Ok(result)
    }

    #[cfg(test)]
    fn search(
        &self,
        session_id: Uuid,
        query: String,
        cursor: Option<LocalSessionCursor>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Vec<LocalLiteralSearchHit>> {
        validate_content_bounds(limit, max_bytes)?;
        if query.is_empty() || query.len() > 4096 {
            return Err("READER_INVALID_QUERY".into());
        }
        self.check()?;
        let result = self
            .store
            .search_grant_session_literal(&LocalSessionSearchRequest {
                project_id: self.project_id,
                adapter: self.adapter.kind(),
                session_id,
                query,
                cursor,
                limit,
                max_bytes,
            })
            .map_err(|_| "READER_CONTENT_UNAVAILABLE".to_string())?;
        self.check()?;
        Ok(result)
    }
}

#[cfg(test)]
fn validate_content_bounds(limit: usize, max_bytes: usize) -> Result<()> {
    if limit == 0
        || limit > MAX_CONTENT_ITEMS
        || !(MIN_CONTENT_BYTES..=MAX_CONTENT_BYTES).contains(&max_bytes)
    {
        Err("READER_INVALID_LIMIT".into())
    } else {
        Ok(())
    }
}

fn validate_page_limit(limit: usize) -> Result<()> {
    if limit == 0 || limit > 100 {
        Err("READER_INVALID_LIMIT".into())
    } else {
        Ok(())
    }
}

fn discovery_limits() -> DiscoveryLimits {
    DiscoveryLimits {
        max_files: 4,
        max_entries: 256,
        max_depth: 16,
        max_file_bytes: MAX_SESSION_BYTES as u64,
    }
}

enum Action {
    Register {
        root: AuthorizedRoot,
        project_id: Uuid,
        adapter: ReaderAdapter,
        id: Uuid,
        active: Arc<AtomicBool>,
        identity: ReaderIdentity,
    },
    Consent(Uuid),
    Index(Uuid),
    List {
        id: Uuid,
        after: Option<Uuid>,
        limit: usize,
    },
    #[cfg(test)]
    Open {
        id: Uuid,
        session_id: Uuid,
        cursor: Option<LocalSessionCursor>,
        limit: usize,
        max_bytes: usize,
    },
    #[cfg(test)]
    Search {
        id: Uuid,
        session_id: Uuid,
        query: String,
        cursor: Option<LocalSessionCursor>,
        limit: usize,
        max_bytes: usize,
    },
    Cleanup,
}

enum Reply {
    Grant(GrantInfo),
    // Private native UI input, deliberately not Serialize or an IPC response.
    Consent {
        path: PathBuf,
        project_id: Uuid,
        adapter: ReaderAdapter,
    },
    Page(IndexPage),
    Sessions(ReaderSessionPage),
    #[cfg(test)]
    Content(Vec<LocalSessionContentItem>),
    #[cfg(test)]
    SearchHits(Vec<LocalLiteralSearchHit>),
    Empty,
}

#[derive(Default)]
struct Reader {
    grants: HashMap<Uuid, Grant>,
}

impl Reader {
    fn cleanup(&mut self) {
        self.grants.retain(|_, grant| {
            let current = grant.identity.check().is_ok() && grant.active.load(Ordering::SeqCst);
            if !current {
                grant.active.store(false, Ordering::SeqCst);
            }
            current
        });
    }

    fn handle(&mut self, action: Action) -> Result<Reply> {
        self.cleanup();
        match action {
            Action::Register {
                root,
                project_id,
                adapter,
                id,
                active,
                identity,
            } => {
                identity.check()?;
                if project_id.is_nil() || !active.load(Ordering::SeqCst) {
                    return Err("READER_INVALID_GRANT".into());
                }
                let replacing = self
                    .grants
                    .values()
                    .any(|grant| grant.project_id == project_id && grant.adapter == adapter);
                if self.grants.len() >= MAX_GRANTS && !replacing {
                    return Err("READER_GRANT_LIMIT".into());
                }
                let discovery =
                    SessionDiscovery::new(&root, adapter.extensions(), discovery_limits())
                        .map_err(|_| "READER_ROOT_UNAVAILABLE".to_string())?;
                let store = LocalStore::open_in_memory()
                    .map_err(|_| "READER_STORE_UNAVAILABLE".to_string())?;
                // Prototype assumption: one active root per project/adapter.
                // Switching roots invalidates the old token and destroys its
                // private index, including for the exact same selected path.
                self.grants.retain(|_, grant| {
                    if grant.project_id == project_id && grant.adapter == adapter {
                        grant.active.store(false, Ordering::SeqCst);
                        false
                    } else {
                        true
                    }
                });
                self.grants.insert(
                    id,
                    Grant {
                        project_id,
                        adapter,
                        root,
                        store,
                        discovery,
                        active,
                        identity,
                        bytes_charged: 0,
                        expanded_bytes_charged: 0,
                        candidates_attempted: 0,
                        work_units: 0,
                        finished: false,
                        pending_candidates: VecDeque::new(),
                        pending_page_state: None,
                    },
                );
                Ok(Reply::Grant(GrantInfo {
                    grant_id: id,
                    project_id,
                    adapter,
                    persistent: false,
                }))
            }
            Action::Consent(id) => {
                let grant = self.grants.get(&id).ok_or("READER_GRANT_REVOKED")?;
                grant.check()?;
                Ok(Reply::Consent {
                    path: grant.root.canonical().into(),
                    project_id: grant.project_id,
                    adapter: grant.adapter,
                })
            }
            Action::Index(id) => self
                .grants
                .get_mut(&id)
                .ok_or_else(|| "READER_GRANT_REVOKED".to_string())?
                .index_next()
                .map(Reply::Page),
            Action::List { id, after, limit } => {
                let grant = self.grants.get(&id).ok_or("READER_GRANT_REVOKED")?;
                grant.list(after, limit).map(Reply::Sessions)
            }
            #[cfg(test)]
            Action::Open {
                id,
                session_id,
                cursor,
                limit,
                max_bytes,
            } => self
                .grants
                .get(&id)
                .ok_or_else(|| "READER_GRANT_REVOKED".to_string())?
                .open(session_id, cursor, limit, max_bytes)
                .map(Reply::Content),
            #[cfg(test)]
            Action::Search {
                id,
                session_id,
                query,
                cursor,
                limit,
                max_bytes,
            } => self
                .grants
                .get(&id)
                .ok_or_else(|| "READER_GRANT_REVOKED".to_string())?
                .search(session_id, query, cursor, limit, max_bytes)
                .map(Reply::SearchHits),
            Action::Cleanup => Ok(Reply::Empty),
        }
    }
}

struct Job {
    action: Action,
    reply: mpsc::SyncSender<Result<Reply>>,
}

/// The walker contains thread-affine directory streams. Create and keep it,
/// SQLite and all private paths on one dedicated thread; never add unsafe Send.
pub struct SessionReader {
    sender: mpsc::SyncSender<Job>,
    active: Mutex<HashMap<Uuid, ReaderAccess>>,
    pub(super) dialog_open: Arc<AtomicBool>,
}

impl SessionReader {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Job>(1);
        std::thread::spawn(move || {
            let mut reader = Reader::default();
            while let Ok(job) = receiver.recv() {
                let result = reader.handle(job.action);
                // Revoked grants are dropped at a batch boundary even if the
                // cleanup request could not enter the bounded queue.
                reader.cleanup();
                let _ = job.reply.send(result);
            }
        });
        Self {
            sender,
            active: Mutex::default(),
            dialog_open: Arc::new(AtomicBool::new(false)),
        }
    }

    fn call(&self, action: Action) -> Result<Reply> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .try_send(Job { action, reply })
            .map_err(|_| "READER_BUSY".to_string())?;
        receiver
            .recv()
            .map_err(|_| "READER_UNAVAILABLE".to_string())?
    }

    fn token(&self, id: Uuid) -> Result<ReaderAccess> {
        let token = self
            .active
            .lock()
            .map_err(|_| "READER_UNAVAILABLE")?
            .get(&id)
            .cloned()
            .ok_or_else(|| "READER_GRANT_REVOKED".to_string())?;
        token.check()?;
        Ok(token)
    }

    fn revoke(&self, id: Uuid) -> Result<()> {
        if let Some(active) = self
            .active
            .lock()
            .map_err(|_| "READER_UNAVAILABLE")?
            .remove(&id)
        {
            active.active.store(false, Ordering::SeqCst);
        }
        let (reply, _) = mpsc::sync_channel(1);
        let _ = self.sender.try_send(Job {
            action: Action::Cleanup,
            reply,
        });
        Ok(())
    }

    fn register(
        &self,
        root: AuthorizedRoot,
        project_id: Uuid,
        adapter: ReaderAdapter,
        identity: ReaderIdentity,
    ) -> Result<GrantInfo> {
        identity.check()?;
        let id = Uuid::new_v4();
        let active = Arc::new(AtomicBool::new(true));
        match self.call(Action::Register {
            root,
            project_id,
            adapter,
            id,
            active: active.clone(),
            identity: identity.clone(),
        }) {
            Ok(Reply::Grant(info)) => {
                let mut grants = self.active.lock().map_err(|_| {
                    active.store(false, Ordering::SeqCst);
                    "READER_UNAVAILABLE"
                })?;
                grants.retain(|_, token| token.check().is_ok());
                let access = ReaderAccess {
                    active,
                    identity,
                    project_id,
                };
                access.check()?;
                grants.insert(id, access);
                Ok(info)
            }
            _ => {
                active.store(false, Ordering::SeqCst);
                self.revoke(id)?;
                Err("READER_REGISTRATION_FAILED".into())
            }
        }
    }
}

fn check_build(debug: bool, macos: bool) -> Result<()> {
    // Keep release closed: native binding is implemented, but real packaged
    // dialog/lifecycle and production isolation evidence are still required.
    if !debug {
        return Err("READER_IDENTITY_UNAVAILABLE".into());
    }
    if !macos {
        return Err("READER_PLATFORM_UNAVAILABLE".into());
    }
    Ok(())
}

fn check_window(window: &WebviewWindow) -> Result<()> {
    check_build(cfg!(debug_assertions), cfg!(target_os = "macos"))?;
    let url = window.url().map_err(|_| "READER_FORBIDDEN")?;
    check_window_authority(
        window.label(),
        &url,
        cfg!(debug_assertions),
        cfg!(target_os = "macos"),
    )
}

fn check_window_authority(label: &str, url: &tauri::Url, debug: bool, macos: bool) -> Result<()> {
    check_build(debug, macos)?;
    let local =
        (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (debug
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(5173));
    if label != "main" || !local || !url.username().is_empty() || url.password().is_some() {
        return Err("READER_FORBIDDEN".into());
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ReaderStatus {
    available: bool,
    persistent_grants: bool,
    metadata_listing_available: bool,
    native_confirmation_required: bool,
    backend_identity_integrated: bool,
    agent_execution_granted: bool,
    os_isolation_verified: bool,
}

#[tauri::command]
pub async fn session_reader_status(
    window: WebviewWindow,
    native: State<'_, NativeState>,
) -> Result<ReaderStatus> {
    check_window(&window)?;
    let binding = native.session_binding().await?;
    native.validate_session_binding(&binding).await?;
    check_window(&window)?;
    binding.ensure_active()?;
    Ok(ReaderStatus {
        available: true,
        persistent_grants: false,
        metadata_listing_available: true,
        native_confirmation_required: true,
        backend_identity_integrated: true,
        agent_execution_granted: false,
        os_isolation_verified: false,
    })
}

#[tauri::command]
pub async fn session_reader_choose_root(
    window: WebviewWindow,
    state: State<'_, SessionReader>,
    native: State<'_, NativeState>,
    project_id: Uuid,
    adapter: ReaderAdapter,
) -> Result<GrantInfo> {
    check_window(&window)?;
    if project_id.is_nil() {
        return Err("READER_INVALID_PROJECT".into());
    }
    let binding = native.session_binding().await?;
    native
        .validate_session_project(&binding, &project_id.to_string())
        .await?;
    let root = native_ui::choose(&window, state.inner(), project_id, adapter, &binding).await?;
    check_window(&window)?;
    native
        .validate_session_project(&binding, &project_id.to_string())
        .await?;
    // Root is opened/pinned in native UI before crossing the thread boundary.
    let app = window.app_handle().clone();
    let worker_binding = binding.clone();
    let info = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        app.state::<SessionReader>().register(
            root,
            project_id,
            adapter,
            ReaderIdentity::Native(worker_binding),
        )
    })
    .await
    .map_err(|_| "READER_UNAVAILABLE".to_string())??;
    let access = state.token(info.grant_id)?;
    if let Err(error) = access
        .authorize(native.inner())
        .await
        .and_then(|_| check_window(&window))
    {
        state.revoke(info.grant_id)?;
        return Err(error);
    }
    access.check()?;
    Ok(info)
}

async fn consent(
    window: &WebviewWindow,
    state: &SessionReader,
    native: &NativeState,
    id: Uuid,
    operation: &'static str,
) -> Result<ReaderAccess> {
    check_window(window)?;
    let token = state.token(id)?;
    token.authorize(native).await?;
    let app = window.app_handle().clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        app.state::<SessionReader>().call(Action::Consent(id))
    })
    .await
    .map_err(|_| "READER_UNAVAILABLE".to_string())??;
    let Reply::Consent {
        path,
        project_id,
        adapter,
    } = reply
    else {
        return Err("READER_UNAVAILABLE".into());
    };
    native_ui::confirm(
        window,
        state,
        path,
        project_id,
        adapter,
        operation,
        token.identity.native()?,
    )
    .await?;
    check_window(window)?;
    token.authorize(native).await?;
    Ok(token)
}

#[tauri::command]
pub async fn session_reader_index_next(
    window: WebviewWindow,
    state: State<'_, SessionReader>,
    native: State<'_, NativeState>,
    grant_id: Uuid,
) -> Result<IndexPage> {
    let token = consent(
        &window,
        state.inner(),
        native.inner(),
        grant_id,
        "Index one bounded page locally",
    )
    .await?;
    let app = window.app_handle().clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        app.state::<SessionReader>().call(Action::Index(grant_id))
    })
    .await
    .map_err(|_| "READER_UNAVAILABLE".to_string())??;
    check_window(&window)?;
    token.authorize(native.inner()).await?;
    check_window(&window)?;
    token.check()?;
    match reply {
        Reply::Page(page) => Ok(page),
        _ => Err("READER_UNAVAILABLE".into()),
    }
}

#[tauri::command]
pub async fn session_reader_list(
    window: WebviewWindow,
    state: State<'_, SessionReader>,
    native: State<'_, NativeState>,
    grant_id: Uuid,
    after: Option<Uuid>,
    limit: Option<usize>,
) -> Result<ReaderSessionPage> {
    let limit = limit.unwrap_or(50);
    validate_page_limit(limit)?;
    let token = consent(
        &window,
        state.inner(),
        native.inner(),
        grant_id,
        "Show one page of sanitized metadata in Aelys",
    )
    .await?;
    let app = window.app_handle().clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        app.state::<SessionReader>().call(Action::List {
            id: grant_id,
            after,
            limit,
        })
    })
    .await
    .map_err(|_| "READER_UNAVAILABLE".to_string())??;
    check_window(&window)?;
    token.authorize(native.inner()).await?;
    check_window(&window)?;
    token.check()?;
    match reply {
        Reply::Sessions(page) => Ok(page),
        _ => Err("READER_UNAVAILABLE".into()),
    }
}

/// Fail closed at the command boundary. Returning content after token.check()
/// would race revoke during Tauri's later serialization/response dispatch.
/// No worker, dialog, network or authority check can make that delivery atomic.
#[tauri::command]
pub async fn session_reader_open(
    grant_id: Uuid,
    session_id: Uuid,
    cursor: Option<LocalSessionCursor>,
) -> Result<()> {
    let _ = (grant_id, session_id, cursor);
    Err("READER_CONTENT_UNAVAILABLE".into())
}

#[tauri::command]
pub async fn session_reader_search(
    grant_id: Uuid,
    session_id: Uuid,
    query: String,
    cursor: Option<LocalSessionCursor>,
) -> Result<()> {
    let _ = (grant_id, session_id, query, cursor);
    Err("READER_CONTENT_UNAVAILABLE".into())
}

/// No native IDs, titles, paths, source refs or content. Represents a last
/// indexed snapshot, not proof that a source still exists or is unchanged.
#[derive(Debug, Serialize)]
pub struct ReaderSessionMetadata {
    session_index_id: Uuid,
    project_id: Uuid,
    adapter: ReaderAdapter,
    started_at: Option<String>,
    last_activity_at: Option<String>,
    state: &'static str,
    message_count: u64,
}

/// UUID keyset pagination within THIS grant. A full final page may produce an
/// extra empty request. Not a snapshot: indexing between requests can insert
/// IDs before the cursor; restart pagination after indexing to see all rows.
#[derive(Debug, Serialize)]
pub struct ReaderSessionPage {
    sessions: Vec<ReaderSessionMetadata>,
    next_after: Option<Uuid>,
}

#[tauri::command]
pub fn session_reader_revoke(
    window: WebviewWindow,
    state: State<'_, SessionReader>,
    grant_id: Uuid,
) -> Result<()> {
    check_window(&window)?;
    state.revoke(grant_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn content_ipc_never_publishes_text_with_a_live_or_revoked_indexed_grant() {
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};

        let directory = Directory::new();
        directory.session("private.jsonl");
        let reader = SessionReader::new();
        let grant = reader
            .register(
                directory.root(),
                Uuid::new_v4(),
                ReaderAdapter::ClaudeCode,
                ReaderIdentity::Fixture(Arc::new(AtomicBool::new(true))),
            )
            .unwrap();
        reader.call(Action::Index(grant.grant_id)).unwrap();
        let Reply::Sessions(page) = reader.call(list_action(grant.grant_id)).unwrap() else {
            panic!()
        };
        let session_id = page.sessions[0].session_index_id;
        // Prove the index contains sensitive text; denial must not be an empty
        // fixture or missing grant. These worker operations compile only in tests.
        let Reply::Content(items) = reader
            .call(Action::Open {
                id: grant.grant_id,
                session_id,
                cursor: None,
                limit: 25,
                max_bytes: 16 * 1024,
            })
            .unwrap()
        else {
            panic!()
        };
        assert!(items
            .iter()
            .any(|item| item.content.contains("private_transcript_marker")));

        // Actual generated Tauri handlers and resolver response, not a helper
        // token check. No NativeState is installed: denial must not need auth,
        // network, a picker or a worker read to keep content off the bridge.
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                session_reader_open,
                session_reader_search
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        for revoked in [false, true] {
            if revoked {
                reader.revoke(grant.grant_id).unwrap();
            } else {
                reader.token(grant.grant_id).unwrap().check().unwrap();
            }
            for cmd in ["session_reader_open", "session_reader_search"] {
                let response = get_ipc_response(
                    &window,
                    tauri::webview::InvokeRequest {
                        cmd: cmd.into(),
                        callback: tauri::ipc::CallbackFn(0),
                        error: tauri::ipc::CallbackFn(1),
                        url: "tauri://localhost".parse().unwrap(),
                        body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                            "grantId": grant.grant_id,
                            "sessionId": session_id,
                            "cursor": null,
                            "query": "private_transcript_marker"
                        })),
                        headers: Default::default(),
                        invoke_key: INVOKE_KEY.into(),
                    },
                );
                match response {
                    Err(error) => {
                        assert_eq!(error, serde_json::json!("READER_CONTENT_UNAVAILABLE"))
                    }
                    Ok(_) => panic!("content IPC must never resolve successfully"),
                }
            }
        }
    }

    #[test]
    fn content_reply_stays_denied_when_revoked_after_handler_return_before_serialization() {
        tauri::async_runtime::block_on(async {
            let reader = SessionReader::new();
            let directory = Directory::new();
            let grant = reader
                .register(
                    directory.root(),
                    Uuid::new_v4(),
                    ReaderAdapter::ClaudeCode,
                    ReaderIdentity::Fixture(Arc::new(AtomicBool::new(true))),
                )
                .unwrap();
            let session = Uuid::new_v4();
            let pending_open = session_reader_open(grant.grant_id, session, None).await;
            let pending_search = session_reader_search(
                grant.grant_id,
                session,
                "private_transcript_marker".into(),
                None,
            )
            .await;
            // Deterministic former race interval: handler has returned, but
            // serialization has not occurred. There is no content in either
            // result to release, regardless of this revoke's ordering.
            reader.revoke(grant.grant_id).unwrap();
            for pending in [pending_open, pending_search] {
                assert_eq!(
                    serde_json::to_value(pending).unwrap(),
                    serde_json::json!({"Err":"READER_CONTENT_UNAVAILABLE"})
                );
            }
        });
    }

    #[test]
    fn release_stays_disabled_on_every_platform() {
        for macos in [true, false] {
            assert_eq!(
                check_build(false, macos).unwrap_err(),
                "READER_IDENTITY_UNAVAILABLE"
            );
        }
        assert_eq!(
            check_build(true, false).unwrap_err(),
            "READER_PLATFORM_UNAVAILABLE"
        );
        check_build(true, true).unwrap();
    }

    #[test]
    fn reader_authority_requires_debug_macos_and_the_exact_local_main_window() {
        for origin in ["tauri://localhost", "http://127.0.0.1:5173"] {
            let url = tauri::Url::parse(origin).unwrap();
            check_window_authority("main", &url, true, true).unwrap();
            for macos in [false, true] {
                assert_eq!(
                    check_window_authority("main", &url, false, macos).unwrap_err(),
                    "READER_IDENTITY_UNAVAILABLE"
                );
            }
            assert_eq!(
                check_window_authority("main", &url, true, false).unwrap_err(),
                "READER_PLATFORM_UNAVAILABLE"
            );
            assert_eq!(
                check_window_authority("other", &url, true, true).unwrap_err(),
                "READER_FORBIDDEN"
            );
        }
        for origin in [
            "https://example.test",
            "tauri://other",
            "tauri://localhost:5173",
            "http://localhost:5173",
            "http://127.0.0.1:5174",
            "http://127.0.0.1",
            "http://tauri.localhost",
            "http://[::1]:5173",
            "http://user:secret@127.0.0.1:5173",
            "tauri://user:secret@localhost",
            "file:///tmp/index.html",
        ] {
            assert_eq!(
                check_window_authority("main", &tauri::Url::parse(origin).unwrap(), true, true)
                    .unwrap_err(),
                "READER_FORBIDDEN"
            );
        }
    }

    #[test]
    fn session_end_blocks_worker_and_discards_index_without_reusing_old_grants() {
        let directory = Directory::new();
        directory.session("private.jsonl");
        let mut reader = Reader::default();
        let project_id = Uuid::new_v4();
        let (id, active) = register(&mut reader, &directory, project_id);
        reader.handle(Action::Index(id)).unwrap();
        // Model a reply already computed while consent/work was pending.
        let pending_reply = reader.handle(list_action(id)).unwrap();
        assert!(matches!(pending_reply, Reply::Sessions(_)));
        let identity = reader.grants[&id].identity.clone();
        let access = ReaderAccess {
            identity: identity.clone(),
            active: active.clone(),
            project_id,
        };
        let ReaderIdentity::Fixture(session_alive) = &identity else {
            panic!()
        };
        session_alive.store(false, Ordering::SeqCst);
        // The publication gate rejects an already prepared reply immediately.
        assert_eq!(access.check().unwrap_err(), "SIGN_IN_REQUIRED");
        assert!(!active.load(Ordering::SeqCst));
        for action in [Action::Consent(id), Action::Index(id), list_action(id)] {
            assert_eq!(error(reader.handle(action)), "READER_GRANT_REVOKED");
        }
        assert!(reader.grants.is_empty());
        // Pending picker/registration cannot create a grant for a dead session.
        let action = Action::Register {
            root: directory.root(),
            project_id,
            adapter: ReaderAdapter::ClaudeCode,
            id: Uuid::new_v4(),
            active: Arc::new(AtomicBool::new(true)),
            identity,
        };
        assert_eq!(error(reader.handle(action)), "SIGN_IN_REQUIRED");
        let (new_id, _) = register(&mut reader, &directory, project_id);
        assert_ne!(id, new_id);
        let Reply::Sessions(page) = reader.handle(list_action(new_id)).unwrap() else {
            panic!()
        };
        assert!(page.sessions.is_empty());
    }

    #[test]
    fn queued_bridge_work_checks_identity_without_waiting_for_native_consent() {
        let directory = Directory::new();
        let reader = SessionReader::new();
        let alive = Arc::new(AtomicBool::new(true));
        let info = reader
            .register(
                directory.root(),
                Uuid::new_v4(),
                ReaderAdapter::ClaudeCode,
                ReaderIdentity::Fixture(alive.clone()),
            )
            .unwrap();
        let access = reader.token(info.grant_id).unwrap();
        alive.store(false, Ordering::SeqCst);
        assert!(reader.token(info.grant_id).is_err());
        assert!(access.check().is_err());
        assert_eq!(
            error(reader.call(Action::Index(info.grant_id))),
            "READER_GRANT_REVOKED"
        );
        reader.revoke(info.grant_id).unwrap();
    }

    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("aelys-reader-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn root(&self) -> AuthorizedRoot {
            AuthorizedRoot::new(&self.0).unwrap()
        }
        fn session(&self, name: &str) {
            fs::write(self.0.join(name), r#"{"type":"user","message":{"role":"user","content":"private_transcript_marker"}}"#).unwrap();
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn register(
        reader: &mut Reader,
        directory: &Directory,
        project_id: Uuid,
    ) -> (Uuid, Arc<AtomicBool>) {
        let id = Uuid::new_v4();
        let active = Arc::new(AtomicBool::new(true));
        let reply = reader
            .handle(Action::Register {
                root: directory.root(),
                project_id,
                adapter: ReaderAdapter::ClaudeCode,
                id,
                active: active.clone(),
                identity: ReaderIdentity::Fixture(Arc::new(AtomicBool::new(true))),
            })
            .unwrap();
        assert!(matches!(reply, Reply::Grant(_)));
        (id, active)
    }

    fn error(result: Result<Reply>) -> String {
        match result {
            Err(code) => code,
            Ok(_) => panic!("expected a fixed error code"),
        }
    }

    fn list_action(id: Uuid) -> Action {
        Action::List {
            id,
            after: None,
            limit: 100,
        }
    }

    #[test]
    fn grant_stores_are_separate_even_for_the_same_project() {
        let a = Directory::new();
        let b = Directory::new();
        a.session("a.jsonl");
        let mut reader = Reader::default();
        let project = Uuid::new_v4();
        let (first, _) = register(&mut reader, &a, project);
        let second = Uuid::new_v4();
        reader
            .handle(Action::Register {
                root: b.root(),
                project_id: project,
                adapter: ReaderAdapter::CodexCli,
                id: second,
                active: Arc::new(AtomicBool::new(true)),
                identity: ReaderIdentity::Fixture(Arc::new(AtomicBool::new(true))),
            })
            .unwrap();
        reader.handle(Action::Index(first)).unwrap();
        assert_eq!(
            reader.grants[&first]
                .store
                .search("private_transcript_marker", &[project], 10)
                .unwrap()
                .len(),
            1
        );
        assert!(reader.grants[&second]
            .store
            .search("private_transcript_marker", &[project], 10)
            .unwrap()
            .is_empty());
        let Reply::Sessions(summaries) = reader.handle(list_action(first)).unwrap() else {
            panic!()
        };
        assert!(reader.grants[&first]
            .store
            .cloud_outbox_json(summaries.sessions[0].session_index_id)
            .unwrap()
            .is_none());
        let Reply::Sessions(other) = reader.handle(list_action(second)).unwrap() else {
            panic!()
        };
        assert!(other.sessions.is_empty());
    }

    #[test]
    fn revoke_blocks_metadata_and_reads_and_reselection_starts_empty() {
        let directory = Directory::new();
        directory.session("session.jsonl");
        let mut reader = Reader::default();
        let project = Uuid::new_v4();
        let (id, active) = register(&mut reader, &directory, project);
        reader.handle(Action::Index(id)).unwrap();
        active.store(false, Ordering::SeqCst);
        assert_eq!(
            error(reader.handle(list_action(id))),
            "READER_GRANT_REVOKED"
        );
        assert_eq!(
            error(reader.handle(Action::Index(id))),
            "READER_GRANT_REVOKED"
        );
        assert!(!reader.grants.contains_key(&id));
        let (new_id, _) = register(&mut reader, &directory, project);
        assert_ne!(id, new_id);
        assert!(reader.grants[&new_id]
            .store
            .search("private_transcript_marker", &[project], 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn metadata_pagination_is_bounded_sanitized_and_uses_only_this_grant() {
        let directory = Directory::new();
        for n in 0..7 {
            directory.session(&format!("private_filename_{n}.jsonl"));
        }
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        loop {
            let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
                panic!()
            };
            if page.discovery_state != "more" {
                break;
            }
        }
        let mut after = None;
        let mut ids = Vec::new();
        loop {
            let Reply::Sessions(page) = reader
                .handle(Action::List {
                    id,
                    after,
                    limit: 2,
                })
                .unwrap()
            else {
                panic!()
            };
            assert!(page.sessions.len() <= 2);
            let json = serde_json::to_value(&page).unwrap();
            for row in json["sessions"].as_array().unwrap() {
                assert_eq!(row.as_object().unwrap().len(), 7);
                assert_eq!(row["state"], "indexed_snapshot");
            }
            let encoded = json.to_string();
            for forbidden in [
                "private_transcript_marker",
                "private_filename",
                "local_session_ref",
                "native_session_id",
                "source_ref",
                "snippet",
            ] {
                assert!(!encoded.contains(forbidden));
            }
            ids.extend(page.sessions.into_iter().map(|row| row.session_index_id));
            after = page.next_after;
            if after.is_none() {
                break;
            }
        }
        assert_eq!(ids.len(), 7);
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
        for limit in [0, 101, usize::MAX] {
            assert_eq!(
                error(reader.handle(Action::List {
                    id,
                    after: None,
                    limit
                })),
                "READER_INVALID_LIMIT"
            );
        }
    }

    #[test]
    fn grant_open_and_search_return_bounded_scoped_content() {
        let directory = Directory::new();
        directory.session("session.jsonl");
        let mut reader = Reader::default();
        let project = Uuid::new_v4();
        let (id, _) = register(&mut reader, &directory, project);
        reader.handle(Action::Index(id)).unwrap();
        let Reply::Sessions(page) = reader.handle(list_action(id)).unwrap() else {
            panic!()
        };
        let session_id = page.sessions[0].session_index_id;

        let Reply::Content(items) = reader
            .handle(Action::Open {
                id,
                session_id,
                cursor: None,
                limit: 1,
                max_bytes: 16,
            })
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(items.len(), 1);
        assert!(items[0].content.len() <= 16);
        assert!(items[0].content.contains("private_transcr"));
        assert!(items[0].content_truncated);
        let cursor = items[0].next_cursor;

        let Reply::SearchHits(hits) = reader
            .handle(Action::Search {
                id,
                session_id,
                query: "private_transcript_marker".into(),
                cursor: None,
                limit: 1,
                max_bytes: 12,
            })
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(hits.len(), 1);
        assert!(hits[0].excerpt.len() <= 12);
        assert!(hits[0].excerpt_truncated);

        assert_eq!(
            error(reader.handle(Action::Open {
                id,
                session_id,
                cursor,
                limit: 101,
                max_bytes: 16,
            })),
            "READER_INVALID_LIMIT"
        );
        assert_eq!(
            error(reader.handle(Action::Search {
                id,
                session_id,
                query: String::new(),
                cursor: None,
                limit: 1,
                max_bytes: 12,
            })),
            "READER_INVALID_QUERY"
        );
        assert_eq!(
            error(reader.handle(Action::Open {
                id,
                session_id: Uuid::new_v4(),
                cursor: None,
                limit: 1,
                max_bytes: 16,
            })),
            "READER_CONTENT_UNAVAILABLE"
        );
    }

    #[test]
    fn pages_are_bounded_and_continue_without_a_timestamp_watermark() {
        let directory = Directory::new();
        for n in 0..7 {
            directory.session(&format!("{n}.jsonl"));
        }
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        let mut indexed = 0;
        loop {
            let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
                panic!()
            };
            assert!(page.attempted <= 4);
            assert!(page.work_units <= 256);
            assert!(page.bytes_charged <= 4 * 1024 * 1024);
            indexed += page.indexed;
            if page.discovery_state != "more" {
                break;
            }
        }
        assert_eq!(indexed, 7);
        assert_eq!(
            error(reader.handle(Action::Index(id))),
            "READER_PASS_FINISHED"
        );
    }

    #[test]
    fn event_budget_keeps_pending_candidates_and_terminal_omissions() {
        let directory = Directory::new();
        fs::write(
            directory.0.join("omitted.jsonl"),
            vec![b'x'; MAX_SESSION_BYTES + 1],
        )
        .unwrap();
        // Either order fits individually but not together in a single page.
        let event = r#"{"type":"user","message":{"role":"user","content":"event"}}"#;
        let first_snapshot = std::iter::repeat_n(event, 6_000)
            .collect::<Vec<_>>()
            .join("\n");
        let second_snapshot = std::iter::repeat_n(event, 5_000)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(directory.0.join("first.jsonl"), &first_snapshot).unwrap();
        fs::write(directory.0.join("second.jsonl"), &second_snapshot).unwrap();

        let mut reader = Reader::default();
        let project = Uuid::new_v4();
        let (id, active) = register(&mut reader, &directory, project);
        let Reply::Page(first) = reader.handle(Action::Index(id)).unwrap() else {
            panic!()
        };
        assert_eq!(first.attempted, 1);
        assert!([5_000, 6_000].contains(&first.indexed_events));
        assert_eq!(first.discovery_state, "more");
        assert!(reader.grants[&id].pending_candidates.len() <= MAX_PENDING_CANDIDATES);

        let Reply::Page(second) = reader.handle(Action::Index(id)).unwrap() else {
            panic!()
        };
        assert_eq!(second.attempted, 1);
        assert_eq!(first.indexed_events + second.indexed_events, 11_000);
        assert_eq!(second.discovery_state, "exhausted_with_omissions");
        assert_eq!(reader.grants[&id].candidates_attempted, 2);
        let Reply::Sessions(sessions) = reader.handle(list_action(id)).unwrap() else {
            panic!()
        };
        assert_eq!(sessions.sessions.len(), 2);

        // Revocation remains effective while a terminal result is retained.
        active.store(false, Ordering::SeqCst);
        assert_eq!(
            error(reader.handle(Action::Index(id))),
            "READER_GRANT_REVOKED"
        );
        assert!(!reader.grants.contains_key(&id));
    }

    #[test]
    fn oversized_files_and_symlinks_are_not_indexed() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let outside = Directory::new();
        outside.session("secret.jsonl");
        symlink(
            outside.0.join("secret.jsonl"),
            directory.0.join("link.jsonl"),
        )
        .unwrap();
        fs::write(
            directory.0.join("large.jsonl"),
            vec![b'x'; MAX_SESSION_BYTES + 1],
        )
        .unwrap();
        fs::write(directory.0.join("invalid.jsonl"), b"{not-json}").unwrap();
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
            panic!()
        };
        assert_eq!(page.indexed, 0);
        assert_eq!(page.oversized, 1);
        assert_eq!(page.unsupported, 1);
        assert_eq!(page.discovery_state, "exhausted_with_omissions");
    }

    #[test]
    fn session_larger_than_one_mib_is_indexed_within_the_snapshot_limit() {
        let directory = Directory::new();
        let content = "x".repeat(1024 * 1024);
        let record =
            serde_json::json!({"type":"user", "message":{"role":"user", "content":content}});
        fs::write(directory.0.join("large-valid.jsonl"), record.to_string()).unwrap();
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
            panic!()
        };
        assert_eq!(page.indexed, 1);
        assert_eq!(page.oversized, 0);
        assert_eq!(page.indexed_events, 1);
        assert!(page.bytes_charged > 1024 * 1024);
    }

    #[test]
    fn session_over_event_limit_is_reported_separately_from_parse_failure() {
        let directory = Directory::new();
        let event = r#"{"type":"user","message":{"role":"user","content":"x"}}"#;
        let snapshot = std::iter::repeat_n(event, 10_001)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(directory.0.join("many.jsonl"), snapshot).unwrap();
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
            panic!()
        };
        assert_eq!(page.event_limit, 1);
        assert_eq!(page.unsupported, 0);
        assert_eq!(page.indexed, 0);
    }

    #[test]
    fn replaced_root_fails_closed_without_path_or_transcript_in_errors() {
        let directory = Directory::new();
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        let moved = directory.0.with_extension("moved");
        fs::rename(&directory.0, &moved).unwrap();
        fs::create_dir(&directory.0).unwrap();
        assert_eq!(
            error(reader.handle(Action::Index(id))),
            "READER_ROOT_UNAVAILABLE"
        );
        assert_eq!(
            error(reader.handle(list_action(id))),
            "READER_ROOT_UNAVAILABLE"
        );
        fs::remove_dir_all(moved).unwrap();
    }

    #[test]
    fn grant_and_page_ipc_responses_have_only_explicit_allowlist_fields() {
        let directory = Directory::new();
        directory.session("sensitive_filename.jsonl");
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
            panic!()
        };
        let json = serde_json::to_value(page).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 17);
        let encoded = json.to_string();
        for forbidden in [
            "private_transcript_marker",
            "sensitive_filename",
            directory.0.to_str().unwrap(),
            "snippet",
            "source_ref",
        ] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn codex_compressed_discovery_index_open_and_error_counts_are_local() {
        let directory = Directory::new();
        let text = serde_json::json!({"type":"response_item","payload":{"type":"message",
            "role":"assistant","content":[{"type":"output_text","text":"compressed_synthetic_marker"}]}}).to_string();
        fs::write(
            directory.0.join("good.jsonl.zst"),
            zstd::stream::encode_all(text.as_bytes(), 1).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.0.join("bad.jsonl.zst"),
            b"invalid compressed bytes",
        )
        .unwrap();
        fs::write(
            directory.0.join("bomb.jsonl.zst"),
            zstd::stream::encode_all(&vec![b' '; MAX_SESSION_BYTES + 1][..], 1).unwrap(),
        )
        .unwrap();
        let mut reader = Reader::default();
        let id = Uuid::new_v4();
        reader
            .handle(Action::Register {
                root: directory.root(),
                project_id: Uuid::new_v4(),
                adapter: ReaderAdapter::CodexCli,
                id,
                active: Arc::new(AtomicBool::new(true)),
                identity: ReaderIdentity::Fixture(Arc::new(AtomicBool::new(true))),
            })
            .unwrap();
        let mut indexed = 0;
        let mut bad = 0;
        let mut large = 0;
        let mut expanded = 0;
        loop {
            let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
                panic!()
            };
            indexed += page.indexed;
            bad += page.compression_rejected;
            large += page.expanded_limit;
            expanded += page.expanded_bytes_charged;
            let json = serde_json::to_string(&page).unwrap();
            assert!(!json.contains("compressed_synthetic_marker"));
            assert!(!json.contains(directory.0.to_str().unwrap()));
            if page.discovery_state != "more" {
                break;
            }
        }
        assert_eq!((indexed, bad, large), (1, 1, 1));
        assert!(expanded > 2 * MAX_SESSION_BYTES);
        let Reply::Sessions(page) = reader.handle(list_action(id)).unwrap() else {
            panic!()
        };
        assert_eq!(page.sessions.len(), 1);
        let session_id = page.sessions[0].session_index_id;
        let Reply::Content(items) = reader
            .handle(Action::Open {
                id,
                session_id,
                cursor: None,
                limit: 25,
                max_bytes: 16384,
            })
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(items[0].content, "compressed_synthetic_marker");
        let Reply::SearchHits(hits) = reader
            .handle(Action::Search {
                id,
                session_id,
                query: "synthetic".into(),
                cursor: None,
                limit: 25,
                max_bytes: 16384,
            })
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(hits.len(), 1);
        assert!(reader.grants[&id]
            .store
            .cloud_outbox_json(session_id)
            .unwrap()
            .is_none());
        reader.grants[&id].active.store(false, Ordering::SeqCst);
        assert_eq!(
            error(reader.handle(Action::Open {
                id,
                session_id,
                cursor: None,
                limit: 25,
                max_bytes: 16384
            })),
            "READER_GRANT_REVOKED"
        );
    }

    #[test]
    fn expanded_budget_preserves_compressed_pending_but_processes_plain() {
        let directory = Directory::new();
        directory.session("plain.jsonl");
        fs::write(directory.0.join("compressed.jsonl.zst"), b"not read").unwrap();
        let mut reader = Reader::default();
        let id = Uuid::new_v4();
        reader
            .handle(Action::Register {
                root: directory.root(),
                project_id: Uuid::new_v4(),
                adapter: ReaderAdapter::CodexCli,
                id,
                active: Arc::new(AtomicBool::new(true)),
                identity: ReaderIdentity::Fixture(Arc::new(AtomicBool::new(true))),
            })
            .unwrap();
        let grant = reader.grants.get_mut(&id).unwrap();
        grant.expanded_bytes_charged = MAX_GRANT_BYTES;
        grant.pending_candidates = VecDeque::from([
            PathBuf::from("compressed.jsonl.zst"),
            PathBuf::from("plain.jsonl"),
        ]);
        grant.pending_page_state = Some(DiscoveryState::Exhausted);
        let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
            panic!()
        };
        assert_eq!(page.attempted, 1);
        assert_eq!(page.expanded_bytes_charged, 0);
        assert!(page.budget_exhausted);
        assert_eq!(page.discovery_state, "more");
        assert_eq!(
            reader.grants[&id].pending_candidates,
            VecDeque::from([PathBuf::from("compressed.jsonl.zst")])
        );
    }

    #[test]
    fn lifetime_budget_stops_further_reads() {
        let directory = Directory::new();
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        reader.grants.get_mut(&id).unwrap().bytes_charged = MAX_GRANT_BYTES - MAX_SESSION_BYTES + 1;
        assert_eq!(
            error(reader.handle(Action::Index(id))),
            "READER_BUDGET_EXHAUSTED"
        );
    }

    #[test]
    fn complete_pass_at_budget_limit_is_not_reported_as_partial() {
        let directory = Directory::new();
        directory.session("session.jsonl");
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        reader.grants.get_mut(&id).unwrap().bytes_charged = MAX_GRANT_BYTES - MAX_SESSION_BYTES;
        let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
            panic!("expected index page")
        };
        assert_eq!(page.discovery_state, "exhausted");
        assert_eq!(page.indexed, 1);
        assert!(!page.budget_exhausted);
    }

    #[test]
    fn budget_limit_still_reports_unprocessed_candidates() {
        let directory = Directory::new();
        directory.session("first.jsonl");
        directory.session("second.jsonl");
        let mut reader = Reader::default();
        let (id, _) = register(&mut reader, &directory, Uuid::new_v4());
        reader.grants.get_mut(&id).unwrap().bytes_charged = MAX_GRANT_BYTES - MAX_SESSION_BYTES;
        let Reply::Page(page) = reader.handle(Action::Index(id)).unwrap() else {
            panic!("expected index page")
        };
        assert_eq!(page.discovery_state, "more");
        assert_eq!(page.indexed, 1);
        assert!(page.budget_exhausted);
        assert_eq!(
            error(reader.handle(Action::Index(id))),
            "READER_BUDGET_EXHAUSTED"
        );
    }

    #[test]
    fn bridge_revocation_is_idempotent_and_invalidates_token_immediately() {
        let directory = Directory::new();
        let bridge = SessionReader::new();
        let info = bridge
            .register(
                directory.root(),
                Uuid::new_v4(),
                ReaderAdapter::ClaudeCode,
                ReaderIdentity::Fixture(Arc::new(AtomicBool::new(true))),
            )
            .unwrap();
        let token = bridge.token(info.grant_id).unwrap();
        bridge.revoke(info.grant_id).unwrap();
        assert!(!token.active.load(Ordering::SeqCst));
        assert!(bridge.token(info.grant_id).is_err());
        bridge.revoke(info.grant_id).unwrap();
    }

    #[test]
    fn switching_a_binding_revokes_old_grant_and_destroys_its_index() {
        let old = Directory::new();
        let new = Directory::new();
        old.session("private.jsonl");
        let mut reader = Reader::default();
        let project = Uuid::new_v4();
        let (old_id, old_token) = register(&mut reader, &old, project);
        reader.handle(Action::Index(old_id)).unwrap();
        let (new_id, _) = register(&mut reader, &new, project);
        assert!(!old_token.load(Ordering::SeqCst));
        assert!(!reader.grants.contains_key(&old_id));
        assert_eq!(
            error(reader.handle(list_action(old_id))),
            "READER_GRANT_REVOKED"
        );
        let Reply::Sessions(page) = reader.handle(list_action(new_id)).unwrap() else {
            panic!()
        };
        assert!(page.sessions.is_empty());
    }
}
