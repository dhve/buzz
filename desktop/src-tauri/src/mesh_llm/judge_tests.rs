//! These tests exercise the production runtime binding and SDK request builder.
use super::*;
use crate::mesh_llm::{DesktopMeshHandle, MeshNodeMode, StartMeshNodeRequest};
use mesh_llm_sdk::{LocalCompletionEligibility, LocalCompletionIneligibility};

fn context() -> Context {
    Context {
        relay_ws: "wss://community-a.example".into(),
        api_base: "https://community-a.example".into(),
        keys: nostr::Keys::generate(),
        generation: 1,
    }
}
fn runtime(context: &Context) -> DesktopMeshRuntime {
    DesktopMeshRuntime {
        id: 7,
        handle: tokio::sync::Mutex::new(DesktopMeshHandle::Failed("fixture".into())),
        mode: MeshNodeMode::Serve,
        api_base_url: String::new(),
        console_url: String::new(),
        model_id: None,
        model_name: None,
        start_request: StartMeshNodeRequest {
            mode: MeshNodeMode::Serve,
            model_id: Some("local-model".into()),
            max_vram_gb: None,
            join_token: None,
            relay_url: Some(context.relay_ws.clone()),
            mesh_name: Some(crate::commands::mesh_llm::buzz_mesh_name_for_relay(
                &context.relay_ws,
            )),
            trusted_owner_ids: Some(vec![]),
        },
    }
}
#[tokio::test]
async fn runtime_binding_fails_before_reading_local_capability() {
    let context = context();
    for change in 0..4 {
        let mut runtime = runtime(&context);
        match change {
            0 => runtime.start_request.relay_url = Some("wss://community-b.example".into()),
            1 => runtime.start_request.mesh_name = Some("wrong-mesh".into()),
            2 => runtime.start_request.trusted_owner_ids = None,
            _ => runtime.mode = MeshNodeMode::Client,
        }
        assert_eq!(
            runtime.local_judge(&context).await.err().unwrap().code,
            ErrorCode::Unsupported
        );
    }
    assert_eq!(
        runtime(&context)
            .local_judge(&context)
            .await
            .err()
            .unwrap()
            .code,
        ErrorCode::Unavailable
    );
}
fn model(id: &str, instance: &str) -> LocalCompletionModel {
    LocalCompletionModel {
        instance_id: instance.into(),
        model_id: id.into(),
        model_ref: id.into(),
        profile: "local".into(),
        context_length: 8192,
        backend: "skippy".into(),
        eligibility: LocalCompletionEligibility::Eligible,
    }
}
#[test]
fn model_picker_excludes_split_capture_and_ambiguous_instances() {
    let good = model("chosen", "one");
    let mut split = model("split", "two");
    split.eligibility =
        LocalCompletionEligibility::Ineligible(LocalCompletionIneligibility::SplitStage {
            stage_id: "0".into(),
        });
    let mut capture = model("capture", "three");
    capture.eligibility =
        LocalCompletionEligibility::Ineligible(LocalCompletionIneligibility::ReceiptsEnabled);
    let mut kv = model("kv", "four");
    kv.eligibility =
        LocalCompletionEligibility::Ineligible(LocalCompletionIneligibility::KvCachePersistence {
            mode: "record".into(),
        });
    let models = vec![
        good.clone(),
        split,
        capture,
        kv,
        model("duplicate", "five"),
        model("duplicate", "six"),
        model("mesh", "virtual"),
    ];
    assert_eq!(eligible_model_ids(&models), vec!["chosen"]);
    assert_eq!(select_model(&models, "chosen").unwrap().instance_id, "one");
    for rejected in ["split", "capture", "kv", "duplicate", "mesh"] {
        assert_eq!(
            select_model(&models, rejected).unwrap_err().code,
            ErrorCode::Unsupported
        );
    }
    assert_eq!(
        select_model(&models, "absent").unwrap_err().code,
        ErrorCode::Unavailable
    );
}
#[test]
fn sdk_request_pins_instance_and_all_generation_limits() {
    let request = completion_request(
        "instance-one",
        Projection {
            system: "fixed instructions".into(),
            user: "untrusted text".into(),
        },
    );
    assert_eq!(
        request.model,
        LocalModelSelector::InstanceId("instance-one".into())
    );
    assert_eq!(request.messages.len(), 2);
    assert_eq!(request.messages[0].role, LocalCompletionRole::System);
    assert_eq!(request.messages[1].role, LocalCompletionRole::User);
    assert_eq!(request.limits.max_completion_tokens, 512);
    assert_eq!(request.limits.max_prompt_bytes, 24576);
    assert_eq!(request.limits.max_completion_bytes, 16384);
    assert_eq!(request.limits.temperature, 0.0);
    assert_eq!(
        request.limits.deadline,
        Some(std::time::Duration::from_secs(60))
    );
    assert_eq!(
        request.response_format,
        Some(serde_json::json!({"type":"json_object"}))
    );
}
#[test]
fn sdk_errors_remain_structured_without_backend_diagnostics() {
    for (error, want) in [
        (
            LocalCompletionError::InvalidRequest("CONTENT_CANARY".into()),
            ErrorCode::InvalidRequest,
        ),
        (
            LocalCompletionError::Backend {
                status: 500,
                kind: LocalCompletionBackendErrorKind::Internal,
            },
            ErrorCode::Unavailable,
        ),
        (
            LocalCompletionError::ContextBudgetExceeded,
            ErrorCode::Unsupported,
        ),
        (LocalCompletionError::Cancelled, ErrorCode::Cancelled),
        (LocalCompletionError::DeadlineExceeded, ErrorCode::Timeout),
        (
            LocalCompletionError::OutputTooLarge { max_bytes: 16384 },
            ErrorCode::InvalidResponse,
        ),
        (LocalCompletionError::Busy, ErrorCode::Busy),
    ] {
        let actual = map_error(error);
        assert_eq!(actual.code, want);
        assert!(!serde_json::to_string(&actual)
            .unwrap()
            .contains("CONTENT_CANARY"));
    }
}

