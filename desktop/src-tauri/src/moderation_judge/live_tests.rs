//! Opt-in real relay + local runtime smoke. Loaded as a mesh_llm child only so
//! test startup can supply an isolated owner key without changing desktop state.
use super::*;
use crate::moderation_judge::{
    lifecycle::JudgeCoordinator,
    service::{self, Backend, Completion, Context, Environment, JudgeFuture},
    ErrorCode, JudgeRequest, Projection,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    relay_url: String,
    alternate_relay_url: String,
    report_event_id: String,
    source_event_id: String,
    channel_id: String,
    owner_private_key: String,
    owner_pubkey: String,
    member_private_key: String,
    admin_private_key: String,
    guest_private_key: String,
    channel_admin_private_key: String,
    revoked_private_key: String,
}
struct ObservedBackend {
    inner: Arc<dyn Backend>,
    entered: Arc<Notify>,
    terminated: Arc<AtomicBool>,
    forbidden: Vec<String>,
}
impl Backend for ObservedBackend {
    fn runtime_id(&self) -> u64 {
        self.inner.runtime_id()
    }
    fn complete(
        &self,
        projection: Projection,
        cancel: CancellationToken,
    ) -> JudgeFuture<'_, Completion> {
        Box::pin(async move {
            let serialized = serde_json::to_string(&projection).unwrap();
            assert!(
                !serialized.contains("REPORTER_NOTE_CANARY"),
                "report note entered projection"
            );
            for needle in &self.forbidden {
                assert!(
                    !serialized.contains(needle),
                    "report metadata entered projection"
                );
            }
            self.entered.notify_one();
            let result = self.inner.complete(projection, cancel).await;
            self.terminated.store(true, Ordering::SeqCst);
            result
        })
    }
}
struct LiveEnvironment {
    context: Context,
    runtime: Arc<DesktopMeshRuntime>,
    calls: Arc<AtomicUsize>,
    entered: Arc<Notify>,
    terminated: Arc<AtomicBool>,
    forbidden: Vec<String>,
}
impl Environment for LiveEnvironment {
    fn snapshot(&self) -> JudgeFuture<'_, Context> {
        Box::pin(async { Ok(self.context.clone()) })
    }
    fn runtime_id(&self) -> JudgeFuture<'_, Option<u64>> {
        Box::pin(async { Ok(Some(self.runtime.id())) })
    }
    fn lease<'a>(
        &'a self,
        context: &'a Context,
        model: &'a str,
    ) -> JudgeFuture<'a, Arc<dyn Backend>> {
        Box::pin(async move {
            let backend = self
                .runtime
                .local_judge(context)
                .await?
                .lease(model)
                .await?;
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(ObservedBackend {
                inner: backend,
                entered: self.entered.clone(),
                terminated: self.terminated.clone(),
                forbidden: self.forbidden.clone(),
            }) as Arc<dyn Backend>)
        })
    }
}
// Authorization probes retain the real relay pipeline and actual runtime
// binding/selection. Only the completion after successful admission is controlled.
struct AuthorizationProbe {
    context: Context,
    runtime: Arc<DesktopMeshRuntime>,
    lease_calls: AtomicUsize,
    completion_calls: Arc<AtomicUsize>,
}
struct ProbeCompletion {
    runtime_id: u64,
    model: String,
    calls: Arc<AtomicUsize>,
}
impl Backend for ProbeCompletion {
    fn runtime_id(&self) -> u64 {
        self.runtime_id
    }
    fn complete(&self, _: Projection, _: CancellationToken) -> JudgeFuture<'_, Completion> {
        Box::pin(async {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(Completion {
                text: r#"{"verdict":"no_match","matches":[],"uncertainty":null}"#.into(),
                reported_model: self.model.clone(),
                mesh_version: mesh_llm_host_runtime::BUILD_VERSION.into(),
                stopped: true,
            })
        })
    }
}
impl Environment for AuthorizationProbe {
    fn snapshot(&self) -> JudgeFuture<'_, Context> {
        Box::pin(async { Ok(self.context.clone()) })
    }
    fn runtime_id(&self) -> JudgeFuture<'_, Option<u64>> {
        Box::pin(async { Ok(Some(self.runtime.id())) })
    }
    fn lease<'a>(
        &'a self,
        context: &'a Context,
        model: &'a str,
    ) -> JudgeFuture<'a, Arc<dyn Backend>> {
        Box::pin(async move {
            self.lease_calls.fetch_add(1, Ordering::SeqCst);
            // Invoke the production adapter against the actual loaded runtime.
            // For community B this must reject before any completion content.
            let local = self
                .runtime
                .local_judge(context)
                .await?
                .lease(model)
                .await?;
            Ok(Arc::new(ProbeCompletion {
                runtime_id: local.runtime_id(),
                model: model.into(),
                calls: self.completion_calls.clone(),
            }) as Arc<dyn Backend>)
        })
    }
}
async fn real_relay_authorization_matrix(
    fixture: &Fixture,
    context: &Context,
    runtime: &Arc<DesktopMeshRuntime>,
    model: &str,
) {
    for (role, key, permitted) in [
        ("admin", &fixture.admin_private_key, true),
        ("member", &fixture.member_private_key, false),
        ("guest", &fixture.guest_private_key, false),
        ("channel_admin", &fixture.channel_admin_private_key, false),
        ("revoked_admin", &fixture.revoked_private_key, false),
    ] {
        let probe = Arc::new(AuthorizationProbe {
            context: Context {
                keys: nostr::Keys::parse(key).unwrap(),
                ..context.clone()
            },
            runtime: runtime.clone(),
            lease_calls: AtomicUsize::new(0),
            completion_calls: Arc::new(AtomicUsize::new(0)),
        });
        let result = service::start(
            probe.clone(),
            Arc::new(JudgeCoordinator::default()),
            request(fixture, model),
        )
        .unwrap()
        .await
        .unwrap();
        if permitted {
            assert_eq!(result.unwrap().assessment.verdict, "no_match");
            assert_eq!(probe.lease_calls.load(Ordering::SeqCst), 1);
            assert_eq!(probe.completion_calls.load(Ordering::SeqCst), 1);
        } else {
            assert_eq!(result.unwrap_err().code, ErrorCode::Inaccessible, "{role}");
            assert_eq!(
                probe.lease_calls.load(Ordering::SeqCst),
                0,
                "{role} reached backend lease"
            );
            assert_eq!(
                probe.completion_calls.load(Ordering::SeqCst),
                0,
                "{role} reached completion"
            );
        }
    }
    let other_url = url::Url::parse(&fixture.alternate_relay_url).unwrap();
    assert!(matches!(
        other_url.host_str(),
        Some("127.0.0.1" | "localhost")
    ));
    assert_ne!(fixture.alternate_relay_url, context.relay_ws);
    let probe = Arc::new(AuthorizationProbe {
        context: Context {
            relay_ws: fixture.alternate_relay_url.clone(),
            api_base: crate::relay::relay_http_base_url(&fixture.alternate_relay_url),
            ..context.clone()
        },
        runtime: runtime.clone(),
        lease_calls: AtomicUsize::new(0),
        completion_calls: Arc::new(AtomicUsize::new(0)),
    });
    let mut other_request = request(fixture, model);
    other_request.expected_relay_url = Some(fixture.alternate_relay_url.clone());
    let result = service::start(
        probe.clone(),
        Arc::new(JudgeCoordinator::default()),
        other_request,
    )
    .unwrap()
    .await
    .unwrap();
    assert_eq!(result.unwrap_err().code, ErrorCode::Unsupported);
    // Reaching lease proves B's real canonical reads accepted the identical
    // report/source IDs. A's actual runtime binding then refuses B's content.
    assert_eq!(probe.lease_calls.load(Ordering::SeqCst), 1);
    assert_eq!(probe.completion_calls.load(Ordering::SeqCst), 0);
    eprintln!("judge_smoke admin=allowed member=denied guest=denied channel_admin=denied revoked_admin=denied identical_ids_runtime_binding=denied");
}

