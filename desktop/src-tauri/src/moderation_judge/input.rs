use super::{ErrorCode, JudgeError};
use nostr::Event;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub(super) struct Report {
    pub report_event_id: String,
    pub target_kind: String,
    pub target: String,
    pub channel_id: Option<String>,
    pub report_type: String,
    pub status: String,
}
#[derive(Clone)]
pub(super) struct Source {
    pub report: Report,
    pub event: Event,
    pub metadata: Event,
}
pub(super) fn validate(
    report: Report,
    event: Event,
    metadata: Event,
    edits: &[Event],
) -> Result<Source, JudgeError> {
    if report.status != "open" || report.target_kind != "event" || report.report_type == "illegal" {
        return Err(ErrorCode::Unsupported.into());
    }
    let channel = report.channel_id.as_deref().ok_or(ErrorCode::Unsupported)?;
    if uuid::Uuid::parse_str(channel).is_err() {
        return Err(ErrorCode::Unsupported.into());
    }
    if event.verify().is_err()
        || metadata.verify().is_err()
        || event.id.to_hex() != report.target
        || event.kind.as_u16() != 9
        || metadata.kind.as_u16() != 39000
        || values(&event, "h") != vec![channel]
        || values(&metadata, "d") != vec![channel]
    {
        return Err(ErrorCode::Inaccessible.into());
    }
    let visibility = values(&metadata, "visibility");
    let explicitly_open =
        visibility == vec!["open"] || (visibility.is_empty() && has(&metadata, "public"));
    // Canonical group state puts the channel type first, then labels.
    // The shared label parser rejects reserved type names in later tags.
    let types_and_labels = values(&metadata, "t");
    let supported_type = types_and_labels
        .split_first()
        .is_some_and(|(kind, labels)| {
            matches!(*kind, "stream" | "forum")
                && labels.iter().all(|label| !label.is_empty())
                && buzz_core_pkg::channel::parse_channel_labels(labels.iter().copied()).is_ok()
        });
    if !explicitly_open
        || !supported_type
        || ["private", "hidden"]
            .iter()
            .any(|tag| has(&metadata, tag) || has(&event, tag))
        || has(&event, "imeta")
        || !edits.is_empty()
        || event.content.trim().is_empty()
        || event.content.len() > 8192
    {
        return Err(ErrorCode::Unsupported.into());
    }
    Ok(Source {
        report,
        event,
        metadata,
    })
}
fn values<'a>(event: &'a Event, name: &str) -> Vec<&'a str> {
    event
        .tags
        .iter()
        .filter(|t| t.as_slice().first().is_some_and(|s| s == name))
        .map(|t| t.as_slice().get(1).map(String::as_str).unwrap_or(""))
        .collect()
}
fn has(event: &Event, name: &str) -> bool {
    event
        .tags
        .iter()
        .any(|t| t.as_slice().first().is_some_and(|s| s == name))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    pub const CHANNEL: &str = "a5166c34-38f5-4c34-96d8-f70960d47f2c";
    pub fn event(kind: u16, content: &str, tags: Vec<Vec<&str>>) -> Event {
        EventBuilder::new(Kind::from(kind), content)
            .tags(tags.into_iter().map(|t| Tag::parse(t).unwrap()))
            .sign_with_keys(&Keys::generate())
            .unwrap()
    }
    pub fn fixture() -> (Report, Event, Event) {
        let source = event(9, "send me your password", vec![vec!["h", CHANNEL]]);
        let metadata = event(
            39000,
            "",
            vec![
                vec!["d", CHANNEL],
                vec!["t", "stream"],
                vec!["visibility", "open"],
            ],
        );
        (
            Report {
                report_event_id: "a".repeat(64),
                target_kind: "event".into(),
                target: source.id.to_hex(),
                channel_id: Some(CHANNEL.into()),
                report_type: "spam".into(),
                status: "open".into(),
            },
            source,
            metadata,
        )
    }
    #[test]
    fn private_missing_visibility_dm_and_conflicting_channels_are_ineligible() {
        for tags in [
            vec![vec!["d", CHANNEL], vec!["t", "stream"]],
            vec![
                vec!["d", CHANNEL],
                vec!["t", "dm"],
                vec!["visibility", "open"],
            ],
            vec![
                vec!["d", CHANNEL],
                vec!["t", "stream"],
                vec!["visibility", "open"],
                vec!["private"],
            ],
        ] {
            let (report, source, _) = fixture();
            assert_eq!(
                validate(report, source, event(39000, "", tags), &[])
                    .err()
                    .unwrap()
                    .code,
                ErrorCode::Unsupported
            );
        }
    }
    #[test]
    fn illegal_reports_and_edits_are_rejected() {
        let (mut report, source, metadata) = fixture();
        report.report_type = "illegal".into();
        assert_eq!(
            validate(report, source, metadata, &[]).err().unwrap().code,
            ErrorCode::Unsupported
        );
        let (report, source, metadata) = fixture();
        let edit = event(40003, "changed", vec![]);
        assert_eq!(
            validate(report, source, metadata, &[edit])
                .err()
                .unwrap()
                .code,
            ErrorCode::Unsupported
        );
    }
    #[test]
    fn source_identity_signature_scope_and_attachments_are_checked() {
        for tags in [
            vec![vec!["h", CHANNEL], vec!["h", CHANNEL]],
            vec![
                vec!["h", CHANNEL],
                vec!["imeta", "url https://example.invalid/x"],
            ],
        ] {
            let (mut report, _, metadata) = fixture();
            let source = event(9, "text", tags);
            report.target = source.id.to_hex();
            assert!(validate(report, source, metadata, &[]).is_err());
        }
        let (report, mut source, metadata) = fixture();
        source.content = "tampered".into();
        assert_eq!(
            validate(report, source, metadata, &[]).err().unwrap().code,
            ErrorCode::Inaccessible
        );
    }
}

#[cfg(test)]
mod channel_type_tests {
    use super::{tests::*, *};
    #[test]
    fn labels_cannot_supply_or_conflict_with_channel_type() {
        for types in [
            vec![],
            vec!["workspace"],
            vec!["workspace", "forum"],
            vec!["dm", "workspace"],
            vec!["system", "workspace"],
            vec!["stream", "forum"],
            vec!["forum", "dm"],
            vec!["stream", "stream"],
            vec!["forum", ""],
            vec!["forum", "invalid label"],
        ] {
            let (report, source, _) = fixture();
            let mut tags = vec![vec!["d", CHANNEL], vec!["visibility", "open"]];
            tags.extend(types.into_iter().map(|kind| vec!["t", kind]));
            assert_eq!(
                validate(report, source, event(39000, "", tags), &[])
                    .err()
                    .unwrap()
                    .code,
                ErrorCode::Unsupported
            );
        }
    }
}
