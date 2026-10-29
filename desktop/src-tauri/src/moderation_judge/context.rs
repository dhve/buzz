use super::{service::Context, ErrorCode, JudgeError};
use crate::app_state::AppState;
pub(crate) async fn capture(state: &AppState) -> Result<Context, JudgeError> {
    use std::sync::atomic::Ordering;
    let _workspace = state.workspace_apply_lock.lock().await;
    let _identity = state
        .identity_mutation
        .lock()
        .map_err(|_| ErrorCode::Unavailable)?;
    let keys = state.signing_keys().map_err(|_| ErrorCode::Unavailable)?;
    let relay_ws = crate::relay::relay_ws_url_with_override(state)
        .trim()
        .trim_end_matches('/')
        .to_string();
    let api_base = crate::relay::relay_http_base_url(&relay_ws);
    let parsed = url::Url::parse(&api_base).map_err(|_| ErrorCode::Unsupported)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(ErrorCode::Unsupported.into());
    }
    Ok(Context {
        relay_ws,
        api_base,
        keys,
        generation: state.workspace_apply_generation.load(Ordering::Acquire),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::Ordering, Arc};
    #[tokio::test]
    async fn capture_waits_for_coherent_workspace_and_signer_snapshot() {
        let state = Arc::new(crate::app_state::build_app_state());
        let guard = state.workspace_apply_lock.lock().await;
        let capture_state = state.clone();
        let pending = tokio::spawn(async move { capture(&capture_state).await });
        tokio::task::yield_now().await;
        assert!(!pending.is_finished());
        let keys = nostr::Keys::generate();
        *state.keys.lock().unwrap() = keys.clone();
        *state.relay_url_override.lock().unwrap() = Some("wss://community-b.example".into());
        state.workspace_apply_generation.store(2, Ordering::Release);
        drop(guard);
        let context = pending.await.unwrap().unwrap();
        assert_eq!(context.api_base, "https://community-b.example");
        assert_eq!(context.keys.public_key(), keys.public_key());
        assert_eq!(context.generation, 2);
        *state.keys.lock().unwrap() = nostr::Keys::generate();
        assert!(!context.same(&capture(&state).await.unwrap()));
    }
    #[tokio::test]
    async fn recovery_identity_never_authorizes_review() {
        let state = crate::app_state::build_app_state();
        state.keyring_locked.store(true, Ordering::Release);
        assert_eq!(
            capture(&state).await.err().unwrap().code,
            ErrorCode::Unavailable
        );
    }
}