#[tokio::test]
async fn cancellation_signals_sdk_and_waits_for_termination() {
    let cancel = CancellationToken::new();
    let (terminated, wait) = tokio::sync::oneshot::channel();
    let (signalled, signal) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(wait_terminal(
        async { wait.await.unwrap() },
        cancel.clone(),
        move || {
            let _ = signalled.send(());
        },
    ));
    cancel.cancel();
    signal.await.unwrap();
    assert!(
        !running.is_finished(),
        "SDK cancellation is not termination"
    );
    terminated.send(7).unwrap();
    assert_eq!(running.await.unwrap(), 7);
}
#[tokio::test]
async fn lost_sdk_acknowledgement_cannot_release_unresolved_work() {
    for error in [
        LocalCompletionError::ResponseDropped,
        LocalCompletionError::TerminationUnknown,
    ] {
        assert!(
            tokio::time::timeout(Duration::from_millis(5), confirmed::<()>(Err(error)))
                .await
                .is_err()
        );
    }
    assert_eq!(
        confirmed::<()>(Err(LocalCompletionError::Cancelled))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Cancelled
    );
}
#[test]
fn completion_requires_matching_instance_and_untruncated_output() {
    fn response() -> LocalCompletionResponse {
        LocalCompletionResponse {
            model_id: "local-model".into(),
            instance_id: "one".into(),
            content: r#"{"verdict":"no_match","matches":[],"uncertainty":null}"#.into(),
            finish_reason: LocalCompletionFinish::Stop,
            prompt_tokens: 10,
            completion_tokens: 20,
            reasoning_bytes_discarded: 0,
            elapsed: Duration::from_secs(1),
        }
    }
    assert!(validate_completion(response(), "one", "local-model").is_ok());
    for change in 0..5 {
        let mut output = response();
        match change {
            0 => output.instance_id = "other-instance".into(),
            1 => output.model_id = "other-model".into(),
            2 => output.finish_reason = LocalCompletionFinish::Length,
            3 => output.completion_tokens = 513,
            _ => output.content = "x".repeat(16385),
        }
        assert_eq!(
            validate_completion(output, "one", "local-model")
                .err()
                .unwrap()
                .code,
            ErrorCode::InvalidResponse
        );
    }
}
