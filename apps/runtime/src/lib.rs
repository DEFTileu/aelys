//! Aelys headless macOS runtime.
//!
//! The runtime deliberately keeps complete agent sessions local. Only the
//! types in [`metadata`] are eligible for cloud synchronization.

pub mod adapter;
pub mod channel;
pub mod credentials;
pub mod db;
pub mod discovery;
pub mod error;
pub mod isolation;
pub mod metadata;
pub mod paths;
pub mod process;
pub mod protocol;
pub mod runner;
pub mod runs;
pub mod sandbox;

pub use error::{OfflineError, RuntimeError, RuntimeResult};
