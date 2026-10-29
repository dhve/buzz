//! Narrow IPC boundary: callers select a report and policy, never a prompt or URL.
#[cfg(feature = "mesh-llm")]
use crate::moderation_judge::{
    self,
    service::{Backend, Context, Environment, JudgeFuture},
};
use crate::{
    app_state::AppState,
    moderation_judge::{service::JudgeAssessment, ErrorCode, JudgeError, JudgeRequest},
};
#[cfg(feature = "mesh-llm")]
use std::sync::Arc;
#[cfg(feature = "mesh-llm")]
use tauri::Manager;
use tauri::{AppHandle, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgeStatus {
    available: bool,
    reason: Option<ErrorCode>,
    local_model_ids: Vec<String>,
    active_request_id: Option<String>,
    runtime_id: Option<String>,
}

/// Explicit advisory request. Results exist only in the calling review session.
#[tauri::command]
pub async fn review_moderation_report<R: tauri::Runtime>(
    app: AppHandle<R>,
    request: JudgeRequest,
) -> Result<JudgeAssessment, JudgeError> {
    #[cfg(not(feature = "mesh-llm"))]
    {
        let _ = (app, request);
        Err(ErrorCode::Unavailable.into())
    }
    #[cfg(feature = "mesh-llm")]
    {
        let coordinator = app.state::<AppState>().moderation_judge.clone();
        let response =
            moderation_judge::service::start(Arc::new(AppEnvironment(app)), coordinator, request)?;
        response
            .await
            .map_err(|_| JudgeError::from(ErrorCode::Unavailable))?
    }
}
/// Idempotently cancel this request without releasing unresolved backend work.
#[tauri::command]
pub fn cancel_moderation_review(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), JudgeError> {
    state.moderation_judge.cancel(&request_id)
}
/// Local capability metadata only; this command submits no model request.
#[tauri::command]
pub async fn moderation_judge_status(
    state: State<'_, AppState>,
) -> Result<JudgeStatus, JudgeError> {
    let active_request_id = state.moderation_judge.active_id();
    #[cfg(not(feature = "mesh-llm"))]
    {
        Ok(JudgeStatus {
            available: false,
            reason: Some(ErrorCode::Unavailable),
            local_model_ids: vec![],
            active_request_id,
            runtime_id: None,
        })
    }
    #[cfg(feature = "mesh-llm")]
    {
        let context = moderation_judge::context::capture(&state).await?;
        let (runtime_id, judge) = {
            let runtime = state.mesh_llm_runtime.lock().await;
            let Some(runtime) = runtime.as_ref() else {
                return Ok(JudgeStatus {
                    available: false,
                    reason: Some(ErrorCode::Unavailable),
                    local_model_ids: vec![],
                    active_request_id,
                    runtime_id: None,
                });
            };
            (
                Some(runtime.id().to_string()),
                runtime.local_judge(&context).await,
            )
        };
        let (local_model_ids, reason) = match judge {
            Ok(judge) => {
                match tokio::time::timeout(std::time::Duration::from_secs(3), judge.models()).await
                {
                    Ok(Ok(models)) if !models.is_empty() => (models, None),
                    Ok(Ok(_)) => (vec![], Some(ErrorCode::Unavailable)),
                    Ok(Err(error)) => (vec![], Some(error.code)),
                    Err(_) => (vec![], Some(ErrorCode::Timeout)),
                }
            }
            Err(error) => (vec![], Some(error.code)),
        };
        Ok(JudgeStatus {
            available: reason.is_none(),
            reason,
            local_model_ids,
            active_request_id,
            runtime_id,
        })
    }
}
#[cfg(feature = "mesh-llm")]
struct AppEnvironment<R: tauri::Runtime>(AppHandle<R>);
#[cfg(feature = "mesh-llm")]
impl<R: tauri::Runtime> Environment for AppEnvironment<R> {
    fn snapshot(&self) -> JudgeFuture<'_, Context> {
        Box::pin(async { moderation_judge::context::capture(&self.0.state::<AppState>()).await })
    }
    fn lease<'a>(
        &'a self,
        context: &'a Context,
        model: &'a str,
    ) -> JudgeFuture<'a, Arc<dyn Backend>> {
        Box::pin(async move {
            let state = self.0.state::<AppState>();
            let judge = {
                let runtime = state.mesh_llm_runtime.lock().await;
                runtime
                    .as_ref()
                    .ok_or(ErrorCode::Unavailable)?
                    .local_judge(context)
                    .await?
            };
            judge.lease(model).await
        })
    }
    fn runtime_id(&self) -> JudgeFuture<'_, Option<u64>> {
        Box::pin(async {
            Ok(self
                .0
                .state::<AppState>()
                .mesh_llm_runtime
                .lock()
                .await
                .as_ref()
                .map(|r| r.id()))
        })
    }
}

#[cfg(all(test, not(feature = "mesh-llm")))]
mod tests {
    use super::*;
    #[test]
    fn no_mesh_commands_preserve_structured_unavailability() {
        let app = tauri::test::mock_builder()
            .manage(crate::app_state::build_app_state())
            .invoke_handler(tauri::generate_handler![
                review_moderation_report,
                cancel_moderation_review,
                moderation_judge_status
            ])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        for (command, body) in [
            (
                "review_moderation_report",
                serde_json::json!({"request":{"reportEventId":"a".repeat(64),"modelId":"local-model","requestId":uuid::Uuid::new_v4().to_string(),"policy":{"kind":"builtin_v1"}}}),
            ),
            ("moderation_judge_status", serde_json::json!({})),
            (
                "cancel_moderation_review",
                serde_json::json!({"requestId":uuid::Uuid::new_v4().to_string()}),
            ),
        ] {
            let response = tauri::test::get_ipc_response(
                &webview,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
            );
            if command == "review_moderation_report" {
                assert_eq!(
                    response.unwrap_err(),
                    serde_json::json!({"code":"unavailable"})
                );
            } else if command == "moderation_judge_status" {
                let status: serde_json::Value = response.unwrap().deserialize().unwrap();
                assert_eq!(status["available"], false);
                assert_eq!(status["reason"], "unavailable");
                assert_eq!(status["localModelIds"], serde_json::json!([]));
            } else {
                assert!(response.is_ok());
            }
        }
    }
}
