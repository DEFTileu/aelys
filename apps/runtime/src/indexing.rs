//! Phase 5 / tasks 1-2: bounded local snapshot indexing and Codex zstd input.
//!
//! The caller explicitly supplies one root/project/adapter binding and relative
//! candidate paths (for example from a separately authorized discovery step).
//! Discovery is deliberately not invoked here. The descriptor-bound walker
//! supplies explicit candidates; the legacy timestamp API can skip files. This API provides no watermark, completeness
//! claim, deletion reconciliation, or automatic home/vendor-directory scanning.
//!
//! Each candidate is read through `AuthorizedRoot::read_child_bounded`, parsed
//! from those bytes, then committed atomically through the local store. A bad or
//! unconfirmed empty snapshot preserves the old metadata/messages/FTS. A
//! completely validated Codex rollback that removed all visible text can
//! instead replace the previous snapshot with a confirmed empty one.
//!
//! Limitations: full-file snapshots, no persistent read offsets/revision cache,
//! no native vendor session-ID extraction, no watcher/rate scheduler, no cloud
//! outbox writes. Live files are not filesystem snapshots: a concurrent writer
//! may produce valid but mixed JSONL despite before/after metadata checks.
//! Descriptor-bound reads reject symlinks, multi-link files and cross-device
//! traversal, but do not establish isolation from every same-device mount or
//! concurrent content edit.
//! Adapter/version compatibility and owner grants remain caller prerequisites;
//! transcript text never grants permissions. Backup/egress decisions remain OPEN.

use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::adapter::AdapterKind;
use crate::db::LocalStore;
use crate::discovery::{
    stable_session_id, ClaudeJsonlParser, CodexJsonlParser, ParsedIndexSnapshot, SessionParser,
};
use crate::metadata::LocalSessionMetadata;
use crate::paths::AuthorizedRoot;
use crate::{RuntimeError, RuntimeResult};

#[path = "session_compression.rs"]
mod compression;

#[derive(Debug, Clone, Copy)]
pub struct IndexingLimits {
    pub max_files: usize,
    /// Separate cap for source bytes AND decoded bytes of a compressed file.
    pub max_file_bytes: usize,
    /// Independent per-batch caps for physical reads and expanded output work.
    pub max_batch_bytes: usize,
    pub max_events: usize,
}

impl Default for IndexingLimits {
    fn default() -> Self {
        Self {
            max_files: 32,
            max_file_bytes: 4 * 1024 * 1024,
            max_batch_bytes: 16 * 1024 * 1024,
            max_events: 10_000,
        }
    }
}

impl IndexingLimits {
    fn validate(self) -> RuntimeResult<()> {
        if self.max_files == 0
            || self.max_files > 1024
            || self.max_file_bytes == 0
            || self.max_file_bytes > 8 * 1024 * 1024
            || self.max_batch_bytes == 0
            || self.max_batch_bytes > 64 * 1024 * 1024
            || self.max_events == 0
            || self.max_events > 100_000
        {
            return Err(RuntimeError::AdapterUnavailable(
                "invalid session indexing limits".into(),
            ));
        }
        Ok(())
    }
}

/// Fixed reason codes only: no paths, transcript fragments, or raw errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateStatus {
    Indexed,
    ReadRejected,
    ParseRejected,
    EventLimitExceeded,
    EmptySnapshot,
    StoreRejected,
    CompressionRejected,
    ExpandedLimitExceeded,
    RepresentationConflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateOutcome {
    /// Position in the supplied batch, for local caller reconciliation.
    pub candidate_index: usize,
    pub status: CandidateStatus,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct IndexingReport {
    pub outcomes: Vec<CandidateOutcome>,
    pub indexed_events: usize,
    /// Successful payload bytes plus the entire read allowance on failed reads.
    /// The safe reader may consume one extra oversize-detection byte per attempt.
    /// Actual bytes read are therefore <= this value + outcomes.len().
    pub bytes_charged: usize,
    /// Compressed candidates: decoded length, or the full output allowance on
    /// failure. Independently bounded by max_batch_bytes, including retries.
    pub expanded_bytes_charged: usize,
    /// Unattempted entries in THIS supplied batch, not a discovery continuation.
    pub unattempted: usize,
}

pub struct SessionIndexingCoordinator<'a> {
    store: &'a LocalStore,
}

impl<'a> SessionIndexingCoordinator<'a> {
    pub fn new(store: &'a LocalStore) -> Self {
        Self { store }
    }

