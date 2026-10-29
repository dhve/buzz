//! Explicit, session-only advisory review. This module has no moderation writes.
pub(crate) mod context;
mod input;
pub(crate) mod lifecycle;
mod policy;
mod relay;
mod result;
pub(crate) mod service;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Unsupported,
    Unavailable,
    Timeout,
    InvalidResponse,
    Cancelled,
    Stale,
    Busy,
    Inaccessible,
    InvalidRequest,
}

/// Safe IPC error; never contains relay bodies, source text, or model output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JudgeError {
    pub code: ErrorCode,
}
impl From<ErrorCode> for JudgeError {
    fn from(code: ErrorCode) -> Self {
        Self { code }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JudgeRequest {
    pub report_event_id: String,
    pub model_id: String,
    pub request_id: String,
    pub policy: policy::ReviewPolicySelection,
    pub expected_relay_url: Option<String>,
    pub expected_signer_pubkey: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct Projection {
    pub system: String,
    pub user: String,
}
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}
