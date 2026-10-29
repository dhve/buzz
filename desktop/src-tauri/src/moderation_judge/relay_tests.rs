use super::*;
use crate::moderation_judge::input::tests::fixture;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use nostr::Event;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

pub(crate) struct Fixture {
    pub base: String,
    pub keys: Keys,
    pub data: Arc<Mutex<Data>>,
    server: tokio::task::JoinHandle<()>,
}
pub(crate) struct Data {
    pub report: Value,
    pub source: Event,
    pub metadata: Event,
    pub edits: Vec<Event>,
    pub denied: bool,
    pub missing: bool,
    pub missing_source: bool,
    pub queries: Vec<Value>,
    pub auth_ok: bool,
    pub response_override: Option<(StatusCode, Vec<u8>)>,
    pub signer: String,
    pub base: String,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    pub async fn start() -> Self {
        let (report, source, metadata) = fixture();
        let keys = Keys::generate();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let data = Arc::new(Mutex::new(Data {
            report: json!({"report_event_id":report.report_event_id,"target_kind":"event","target":report.target,"channel_id":report.channel_id,"report_type":"spam","status":"open","note":"REPORTER_NOTE_CANARY","reporter_pubkey":"REPORTER_IDENTITY_CANARY"}),
            source,
            metadata,
            edits: vec![],
            denied: false,
            missing: false,
            missing_source: false,
            queries: vec![],
            auth_ok: true,
            response_override: None,
            signer: keys.public_key().to_hex(),
            base: base.clone(),
        }));
        let app = Router::new()
            .route("/moderation/reports", get(handler))
            .route("/query", post(handler))
            .with_state(data.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            base,
            keys,
            data,
            server,
        }
    }
    pub fn reader(&self) -> JudgeRelay {
        JudgeRelay {
            base: self.base.clone(),
            keys: self.keys.clone(),
        }
    }
}
async fn handler(
    State(data): State<Arc<Mutex<Data>>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    let mut data = data.lock().unwrap();
    let encoded = headers
        .get("authorization")
        .unwrap()
        .to_str()
        .unwrap()
        .strip_prefix("Nostr ")
        .unwrap();
    let auth: Event = serde_json::from_slice(&STANDARD.decode(encoded).unwrap()).unwrap();
    let tags: Vec<_> = auth.tags.iter().map(|t| t.as_slice().to_vec()).collect();
    let wanted = [
        vec!["u".to_string(), format!("{}{}", data.base, uri)],
        vec!["method".into(), method.to_string()],
        vec!["payload".into(), hex::encode(Sha256::digest(&body))],
    ];
    data.auth_ok &= auth.verify().is_ok()
        && auth.kind.as_u16() == 27235
        && auth.pubkey.to_hex() == data.signer
        && wanted.iter().all(|t| tags.contains(t))
        && !headers.contains_key("x-auth-tag");
    if let Some((status, body)) = &data.response_override {
        return (*status, body.clone()).into_response();
    }
    if data.denied && method == Method::GET {
        return (StatusCode::FORBIDDEN, Json(json!([data.report]))).into_response();
    }
    if method == Method::GET {
        return Json(if data.missing {
            json!([])
        } else {
            json!([data.report])
        })
        .into_response();
    }
    let query: Value = serde_json::from_slice(&body).unwrap();
    data.queries.push(query.clone());
    let kind = query[0]["kinds"][0].as_u64().unwrap();
    Json(match kind {
        9 if !data.missing && !data.missing_source => json!([data.source]),
        39000 => json!([data.metadata]),
        40003 => json!(data.edits),
        _ => json!([]),
    })
    .into_response()
}
#[tokio::test]
async fn authenticated_read_pins_url_body_key_and_canonical_filters() {
    let fixture = Fixture::start().await;
    let source = fixture.reader().read(&"a".repeat(64)).await.unwrap();
    assert_eq!(source.event.content, "send me your password");
    let data = fixture.data.lock().unwrap();
    assert!(data.auth_ok);
    assert_eq!(data.queries.len(), 3);
    assert_eq!(
        data.queries[0],
        json!([{"ids":[data.source.id.to_hex()],"kinds":[9],"#h":[super::super::input::tests::CHANNEL],"limit":1}])
    );
    assert_eq!(
        data.queries[2],
        json!([{"kinds":[40003],"#e":[data.source.id.to_hex()],"#h":[super::super::input::tests::CHANNEL],"limit":1}])
    );
}
#[tokio::test]
async fn denied_and_missing_reports_are_indistinguishable() {
    let fixture = Fixture::start().await;
    fixture.data.lock().unwrap().denied = true;
    let denied = fixture.reader().read(&"a".repeat(64)).await.err().unwrap();
    {
        let mut data = fixture.data.lock().unwrap();
        data.denied = false;
        data.missing = true;
    }
    let missing = fixture.reader().read(&"a".repeat(64)).await.err().unwrap();
    assert_eq!(denied, missing);
    assert_eq!(denied.code, ErrorCode::Inaccessible);
}

#[tokio::test]
async fn relay_failures_and_oversized_bodies_never_look_like_empty_results() {
    let fixture = Fixture::start().await;
    for (status, body, code) in [
        (
            StatusCode::TOO_MANY_REQUESTS,
            vec![],
            ErrorCode::Unavailable,
        ),
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            vec![],
            ErrorCode::Unavailable,
        ),
        (
            StatusCode::OK,
            b"malformed".to_vec(),
            ErrorCode::Inaccessible,
        ),
        (
            StatusCode::OK,
            vec![b' '; 1024 * 1024 + 1],
            ErrorCode::Inaccessible,
        ),
    ] {
        fixture.data.lock().unwrap().response_override = Some((status, body));
        assert_eq!(
            fixture
                .reader()
                .read(&"a".repeat(64))
                .await
                .err()
                .unwrap()
                .code,
            code
        );
    }
}
#[tokio::test]
async fn redirect_does_not_forward_the_signed_authorization() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let hits = Arc::new(AtomicUsize::new(0));
    let capture = hits.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let target = format!("{base}/stolen");
    let app = Router::new()
        .route(
            "/moderation/reports",
            get(move || async move { axum::response::Redirect::temporary(&target) }),
        )
        .route(
            "/stolen",
            get(move || async move {
                capture.fetch_add(1, Ordering::SeqCst);
                Json(json!([]))
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    assert_eq!(
        JudgeRelay {
            base,
            keys: Keys::generate()
        }
        .read(&"a".repeat(64))
        .await
        .err()
        .unwrap()
        .code,
        ErrorCode::Unavailable
    );
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    server.abort();
}

#[tokio::test]
async fn canonical_labeled_open_channels_pass_authenticated_initial_read() {
    for kind in ["stream", "forum"] {
        let fixture = Fixture::start().await;
        let mut tags = buzz_core_pkg::channel::group_state_identity_tags(
            kind,
            &["workspace".into(), "team:core".into()],
            &fixture.keys.public_key().to_bytes(),
        )
        .unwrap();
        tags.push(nostr::Tag::parse(["d", super::super::input::tests::CHANNEL]).unwrap());
        tags.push(nostr::Tag::parse(["visibility", "open"]).unwrap());
        let metadata = nostr::EventBuilder::new(nostr::Kind::from(39000), "")
            .tags(tags)
            .sign_with_keys(&fixture.keys)
            .unwrap();
        fixture.data.lock().unwrap().metadata = metadata.clone();
        let source = fixture.reader().read(&"a".repeat(64)).await.unwrap();
        assert_eq!(source.metadata.id, metadata.id);
        assert!(fixture.data.lock().unwrap().auth_ok);
    }
}
