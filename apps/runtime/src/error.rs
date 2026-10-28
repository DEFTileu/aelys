use thiserror::Error;

pub type RuntimeResult<T> = Result<T, RuntimeError>;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("path is outside an authorized project root")]
    UnauthorizedPath,
    #[error("symlinked paths are not permitted")]
    SymlinkNotAllowed,
    #[error("path does not exist or cannot be inspected: {0}")]
    PathUnavailable(String),
    #[error("invalid state transition from {from} to {to}")]
    InvalidStateTransition { from: String, to: String },
    #[error("run is already claimed by another lease")]
    LeaseUnavailable,
    #[error("run is cancelled")]
    RunCancelled,
    #[error("idempotency key is already bound to a different request")]
    IdempotencyConflict,
    #[error("OS-level isolation is unavailable: {0}")]
    IsolationUnavailable(String),
    #[error("offline: mac runtime is not connected")]
    Offline,
    #[error("adapter capability is unavailable: {0}")]
    AdapterUnavailable(String),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("runtime channel error: {0}")]
    Channel(String),
    #[error("sandboxed process timed out")]
    ProcessTimeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OfflineError;

impl std::fmt::Display for OfflineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MAC_OFFLINE")
    }
}

impl std::error::Error for OfflineError {}
