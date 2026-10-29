//! Invoke the actual command handlers: ignored expected-scope IPC fields must
//! fail these checks before any request can reach the relay.
use crate::app_state::build_app_state;

#[test]
fn report_action_scope_rejects_changed_community_and_signer_at_native_entry() {
    let state = build_app_state();
    *state.relay_url_override.lock().unwrap() = Some("http://127.0.0.1:1".to_string());
    let signer = state.signing_keys().unwrap().public_key().to_hex();
    let app = tauri::test::mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            crate::commands::messages::delete_message,
            crate::commands::channels::remove_channel_member,
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    for command in ["delete_message", "remove_channel_member"] {
        for (relay, key, expected) in [
            (
                "wss://previous.example",
                signer.clone(),
                "active community changed",
            ),
            (
                "ws://127.0.0.1:1",
                "ab".repeat(32),
                "active identity changed",
            ),
        ] {
            let body = serde_json::json!({
                "channelId": "7e080000-0000-4000-8000-000000000001",
                "eventId": "cd".repeat(32), "pubkey": "cd".repeat(32),
                "expectedRelayUrl": relay, "expectedSignerPubkey": key,
            });
            let error = tauri::test::get_ipc_response(
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
            )
            .unwrap_err();
            assert!(
                error.as_str().unwrap().contains(expected),
                "{command} must reject {expected} before network I/O: {error}"
            );
        }
    }
}
