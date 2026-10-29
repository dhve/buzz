use super::{lifecycle::JudgeCoordinator, ErrorCode, JudgeError, JudgeRequest, Projection};
use nostr::Keys;
use std::{future::Future, pin::Pin, sync::Arc};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub(crate) type JudgeFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, JudgeError>> + Send + 'a>>;
#[derive(Clone)]
pub(crate) struct Context {
    pub relay_ws: String,
    pub api_base: String,
    pub keys: Keys,
    pub generation: u64,
}
impl Context {
    pub fn same(&self, other: &Self) -> bool {
        self.relay_ws == other.relay_ws
            && self.api_base == other.api_base
            && self.generation == other.generation
            && self.keys.public_key() == other.keys.public_key()
    }
}
/// A lease only exists for a proven fully local, capture-disabled backend.
pub(crate) trait Backend: Send + Sync {
    fn runtime_id(&self) -> u64;
    fn complete(
        &self,
        projection: Projection,
        cancel: CancellationToken,
    ) -> JudgeFuture<'_, Completion>;
}
pub(crate) struct Completion {
    pub text: String,
    pub reported_model: String,
    pub mesh_version: String,
    pub stopped: bool,
}
pub(crate) trait Environment: Send + Sync {
    fn snapshot(&self) -> JudgeFuture<'_, Context>;
    fn lease<'a>(
        &'a self,
        context: &'a Context,
        model: &'a str,
    ) -> JudgeFuture<'a, Arc<dyn Backend>>;
    fn runtime_id(&self) -> JudgeFuture<'_, Option<u64>>;
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub source_digest: String,
    pub policy_digest: String,
    pub policy_source: String,
    pub policy_version: String,
    pub prompt_version: String,
    pub request_generation: String,
    pub request_id: String,
    pub runtime_id: String,
    pub requested_model: String,
    pub reported_model: String,
    pub mesh_version: String,
    pub started_at_ms: u64,
    pub elapsed_ms: u64,
}
#[derive(Debug, serde::Serialize)]
pub struct JudgeAssessment {
    #[serde(flatten)]
    pub assessment: super::result::Assessment,
    pub provenance: Provenance,
}

