use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::adapter::AdapterKind;
use crate::error::{RuntimeError, RuntimeResult};

pub trait RunPersistence: Send + Sync {
    fn save(&self, record: &RunRecord) -> RuntimeResult<()>;
    fn restore_after_restart(&self) -> RuntimeResult<Vec<RunRecord>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Queued,
    Starting,
    Running,
    WaitingApproval,
    Completed,
    Failed,
    Cancelled,
    Expired,
}

impl std::fmt::Display for RunState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Queued => "queued",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::WaitingApproval => "waiting_approval",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
        })
    }
}

#[derive(Debug, Clone)]
pub struct RunRecord {
    pub run_id: Uuid,
    pub idempotency_key: String,
    pub project_id: Uuid,
    pub adapter: AdapterKind,
    pub task: String,
    pub state: RunState,
    pub lease_id: Option<Uuid>,
    pub lease_until: Option<DateTime<Utc>>,
    pub cancellation_requested: bool,
}

#[derive(Clone)]
pub struct RunManager {
    inner: Arc<Mutex<HashMap<String, RunRecord>>>,
    persistence: Option<Arc<dyn RunPersistence>>,
}

impl Default for RunManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            persistence: None,
        }
    }
}

impl RunManager {
    pub fn with_persistence(persistence: Arc<dyn RunPersistence>) -> RuntimeResult<Self> {
        let restored = persistence.restore_after_restart()?;
        let inner = restored
            .into_iter()
            .map(|record| (record.idempotency_key.clone(), record))
            .collect();
        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            persistence: Some(persistence),
        })
    }

    fn save(&self, record: &RunRecord) -> RuntimeResult<()> {
        if let Some(persistence) = &self.persistence {
            persistence.save(record)?;
        }
        Ok(())
    }

    pub fn get(&self, idempotency_key: &str) -> RuntimeResult<RunRecord> {
        self.inner
            .lock()
            .unwrap()
            .get(idempotency_key)
            .cloned()
            .ok_or(RuntimeError::LeaseUnavailable)
    }

    pub fn lease_valid(&self, idempotency_key: &str, now: DateTime<Utc>) -> RuntimeResult<bool> {
        let run = self.get(idempotency_key)?;
        Ok(run.lease_until.is_some_and(|until| until > now))
    }

    pub fn submit(
        &self,
        idempotency_key: impl Into<String>,
        project_id: Uuid,
        adapter: AdapterKind,
        task: impl Into<String>,
    ) -> RuntimeResult<RunRecord> {
        let key = idempotency_key.into();
        let task = task.into();
        let mut runs = self.inner.lock().unwrap();
        if let Some(existing) = runs.get(&key) {
            if existing.project_id != project_id
                || existing.adapter != adapter
                || existing.task != task
            {
                return Err(RuntimeError::IdempotencyConflict);
            }
            return Ok(existing.clone());
        }
        let record = RunRecord {
            run_id: Uuid::new_v4(),
            idempotency_key: key.clone(),
            project_id,
            adapter,
            task,
            state: RunState::Queued,
            lease_id: None,
            lease_until: None,
            cancellation_requested: false,
        };
        runs.insert(key, record.clone());
        drop(runs);
        self.save(&record)?;
        Ok(record)
    }

    pub fn claim(
        &self,
        idempotency_key: &str,
        now: DateTime<Utc>,
        lease_for: Duration,
    ) -> RuntimeResult<RunRecord> {
        let mut runs = self.inner.lock().unwrap();
        let run = runs
            .get_mut(idempotency_key)
            .ok_or(RuntimeError::LeaseUnavailable)?;
        if matches!(
            run.state,
            RunState::Completed | RunState::Failed | RunState::Cancelled | RunState::Expired
        ) {
            return Ok(run.clone());
        }
        if let Some(until) = run.lease_until {
            if until > now {
                return Err(RuntimeError::LeaseUnavailable);
            }
        }
        transition(run, RunState::Starting)?;
        run.lease_id = Some(Uuid::new_v4());
        run.lease_until = Some(now + lease_for);
        let result = run.clone();
        drop(runs);
        self.save(&result)?;
        Ok(result)
    }

    pub fn start(&self, idempotency_key: &str) -> RuntimeResult<RunRecord> {
        self.transition(idempotency_key, RunState::Running)
    }

    pub fn heartbeat(
        &self,
        idempotency_key: &str,
        now: DateTime<Utc>,
        lease_for: Duration,
    ) -> RuntimeResult<RunRecord> {
        let mut runs = self.inner.lock().unwrap();
        let run = runs
            .get_mut(idempotency_key)
            .ok_or(RuntimeError::LeaseUnavailable)?;
        if run.lease_until.is_none() || run.lease_until < Some(now) {
            return Err(RuntimeError::LeaseUnavailable);
        }
        run.lease_until = Some(now + lease_for);
        let result = run.clone();
        drop(runs);
        self.save(&result)?;
        Ok(result)
    }

    pub fn request_cancel(&self, idempotency_key: &str) -> RuntimeResult<RunRecord> {
        let mut runs = self.inner.lock().unwrap();
        let run = runs
            .get_mut(idempotency_key)
            .ok_or(RuntimeError::LeaseUnavailable)?;
        if matches!(run.state, RunState::Queued | RunState::Starting) {
            transition(run, RunState::Cancelled)?;
        } else if run.state == RunState::Running || run.state == RunState::WaitingApproval {
            run.cancellation_requested = true;
        }
        let result = run.clone();
        drop(runs);
        self.save(&result)?;
        Ok(result)
    }

    pub fn confirm_cancelled(&self, idempotency_key: &str) -> RuntimeResult<RunRecord> {
        self.transition(idempotency_key, RunState::Cancelled)
    }

    pub fn transition(&self, idempotency_key: &str, target: RunState) -> RuntimeResult<RunRecord> {
        let mut runs = self.inner.lock().unwrap();
        let run = runs
            .get_mut(idempotency_key)
            .ok_or(RuntimeError::LeaseUnavailable)?;
        transition(run, target)?;
        let result = run.clone();
        drop(runs);
        self.save(&result)?;
        Ok(result)
    }
}