    /// Processes only a bounded prefix of explicit candidates. Replay is safe:
    /// each success replaces a complete snapshot, removing rewritten old hits.
    /// Failures are independent per file; a later failure does not undo earlier
    /// successes. No file disappearance or failure is treated as a deletion.
    pub fn index_batch(
        &self,
        root: &AuthorizedRoot,
        project_id: Uuid,
        adapter: AdapterKind,
        candidates: &[PathBuf],
        limits: IndexingLimits,
    ) -> RuntimeResult<IndexingReport> {
        self.index_batch_with_expanded_budget(
            root,
            project_id,
            adapter,
            candidates,
            limits,
            limits.max_batch_bytes,
        )
    }

    /// Allows plain work to continue after the independent expanded budget
    /// ends. A compressed prefix that cannot fit is deferred, never skipped.
    pub fn index_batch_with_expanded_budget(
        &self,
        root: &AuthorizedRoot,
        project_id: Uuid,
        adapter: AdapterKind,
        candidates: &[PathBuf],
        limits: IndexingLimits,
        expanded_budget: usize,
    ) -> RuntimeResult<IndexingReport> {
        limits.validate()?;
        let expanded_budget = expanded_budget.min(limits.max_batch_bytes);
        if project_id.is_nil() || root.canonical().to_str().is_none() {
            return Err(RuntimeError::UnauthorizedPath);
        }
        let parser: &dyn SessionParser = match adapter {
            AdapterKind::ClaudeCode => &ClaudeJsonlParser,
            AdapterKind::CodexCli => &CodexJsonlParser,
        };
        let mut report = IndexingReport::default();
        for (candidate_index, relative) in candidates.iter().take(limits.max_files).enumerate() {
            let allowance = limits
                .max_file_bytes
                .min(limits.max_batch_bytes - report.bytes_charged);
            let compressed = adapter == AdapterKind::CodexCli
                && relative
                    .to_str()
                    .is_some_and(|name| name.to_ascii_lowercase().ends_with(".jsonl.zst"));
            let expanded_allowance = limits
                .max_file_bytes
                .min(expanded_budget - report.expanded_bytes_charged);
            if allowance == 0 || report.indexed_events >= limits.max_events {
                break;
            }
            // Do not classify a file as unreadable merely because earlier
            // candidates consumed part of this page's byte allowance. Retry
            // the untouched candidate on a fresh page with the full limit.
            if !report.outcomes.is_empty() && allowance < limits.max_file_bytes {
                break;
            }
            if compressed && expanded_allowance < limits.max_file_bytes {
                break;
            }
            let status = if !valid_relative_path(relative) {
                CandidateStatus::ReadRejected
            } else if compressed
                && root
                    .child_exists_no_follow(&relative.with_extension(""))
                    .unwrap_or(true)
            {
                // Never let a possibly stale compressed sibling overwrite the
                // canonical plain snapshot. No mtime freshness heuristics.
                CandidateStatus::RepresentationConflict
            } else {
                let relative: PathBuf = relative.components().collect();
                match root.read_child_bounded(&relative, allowance) {
                    Err(_) => {
                        // Charge conservatively: a failed read may have used
                        // its full allowance before detecting growth/oversize.
                        report.bytes_charged += allowance;
                        CandidateStatus::ReadRejected
                    }
                    Ok(bytes) => {
                        report.bytes_charged += bytes.len();
                        let decoded = if compressed {
                            match compression::decode(&bytes, expanded_allowance) {
                                Ok(decoded) => {
                                    report.expanded_bytes_charged += decoded.len();
                                    Ok(decoded)
                                }
                                Err(error) => {
                                    // Charge failures conservatively; a decoder may have
                                    // produced output before detecting a corrupt footer.
                                    report.expanded_bytes_charged += expanded_allowance;
                                    Err(match error {
                                        compression::DecodeError::OutputLimit => {
                                            CandidateStatus::ExpandedLimitExceeded
                                        }
                                        compression::DecodeError::InvalidFrame => {
                                            CandidateStatus::CompressionRejected
                                        }
                                    })
                                }
                            }
                        } else {
                            Ok(bytes)
                        };
                        let bytes = match decoded {
                            Ok(bytes) => bytes,
                            Err(status) => {
                                report.outcomes.push(CandidateOutcome {
                                    candidate_index,
                                    status,
                                });
                                continue;
                            }
                        };
                        let parsed = match parser.parse_index_snapshot(&bytes, limits.max_events) {
                            Err(RuntimeError::SessionEventLimitExceeded) => {
                                Err(CandidateStatus::EventLimitExceeded)
                            }
                            Err(_) => Err(CandidateStatus::ParseRejected),
                            Ok(ParsedIndexSnapshot::Events(events)) if !events.is_empty() => {
                                Ok(events)
                            }
                            Ok(ParsedIndexSnapshot::ConfirmedEmptyCodexRollback)
                                if adapter == AdapterKind::CodexCli =>
                            {
                                Ok(Vec::new())
                            }
                            Ok(ParsedIndexSnapshot::ConfirmedEmptyCodexRollback) => {
                                Err(CandidateStatus::ParseRejected)
                            }
                            Ok(
                                ParsedIndexSnapshot::UnconfirmedEmpty
                                | ParsedIndexSnapshot::Events(_),
                            ) => Err(CandidateStatus::EmptySnapshot),
                        };
                        match parsed {
                            Err(status) => status,
                            Ok(events) => {
                                if compressed
                                    && root
                                        .child_exists_no_follow(&relative.with_extension(""))
                                        .unwrap_or(true)
                                {
                                    report.outcomes.push(CandidateOutcome {
                                        candidate_index,
                                        status: CandidateStatus::RepresentationConflict,
                                    });
                                    continue;
                                }
                                // A valid file may fit a fresh page but not the
                                // remaining event allowance. Preserve it for the
                                // caller instead of labelling it malformed.
                                if events.len() > limits.max_events - report.indexed_events {
                                    break;
                                }
                                let id = stable_session_id(
                                    project_id,
                                    adapter,
                                    &root.canonical().join(if compressed {
                                        relative.with_extension("")
                                    } else {
                                        relative.clone()
                                    }),
                                );
                                // A plain snapshot seen on an earlier page remains
                                // authoritative even if its file vanished meanwhile.
                                // We cannot prove a remaining compressed sibling is
                                // the new representation rather than a stale copy.
                                if compressed
                                    && self.store.session_snapshot_source(id)?.is_some_and(
                                        |source| {
                                            !source.to_ascii_lowercase().ends_with(".jsonl.zst")
                                        },
                                    )
                                {
                                    report.outcomes.push(CandidateOutcome {
                                        candidate_index,
                                        status: CandidateStatus::RepresentationConflict,
                                    });
                                    continue;
                                }
                                let digest = Sha256::digest(&bytes);
                                // SQLite INTEGER is signed; do not accidentally
                                // reject half of all content-derived revisions.
                                let revision = u64::from_be_bytes(
                                    digest[..8].try_into().expect("SHA-256 has eight bytes"),
                                ) & i64::MAX as u64;
                                let metadata = LocalSessionMetadata {
                                    session_index_id: id,
                                    // The existing parsers do not extract a native ID.
                                    native_session_id: String::new(),
                                    local_session_ref: root
                                        .canonical()
                                        .join(&relative)
                                        .to_string_lossy()
                                        .into_owned(),
                                    project_id,
                                    adapter: match adapter {
                                        AdapterKind::ClaudeCode => "claude_code",
                                        AdapterKind::CodexCli => "codex_cli",
                                    }
                                    .into(),
                                    source_revision: revision,
                                    started_at: events.iter().filter_map(|e| e.occurred_at).min(),
                                    last_activity_at: events
                                        .iter()
                                        .filter_map(|e| e.occurred_at)
                                        .max(),
                                    state: "indexed".into(),
                                    message_count: events.len() as u64,
                                };
                                match self.store.store_session_snapshot(&metadata, &events) {
                                    Ok(()) => {
                                        report.indexed_events += events.len();
                                        CandidateStatus::Indexed
                                    }
                                    Err(_) => CandidateStatus::StoreRejected,
                                }
                            }
                        }
                    }
                }
            };
            report.outcomes.push(CandidateOutcome {
                candidate_index,
                status,
            });
        }
        report.unattempted = candidates.len() - report.outcomes.len();
        Ok(report)
    }
}

fn valid_relative_path(path: &Path) -> bool {
    // Avoid ambiguous lossy IDs, pathological path allocations, and traversals.
    !path.as_os_str().is_empty()
        && path.as_os_str().len() <= 4096
        && path.to_str().is_some()
        && path.components().count() <= 64
        && path.components().all(|c| matches!(c, Component::Normal(_)))
}