pub(crate) fn start(
    env: Arc<dyn Environment>,
    coordinator: Arc<JudgeCoordinator>,
    request: JudgeRequest,
) -> Result<oneshot::Receiver<Result<JudgeAssessment, JudgeError>>, JudgeError> {
    if nostr::EventId::from_hex(&request.report_event_id).is_err()
        || request.report_event_id.len() != 64
        || uuid::Uuid::parse_str(&request.request_id).is_err()
        || request.model_id.trim() != request.model_id
        || request.model_id.is_empty()
        || request.model_id.len() > 256
        || request.model_id.chars().any(char::is_control)
        || ["auto", "mesh"]
            .iter()
            .any(|s| request.model_id.eq_ignore_ascii_case(s))
    {
        return Err(ErrorCode::InvalidRequest.into());
    }
    let policy = super::policy::Policy::resolve(&request.policy)?;
    let op = coordinator.begin(request.request_id.clone())?;
    let (sender, receiver) = oneshot::channel();
    // An owned task survives a dropped IPC future. Only confirmed completion
    // releases admission; cancellation and runtime replacement cannot clear it.
    tokio::spawn(async move {
        let mut sender = Some(sender);
        let result = run(env, request, policy, &op, &mut sender).await;
        coordinator.finish(op.generation);
        respond(&mut sender, result);
    });
    Ok(receiver)
}
type Reply = Option<oneshot::Sender<Result<JudgeAssessment, JudgeError>>>;
fn respond(sender: &mut Reply, result: Result<JudgeAssessment, JudgeError>) {
    if let Some(sender) = sender.take() {
        let _ = sender.send(result);
    }
}
async fn assert_current(
    env: &dyn Environment,
    context: &Context,
    runtime: u64,
) -> Result<(), JudgeError> {
    if !context.same(&env.snapshot().await?) || env.runtime_id().await? != Some(runtime) {
        return Err(ErrorCode::Stale.into());
    }
    Ok(())
}
async fn run(
    env: Arc<dyn Environment>,
    request: JudgeRequest,
    policy: super::policy::Policy,
    op: &super::lifecycle::Operation,
    sender: &mut Reply,
) -> Result<JudgeAssessment, JudgeError> {
    let started = tokio::time::Instant::now();
    let deadline = started + std::time::Duration::from_secs(60);
    let started_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ErrorCode::Unavailable)?
        .as_millis() as u64;
    let preparation = async {
        let context = env.snapshot().await?;
        if request
            .expected_relay_url
            .as_deref()
            .is_some_and(|s| crate::relay::relay_http_base_url(s) != context.api_base)
            || request
                .expected_signer_pubkey
                .as_deref()
                .is_some_and(|s| s != context.keys.public_key().to_hex())
        {
            return Err(JudgeError::from(ErrorCode::Stale));
        }
        let reader = super::relay::JudgeRelay {
            base: context.api_base.clone(),
            keys: context.keys.clone(),
        };
        let source = reader.read(&request.report_event_id).await?;
        let projection = policy.projection(&source.event.content)?;
        let backend = env.lease(&context, &request.model_id).await?;
        assert_current(env.as_ref(), &context, backend.runtime_id()).await?;
        Ok((context, reader, source, projection, backend))
    };
    let (context, reader, source, projection, backend) = tokio::select! {biased;
        _=op.cancel.cancelled()=>return Err(ErrorCode::Cancelled.into()),
        _=tokio::time::sleep_until(deadline)=>return Err(ErrorCode::Timeout.into()),
        prepared=preparation=>prepared?,
    };
    if op.cancel.is_cancelled() {
        return Err(ErrorCode::Cancelled.into());
    }
    let completion = backend.complete(projection, op.cancel.clone());
    tokio::pin!(completion);
    let completed = tokio::select! {biased;
        _=op.cancel.cancelled()=>Err(ErrorCode::Cancelled.into()),
        _=tokio::time::sleep_until(deadline)=>Err(ErrorCode::Timeout.into()),
        result=&mut completion=>Ok(result),
    };
    let output = match completed {
        Ok(output) => output?,
        Err(error) => {
            op.cancel.cancel();
            respond(sender, Err(error));
            // Do not drop the backend future: its return is the termination
            // acknowledgement. Even a non-cooperating backend keeps us busy.
            let _ = completion.await;
            return Err(ErrorCode::Cancelled.into());
        }
    };
    if !output.stopped || output.reported_model.len() > 256 || output.mesh_version.len() > 128 {
        return Err(ErrorCode::InvalidResponse.into());
    }
    let assessment = super::result::validate(&output.text, &source.event.content)?;
    let revalidate = async {
        assert_current(env.as_ref(), &context, backend.runtime_id()).await?;
        let fresh = reader
            .read(&request.report_event_id)
            .await
            .map_err(|_| ErrorCode::Stale)?;
        if source.report != fresh.report
            || source.event.id != fresh.event.id
            || source.metadata.id != fresh.metadata.id
        {
            return Err(JudgeError::from(ErrorCode::Stale));
        }
        assert_current(env.as_ref(), &context, backend.runtime_id()).await
    };
    tokio::select! {biased;
        _=op.cancel.cancelled()=>return Err(ErrorCode::Cancelled.into()),
        _=tokio::time::sleep_until(deadline)=>return Err(ErrorCode::Timeout.into()),
        result=revalidate=>result?,
    }
    Ok(JudgeAssessment {
        assessment,
        provenance: Provenance {
            source_digest: super::digest(source.event.content.as_bytes()),
            policy_digest: policy.digest,
            policy_source: policy.source.into(),
            policy_version: policy.version,
            prompt_version: "buzz-moderation-prompt/v1".into(),
            request_generation: op.generation.to_string(),
            request_id: op.id.clone(),
            runtime_id: backend.runtime_id().to_string(),
            requested_model: request.model_id,
            reported_model: output.reported_model,
            mesh_version: output.mesh_version,
            started_at_ms,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
    })
}
#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
