use super::{ErrorCode, JudgeError};
use serde::{Deserialize, Serialize};
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Assessment {
    pub verdict: String,
    pub matches: Vec<RuleMatch>,
    pub uncertainty: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuleMatch {
    pub rule_id: String,
    pub evidence: String,
    pub reason: String,
}
pub(super) fn validate(text: &str, source: &str) -> Result<Assessment, JudgeError> {
    if text.len() > 16384 {
        return Err(ErrorCode::InvalidResponse.into());
    }
    let shape: serde_json::Value =
        serde_json::from_str(text).map_err(|_| ErrorCode::InvalidResponse)?;
    if !shape
        .as_object()
        .is_some_and(|o| o.len() == 3 && o.contains_key("uncertainty"))
    {
        return Err(ErrorCode::InvalidResponse.into());
    }
    let result: Assessment = serde_json::from_str(text).map_err(|_| ErrorCode::InvalidResponse)?;
    let explanation_valid = match &result.uncertainty {
        Some(s) => !s.trim().is_empty() && s.chars().count() <= 256,
        None => false,
    };
    let valid = match result.verdict.as_str() {
        "needs_review" => !result.matches.is_empty() && result.uncertainty.is_none(),
        "no_match" => result.matches.is_empty() && result.uncertainty.is_none(),
        "uncertain" => explanation_valid,
        _ => false,
    };
    let mut seen = std::collections::HashSet::new();
    if !valid
        || result.matches.len() > 3
        || result.matches.iter().any(|m| {
            !super::policy::RULE_IDS.contains(&m.rule_id.as_str())
                || !seen.insert(&m.rule_id)
                || m.evidence.trim().is_empty()
                || m.evidence.chars().count() > 128
                || !source.contains(&m.evidence)
                || m.reason.trim().is_empty()
                || m.reason.chars().count() > 256
        })
    {
        return Err(ErrorCode::InvalidResponse.into());
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fabricated_evidence_never_becomes_a_verdict() {
        let text = r#"{"verdict":"needs_review","matches":[{"rule_id":"G2_ABUSE","evidence":"invented","reason":"abuse"}],"uncertainty":null}"#;
        assert_eq!(
            validate(text, "actual message").unwrap_err().code,
            ErrorCode::InvalidResponse
        );
    }
    #[test]
    fn unknown_verdict_and_inconsistent_matches_fail() {
        for text in [
            r#"{"verdict":"ban","matches":[],"uncertainty":null}"#,
            r#"{"verdict":"needs_review","matches":[],"uncertainty":null}"#,
            r#"{"verdict":"uncertain","matches":[],"uncertainty":null}"#,
        ] {
            assert_eq!(
                validate(text, "hello").unwrap_err().code,
                ErrorCode::InvalidResponse
            );
        }
    }
}

#[cfg(test)]
mod bounds_tests {
    use super::*;
    #[test]
    fn exact_schema_and_text_bounds_are_enforced() {
        for text in [
            r#"{"verdict":"no_match","matches":[]}"#.to_string(),
            r#"{"verdict":"no_match","matches":[],"uncertainty":null,"action":"delete"}"#.to_string(),
            r#"{"verdict":"no_match","matches":[],"uncertainty":null,"tool_calls":[]}"#.to_string(),
            r#"```json {"verdict":"no_match","matches":[],"uncertainty":null}```"#.to_string(),
            serde_json::json!({"verdict":"uncertain","matches":[],"uncertainty":"x".repeat(257)}).to_string(),
            serde_json::json!({"verdict":"needs_review","matches":[{"rule_id":"G2_ABUSE","evidence":"x".repeat(129),"reason":"reason"}],"uncertainty":null}).to_string(),
            " ".repeat(16385),
        ] {assert_eq!(validate(&text,&"x".repeat(200)).unwrap_err().code,ErrorCode::InvalidResponse);}
    }
}
