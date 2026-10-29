//! Private local-only completion adapter. No HTTP ingress, routing fallback,
//! downloads, runtime restarts, or changes to another workload's settings.
use super::{DesktopMeshHandle, DesktopMeshRuntime, MeshNodeMode};
use crate::moderation_judge::{
    service::{Backend, Completion, Context, JudgeFuture},
    ErrorCode, JudgeError, Projection,
};
use mesh_llm_sdk::{
    LocalCompletionBackendErrorKind, LocalCompletionClient, LocalCompletionEligibility,
    LocalCompletionError, LocalCompletionFinish, LocalCompletionLimits, LocalCompletionMessage,
    LocalCompletionModel, LocalCompletionRequest, LocalCompletionResponse, LocalCompletionRole,
    LocalModelSelector,
};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

/// Owned control client; no AppState runtime or SDK handle lock survives here.
pub(crate) struct LocalJudgeRuntime {
    runtime_id: u64,
    client: LocalCompletionClient,
}
impl DesktopMeshRuntime {
    pub(crate) async fn local_judge(
        &self,
        context: &Context,
    ) -> Result<LocalJudgeRuntime, JudgeError> {
        let start = self.start_request();
        let mesh_name = crate::commands::mesh_llm::buzz_mesh_name_for_relay(&context.relay_ws);
        if self.mode() != MeshNodeMode::Serve
            || start.relay_url.as_deref() != Some(context.relay_ws.as_str())
            || start.mesh_name.as_deref() != Some(mesh_name.as_str())
            || start.trusted_owner_ids.is_none()
        {
            return Err(ErrorCode::Unsupported.into());
        }
        let handle = self.handle.lock().await;
        let DesktopMeshHandle::Ready(handle) = &*handle else {
            return Err(ErrorCode::Unavailable.into());
        };
        Ok(LocalJudgeRuntime {
            runtime_id: self.id(),
            client: handle.local_completion_client().map_err(map_error)?,
        })
    }
}
impl LocalJudgeRuntime {
    pub(crate) async fn models(&self) -> Result<Vec<String>, JudgeError> {
        let models = self.client.local_models().await.map_err(map_error)?;
        Ok(eligible_model_ids(&models))
    }
    pub(crate) async fn lease(&self, model: &str) -> Result<Arc<dyn Backend>, JudgeError> {
        let models = self.client.local_models().await.map_err(map_error)?;
        let selected = select_model(&models, model)?;
        Ok(Arc::new(LocalJudgeBackend {
            runtime_id: self.runtime_id,
            client: self.client.clone(),
            model_id: selected.model_id,
            instance_id: selected.instance_id,
        }))
    }
}
struct LocalJudgeBackend {
    runtime_id: u64,
    client: LocalCompletionClient,
    model_id: String,
    instance_id: String,
}
impl Backend for LocalJudgeBackend {
    fn runtime_id(&self) -> u64 {
        self.runtime_id
    }
    fn complete(
        &self,
        projection: Projection,
        cancel: CancellationToken,
    ) -> JudgeFuture<'_, Completion> {
        Box::pin(async move {
            if cancel.is_cancelled() {
                return Err(ErrorCode::Cancelled.into());
            }
            let request = completion_request(&self.instance_id, projection);
            // Do not drop submit after enqueueing. Cancellation is forwarded as
            // soon as its admitted job exists, even if the control reply is late.
            let job = confirmed(self.client.submit(request).await).await?;
            let cancellation = job.cancel_handle();
            let outcome = wait_terminal(job.wait(), cancel, move || cancellation.cancel()).await;
            let response = confirmed(outcome).await?;
            validate_completion(response, &self.instance_id, &self.model_id)
        })
    }
}

