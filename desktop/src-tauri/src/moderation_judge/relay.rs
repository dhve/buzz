use super::{input::Source, ErrorCode, JudgeError};
use nostr::Keys;

pub(super) struct JudgeRelay {
    pub base: String,
    pub keys: Keys,
}
impl JudgeRelay {
    pub async fn read(&self, report_id: &str) -> Result<Source, JudgeError> {
        use serde_json::json;
        let reports: Vec<super::input::Report> = self
            .fetch(
                reqwest::Method::GET,
                "/moderation/reports?status=open&limit=500",
                None,
                1024 * 1024,
            )
            .await?;
        if reports.len() > 500 {
            return Err(ErrorCode::Inaccessible.into());
        }
        let mut matching = reports
            .into_iter()
            .filter(|r| r.report_event_id == report_id);
        let report = matching.next().ok_or(ErrorCode::Inaccessible)?;
        if matching.next().is_some() {
            return Err(ErrorCode::Inaccessible.into());
        }
        if report.status != "open"
            || report.target_kind != "event"
            || report.report_type == "illegal"
        {
            return Err(ErrorCode::Unsupported.into());
        }
        let channel = report.channel_id.as_deref().ok_or(ErrorCode::Unsupported)?;
        if uuid::Uuid::parse_str(channel).is_err()
            || nostr::EventId::from_hex(&report.target).is_err()
        {
            return Err(ErrorCode::Unsupported.into());
        }
        let event = self
            .query(json!({"ids":[report.target],"kinds":[9],"#h":[channel],"limit":1}))
            .await?;
        let metadata = self
            .query(json!({"kinds":[39000],"#d":[channel],"limit":1}))
            .await?;
        let edits = self
            .query(json!({"kinds":[40003],"#e":[report.target],"#h":[channel],"limit":1}))
            .await?;
        let [event]: [nostr::Event; 1] = event.try_into().map_err(|_| ErrorCode::Inaccessible)?;
        let [metadata]: [nostr::Event; 1] =
            metadata.try_into().map_err(|_| ErrorCode::Inaccessible)?;
        super::input::validate(report, event, metadata, &edits)
    }
    async fn query(&self, filter: serde_json::Value) -> Result<Vec<nostr::Event>, JudgeError> {
        let body = serde_json::to_vec(&vec![filter]).map_err(|_| ErrorCode::InvalidRequest)?;
        self.fetch(reqwest::Method::POST, "/query", Some(body), 65536)
            .await
    }
    async fn fetch<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Vec<u8>>,
        limit: usize,
    ) -> Result<T, JudgeError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|_| ErrorCode::Unavailable)?;
        crate::relay_admission::wait_for_rate_limit().await;
        let url = format!("{}{}", self.base, path);
        let auth = crate::relay::build_nip98_auth_header_for_keys(
            &self.keys,
            &method,
            &url,
            body.as_deref().unwrap_or(&[]),
        )
        .map_err(|_| ErrorCode::Unavailable)?;
        let mut request = client.request(method, &url).header("Authorization", auth);
        if let Some(body) = body {
            request = request
                .header("Content-Type", "application/json")
                .body(body);
        }
        let mut response = request.send().await.map_err(network_error)?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 | 404 => return Err(ErrorCode::Inaccessible.into()),
            _ => return Err(ErrorCode::Unavailable.into()),
        }
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err(ErrorCode::Inaccessible.into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                return Err(ErrorCode::Inaccessible.into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| ErrorCode::Inaccessible.into())
    }
}
fn network_error(error: reqwest::Error) -> JudgeError {
    if error.is_timeout() {
        ErrorCode::Timeout
    } else {
        ErrorCode::Unavailable
    }
    .into()
}
#[cfg(test)]
#[path = "relay_tests.rs"]
pub(crate) mod tests;