fn request(fixture: &Fixture, model: &str) -> JudgeRequest {
    serde_json::from_value(serde_json::json!({
        "reportEventId":fixture.report_event_id,"modelId":model,
        "requestId":uuid::Uuid::new_v4().to_string(),"policy":{"kind":"builtin_v1"},
        "expectedRelayUrl":fixture.relay_url
    }))
    .unwrap()
}
fn env_path(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os(name).unwrap_or_else(|| panic!("required isolated path env {name}")),
    )
}
fn isolated_path(name: &str, root: &Path) -> PathBuf {
    let path = env_path(name);
    std::fs::create_dir_all(&path).unwrap();
    let path = path.canonicalize().unwrap();
    assert!(
        path.starts_with(root),
        "runtime path must be inside smoke root"
    );
    path
}
fn scan_capture(root: &Path, needles: &[String]) -> usize {
    let mut scanned = 0;
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        // Do not follow external model/native asset symlinks.
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            scanned += scan_capture(&entry.path(), needles);
        } else if kind.is_file() {
            let bytes = std::fs::read(entry.path()).unwrap();
            for needle in needles {
                assert!(
                    !bytes
                        .windows(needle.len())
                        .any(|window| window == needle.as_bytes()),
                    "content canary found in isolated runtime files"
                );
            }
            scanned += 1;
        }
    }
    scanned
}
async fn wait_terminal(coordinator: &JudgeCoordinator, terminated: &AtomicBool) {
    tokio::time::timeout(Duration::from_secs(70), async {
        while coordinator.active_id().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("unresolved backend work did not terminate");
    assert!(
        terminated.load(Ordering::SeqCst),
        "service guard released before adapter returned"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires isolated live relay, explicit local GGUF, native runtime and smoke paths; see docs/moderation-judge-evaluation.md"]
async fn isolated_relay_and_real_local_model() {
    let root = env_path("BUZZ_JUDGE_LIVE_ROOT").canonicalize().unwrap();
    for name in [
        "MESH_LLM_DATA_DIR",
        "MESH_LLM_RUNTIME_ROOT",
        "MESH_LLM_TEST_HOME",
        "HF_HOME",
        "HF_HUB_CACHE",
        "MESH_LLM_NATIVE_RUNTIME_CACHE_DIR",
    ] {
        isolated_path(name, &root);
    }
    assert!(
        std::env::var_os("MESH_LLM_SWARM_CAPTURE").is_none_or(|value| value.is_empty()),
        "swarm capture must be disabled"
    );
    let fixture: Fixture =
        serde_json::from_slice(&std::fs::read(env_path("BUZZ_JUDGE_LIVE_FIXTURE")).unwrap())
            .unwrap();
    let relay = url::Url::parse(&fixture.relay_url).unwrap();
    assert!(
        matches!(relay.host_str(), Some("127.0.0.1" | "localhost")),
        "only an isolated loopback relay is allowed"
    );
    let model_path = env_path("BUZZ_JUDGE_LIVE_MODEL").canonicalize().unwrap();
    assert!(model_path.is_file());
    let model_ref = model_path.to_str().unwrap().to_owned();
    let api_port: u16 = std::env::var("BUZZ_MESH_API_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let console_port: u16 = std::env::var("BUZZ_MESH_CONSOLE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        api_port != 9337
            && console_port != 3131
            && api_port != console_port
            && api_port != 0
            && console_port != 0,
        "dedicated non-default ports required"
    );
    let keys = nostr::Keys::parse(&fixture.owner_private_key).unwrap();
    assert_eq!(keys.public_key().to_hex(), fixture.owner_pubkey);
    let member_pubkey = nostr::Keys::parse(&fixture.member_private_key)
        .unwrap()
        .public_key()
        .to_hex();
    let context = Context {
        relay_ws: fixture.relay_url.clone(),
        api_base: crate::relay::relay_http_base_url(&fixture.relay_url),
        keys,
        generation: 1,
    };
    // Read the canary source for the file scan. The service independently does
    // its own canonical, policy and authorization reads on every operation.
    let query_url = format!("{}/query", context.api_base);
    let body = serde_json::to_vec(&serde_json::json!([{"ids":[fixture.source_event_id],"kinds":[9],"#h":[fixture.channel_id],"limit":1}])).unwrap();
    let auth = crate::relay::build_nip98_auth_header_for_keys(
        &context.keys,
        &reqwest::Method::POST,
        &query_url,
        &body,
    )
    .unwrap();
    let mut sources: Vec<nostr::Event> = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
        .post(query_url)
        .header("Authorization", auth)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sources.len(), 1, "one signed synthetic source required");
    let source = sources.remove(0);
    assert!(
        source.verify().is_ok(),
        "synthetic source signature invalid"
    );
    assert_eq!(source.id.to_hex(), fixture.source_event_id);
    let source_text = source.content;
    let owner = mesh_llm_host_runtime::crypto::OwnerKeypair::generate();
    let owner_path = root.join("owner-keystore.json");
    mesh_llm_host_runtime::crypto::save_keystore(&owner_path, &owner, None, false).unwrap();
    let mesh_name = crate::commands::mesh_llm::buzz_mesh_name_for_relay(&fixture.relay_url);
    mesh_llm_host_runtime::initialize_host_runtime()
        .await
        .expect("native runtime initialization failed");
    let ready = serve::start(
        serve::EmbeddedServeConfig::builder()
            .model(&model_ref)
            .api_port(api_port)
            .console_port(console_port)
            .owner_key(owner_path)
            .owner_required(true)
            .trust_policy(TrustPolicy::Allowlist)
            .trust_owner(owner.owner_id())
            .mesh_name(&mesh_name)
            .publish(false)
            .auto_join(false)
            .disable_iroh_relays(true)
            .discovery_mode(MeshDiscoveryMode::Nostr)
            .isolated_config(true)
            .startup_timeout(Duration::from_secs(180))
            .build(),
    )
    .await
    .expect("local model startup failed");
    let local_client = ready.local_completion_client().unwrap();
    let start_request = StartMeshNodeRequest {
        mode: MeshNodeMode::Serve,
        model_id: Some(model_ref.clone()),
        max_vram_gb: None,
        join_token: None,
        mesh_name: Some(mesh_name),
        relay_url: Some(fixture.relay_url.clone()),
        trusted_owner_ids: Some(vec![owner.owner_id()]),
    };
    let runtime = Arc::new(DesktopMeshRuntime {
        id: MESH_RUNTIME_ID_SEQ.fetch_add(1, Ordering::SeqCst),
        handle: tokio::sync::Mutex::new(DesktopMeshHandle::Ready(ready)),
        mode: MeshNodeMode::Serve,
        api_base_url: format!("http://127.0.0.1:{api_port}"),
        console_url: format!("http://127.0.0.1:{console_port}"),
        model_id: Some(model_ref),
        model_name: Some("isolated smoke model".into()),
        start_request,
    });
    // SDK startup acknowledges console readiness, not completion of model loading.
    // Wait only for a loaded instance; never turn an ineligible instance eligible.
    let readiness = async {
        let loaded = tokio::time::timeout(Duration::from_secs(180), async {
            loop {
                let loaded = local_client
                    .local_models()
                    .await
                    .map_err(|_| "local model enumeration failed")?;
                if !loaded.is_empty() {
                    return Ok::<_, &'static str>(loaded);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| "console ready but no local model appeared before deadline")??;
        eprintln!("judge_smoke local_models={loaded:?}");
        let models = runtime
            .local_judge(&context)
            .await
            .map_err(|_| "runtime binding or local capability unavailable")?
            .models()
            .await
            .map_err(|_| "eligible model enumeration failed")?;
        if models.len() != 1 {
            return Err("exactly one eligible local model required");
        }
        Ok(models[0].clone())
    }
    .await;
    drop(local_client);
    let model = match readiness {
        Ok(model) => model,
        Err(reason) => {
            eprintln!("judge_smoke model_readiness_failed={reason}; shutting down runtime");
            let shutdown = Arc::try_unwrap(runtime)
                .ok()
                .expect("unexpected runtime reference during readiness cleanup")
                .stop()
                .await;
            assert!(
                shutdown.is_ok(),
                "runtime shutdown failed after readiness failure"
            );
            panic!("{reason}");
        }
    };
    let env = Arc::new(LiveEnvironment {
        context: context.clone(),
        runtime: runtime.clone(),
        calls: Arc::new(AtomicUsize::new(0)),
        entered: Arc::new(Notify::new()),
        terminated: Arc::new(AtomicBool::new(false)),
        forbidden: vec![
            fixture.owner_pubkey.clone(),
            member_pubkey.clone(),
            fixture.report_event_id.clone(),
            fixture.source_event_id.clone(),
        ],
    });
    let coordinator = Arc::new(JudgeCoordinator::default());
    let started = std::time::Instant::now();
    let outcome = service::start(env.clone(), coordinator.clone(), request(&fixture, &model))
        .unwrap()
        .await
        .unwrap();
    let status = match outcome {
        Ok(assessment) => {
            assert_eq!(assessment.provenance.reported_model, model);
            "schema_valid"
        }
        Err(error) => {
            assert_eq!(
                error.code,
                ErrorCode::InvalidResponse,
                "only a safe invalid model response is an accepted smoke outcome"
            );
            "safe_invalid_response"
        }
    };
    wait_terminal(&coordinator, &env.terminated).await;
    env.entered.notified().await;
    assert_eq!(env.calls.load(Ordering::SeqCst), 1);
    eprintln!("judge_smoke status={status} model={model} mesh={} platform={}-{} policy=buzz-moderation-guidelines/v1 prompt=buzz-moderation-prompt/v1 elapsed_ms={}",mesh_llm_host_runtime::BUILD_VERSION,std::env::consts::OS,std::env::consts::ARCH,started.elapsed().as_millis());
    // The next response must be suppressed by explicit cancellation. The inner
    // production adapter still has to return before the guard is released.
    env.terminated.store(false, Ordering::SeqCst);
    let cancellation_request = request(&fixture, &model);
    let id = cancellation_request.request_id.clone();
    let response = service::start(env.clone(), coordinator.clone(), cancellation_request).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while env.calls.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        env.entered.notified().await;
    })
    .await
    .expect("second completion was not entered");
    tokio::time::sleep(Duration::from_millis(50)).await;
    coordinator.cancel(&id).unwrap();
    assert_eq!(
        response.await.unwrap().unwrap_err().code,
        ErrorCode::Cancelled,
        "model completed before cancellation; rerun cannot claim cancellation proof"
    );
    wait_terminal(&coordinator, &env.terminated).await;
    let member_env = Arc::new(LiveEnvironment {
        context: Context {
            keys: nostr::Keys::parse(&fixture.member_private_key).unwrap(),
            ..context
        },
        runtime: runtime.clone(),
        calls: env.calls.clone(),
        entered: env.entered.clone(),
        terminated: env.terminated.clone(),
        forbidden: env.forbidden.clone(),
    });
    assert_eq!(
        service::start(member_env, coordinator, request(&fixture, &model))
            .unwrap()
            .await
            .unwrap()
            .unwrap_err()
            .code,
        ErrorCode::Inaccessible
    );
    assert_eq!(
        env.calls.load(Ordering::SeqCst),
        2,
        "unauthorized member reached model lease"
    );
    real_relay_authorization_matrix(&fixture, &env.context, &runtime, &model).await;
    drop(env);
    Arc::try_unwrap(runtime)
        .ok()
        .expect("runtime lease retained after terminal work")
        .stop()
        .await
        .unwrap();
    let files = scan_capture(
        &root,
        &[
            source_text,
            "REPORTER_NOTE_CANARY".into(),
            fixture.owner_pubkey,
            member_pubkey,
        ],
    );
    eprintln!("judge_smoke cancellation=terminal member=denied capture_scan_files={files}");
}
