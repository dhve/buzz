use super::{ErrorCode, JudgeError};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct JudgeCoordinator {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    generation: u64,
    active: Option<Operation>,
}
#[derive(Clone)]
pub(super) struct Operation {
    pub id: String,
    pub generation: u64,
    pub cancel: CancellationToken,
}
impl JudgeCoordinator {
    pub(super) fn begin(&self, id: String) -> Result<Operation, JudgeError> {
        let mut state = self.state.lock().map_err(|_| ErrorCode::Unavailable)?;
        if state.active.is_some() {
            return Err(ErrorCode::Busy.into());
        }
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or(ErrorCode::Unavailable)?;
        let op = Operation {
            id,
            generation: state.generation,
            cancel: CancellationToken::new(),
        };
        state.active = Some(op.clone());
        Ok(op)
    }
    pub fn cancel(&self, id: &str) -> Result<(), JudgeError> {
        let state = self.state.lock().map_err(|_| ErrorCode::Unavailable)?;
        if let Some(op) = state.active.as_ref().filter(|op| op.id == id) {
            op.cancel.cancel();
        }
        Ok(())
    }
    pub fn active_id(&self) -> Option<String> {
        self.state
            .lock()
            .ok()
            .and_then(|s| s.active.as_ref().map(|o| o.id.clone()))
    }
    pub(super) fn finish(&self, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state
                .active
                .as_ref()
                .is_some_and(|op| op.generation == generation)
            {
                state.active = None;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::moderation_judge::ErrorCode;
    use std::sync::Arc;
    #[test]
    fn cancellation_keeps_admission_until_backend_termination() {
        let coordinator = Arc::new(JudgeCoordinator::default());
        let op = coordinator.begin("first".into()).unwrap();
        coordinator.cancel("other").unwrap();
        assert!(!op.cancel.is_cancelled());
        coordinator.cancel("first").unwrap();
        assert!(op.cancel.is_cancelled());
        assert_eq!(
            coordinator.begin("second".into()).err().unwrap().code,
            ErrorCode::Busy
        );
        coordinator.finish(op.generation);
        assert!(coordinator.begin("second".into()).is_ok());
    }
    #[test]
    fn old_generation_cannot_release_new_operation() {
        let c = JudgeCoordinator::default();
        let first = c.begin("first".into()).unwrap();
        c.finish(first.generation);
        c.begin("second".into()).unwrap();
        c.finish(first.generation);
        assert_eq!(c.active_id().as_deref(), Some("second"));
    }
}