fn transition(run: &mut RunRecord, target: RunState) -> RuntimeResult<()> {
    let allowed = match run.state {
        RunState::Queued => matches!(
            target,
            RunState::Starting | RunState::Cancelled | RunState::Expired
        ),
        RunState::Starting => matches!(
            target,
            RunState::Running | RunState::Failed | RunState::Cancelled
        ),
        RunState::Running => matches!(
            target,
            RunState::WaitingApproval
                | RunState::Completed
                | RunState::Failed
                | RunState::Cancelled
                | RunState::Expired
        ),
        RunState::WaitingApproval => matches!(
            target,
            RunState::Running | RunState::Completed | RunState::Failed | RunState::Cancelled
        ),
        RunState::Completed | RunState::Failed | RunState::Cancelled | RunState::Expired => false,
    };
    if !allowed {
        return Err(RuntimeError::InvalidStateTransition {
            from: run.state.to_string(),
            to: target.to_string(),
        });
    }
    run.state = target;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_submission_is_idempotent_and_different_payload_is_rejected() {
        let manager = RunManager::default();
        let project = Uuid::new_v4();
        let first = manager
            .submit("same", project, AdapterKind::CodexCli, "task")
            .unwrap();
        let second = manager
            .submit("same", project, AdapterKind::CodexCli, "task")
            .unwrap();
        assert_eq!(first.run_id, second.run_id);
        assert!(matches!(
            manager.submit("same", project, AdapterKind::CodexCli, "other"),
            Err(RuntimeError::IdempotencyConflict)
        ));
    }

    #[test]
    fn lease_and_cancellation_are_stateful() {
        let manager = RunManager::default();
        let project = Uuid::new_v4();
        manager
            .submit("run", project, AdapterKind::ClaudeCode, "task")
            .unwrap();
        let now = Utc::now();
        manager.claim("run", now, Duration::minutes(1)).unwrap();
        assert!(manager.claim("run", now, Duration::minutes(1)).is_err());
        manager.start("run").unwrap();
        let running = manager.request_cancel("run").unwrap();
        assert!(running.cancellation_requested);
        manager.confirm_cancelled("run").unwrap();
        assert!(manager.start("run").is_err());
    }
}