fn eligible_model_ids(models: &[LocalCompletionModel]) -> Vec<String> {
    let mut ids: Vec<_> = models
        .iter()
        .filter_map(|model| {
            select_model(models, &model.model_id)
                .ok()
                .map(|m| m.model_id)
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids
}
fn select_model(
    models: &[LocalCompletionModel],
    id: &str,
) -> Result<LocalCompletionModel, JudgeError> {
    let mut matching = models.iter().filter(|model| model.model_id == id);
    let model = matching.next().ok_or(ErrorCode::Unavailable)?;
    if matching.next().is_some()
        || model.eligibility != LocalCompletionEligibility::Eligible
        || model.backend != "skippy"
        || model.context_length <= 512
        || id.trim() != id
        || id.is_empty()
        || id.len() > 256
        || id.chars().any(char::is_control)
        || ["auto", "mesh"]
            .iter()
            .any(|name| id.eq_ignore_ascii_case(name))
    {
        return Err(ErrorCode::Unsupported.into());
    }
    Ok(model.clone())
}
fn completion_request(instance: &str, projection: Projection) -> LocalCompletionRequest {
    LocalCompletionRequest {
        model: LocalModelSelector::InstanceId(instance.into()),
        messages: vec![
            LocalCompletionMessage {
                role: LocalCompletionRole::System,
                content: projection.system,
            },
            LocalCompletionMessage {
                role: LocalCompletionRole::User,
                content: projection.user,
            },
        ],
        limits: LocalCompletionLimits {
            max_completion_tokens: 512,
            max_prompt_bytes: 24576,
            max_completion_bytes: 16384,
            deadline: Some(Duration::from_secs(60)),
            temperature: 0.0,
            seed: None,
        },
        response_format: Some(serde_json::json!({"type":"json_object"})),
        request_label: Some("buzz-moderation-v1".into()),
    }
}
async fn wait_terminal<T>(
    future: impl std::future::Future<Output = T>,
    cancel: CancellationToken,
    signal: impl FnOnce(),
) -> T {
    tokio::pin!(future);
    tokio::select! { biased;
        _ = cancel.cancelled() => { signal(); future.await },
        result = &mut future => result,
    }
}
async fn confirmed<T>(result: Result<T, LocalCompletionError>) -> Result<T, JudgeError> {
    if matches!(
        result,
        Err(LocalCompletionError::ResponseDropped | LocalCompletionError::TerminationUnknown)
    ) {
        // A lost acknowledgement does not establish backend termination. The
        // service's own timer responds to the user, retaining app admission.
        return std::future::pending().await;
    }
    result.map_err(map_error)
}
fn validate_completion(
    response: LocalCompletionResponse,
    instance: &str,
    model: &str,
) -> Result<Completion, JudgeError> {
    if response.instance_id != instance
        || response.model_id != model
        || response.finish_reason != LocalCompletionFinish::Stop
        || response.completion_tokens > 512
        || response.content.len() > 16384
    {
        return Err(ErrorCode::InvalidResponse.into());
    }
    Ok(Completion {
        text: response.content,
        reported_model: response.model_id,
        mesh_version: mesh_llm_host_runtime::BUILD_VERSION.into(),
        stopped: true,
    })
}
fn map_error(error: LocalCompletionError) -> JudgeError {
    use LocalCompletionError as E;
    let code = match error {
        E::InvalidRequest(_) => ErrorCode::InvalidRequest,
        E::Ambiguous { .. } | E::Ineligible { .. } | E::NotServing | E::ContextBudgetExceeded => {
            ErrorCode::Unsupported
        }
        E::Busy => ErrorCode::Busy,
        E::AdmissionTimeout | E::DeadlineExceeded => ErrorCode::Timeout,
        E::Cancelled => ErrorCode::Cancelled,
        E::OutputTooLarge { .. } | E::UnsupportedResponseShape(_) => ErrorCode::InvalidResponse,
        E::Backend {
            kind:
                LocalCompletionBackendErrorKind::ContextLengthExceeded
                | LocalCompletionBackendErrorKind::UnsupportedFeature,
            ..
        } => ErrorCode::Unsupported,
        E::Backend {
            kind: LocalCompletionBackendErrorKind::Timeout,
            ..
        } => ErrorCode::Timeout,
        E::Backend {
            kind: LocalCompletionBackendErrorKind::Cancelled,
            ..
        } => ErrorCode::Cancelled,
        E::ModelNotLoadedLocally { .. }
        | E::ControlUnavailable
        | E::ShuttingDown
        | E::Backend { .. }
        | E::ResponseDropped
        | E::TerminationUnknown => ErrorCode::Unavailable,
    };
    code.into()
}

#[cfg(test)]
#[path = "judge_tests.rs"]
mod tests;
