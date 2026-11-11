use crate::edl::Project;
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLog {
    pub version: u32,
    pub entries: Vec<ReviewLogEntry>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewLogEntry {
    pub id: String,
    pub created_at: String,
    pub kind: String,
    pub action: String,
    pub before_text: String,
    pub after_text: String,
    pub media_id: String,
    pub occurrence_lineage: String,
    pub anchor_ids: Vec<String>,
    pub source_in: f64,
    pub source_out: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
}
pub fn validate(project: &Project) -> Result<()> {
    let Some(log) = &project.review_log else {
        return Ok(());
    };
    ensure!(
        log.version == 1 && log.entries.len() <= 10000,
        "Unsupported or oversized review log"
    );
    let short = |s: &str, max: usize| !s.trim().is_empty() && s.encode_utf16().count() <= max;
    let mut ids = std::collections::HashSet::new();
    let mut size = 0;
    for e in &log.entries {
        ensure!(
            short(&e.id, 512)
                && ids.insert(&e.id)
                && short(&e.created_at, 64)
                && chrono::DateTime::parse_from_rfc3339(&e.created_at).is_ok()
                && ["script", "filler"].contains(&e.kind.as_str())
                && ["accept", "dismiss", "keep", "revert", "cut", "replace", "hide", "reopen"]
                    .contains(&e.action.as_str())
                && e.before_text.encode_utf16().count() <= 100000
                && e.after_text.encode_utf16().count() <= 100000
                && short(&e.media_id, 512)
                && short(&e.occurrence_lineage, 512)
                && !e.anchor_ids.is_empty()
                && e.anchor_ids.len() <= 10000
                && e.anchor_ids
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    == e.anchor_ids.len()
                && e.anchor_ids.iter().all(|id| short(id, 512))
                && e.source_in.is_finite()
                && e.source_out.is_finite()
                && e.source_in >= 0.0
                && e.source_out >= e.source_in
                && e.record_id.as_ref().map_or(true, |id| short(id, 512))
                && e.candidate_id.as_ref().map_or(true, |id| short(id, 4096)),
            "Invalid review log entry"
        );
        size += e.before_text.encode_utf16().count() + e.after_text.encode_utf16().count();
    }
    ensure!(size <= 4000000, "Review log size limit exceeded");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Project {
        let mut p: Project =
            serde_json::from_str(include_str!("../../tests/fixtures/script-assistance.json"))
                .unwrap();
        p.review_log = Some(
            serde_json::from_str(include_str!("../../tests/fixtures/review-log.json")).unwrap(),
        );
        p
    }
    #[test]
    fn shared_log_schema_round_trips() {
        let p = fixture();
        crate::transcript::validate_project(&p).unwrap();
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/review-log.json")).unwrap();
        assert_eq!(
            serde_json::to_value(p.review_log.unwrap()).unwrap(),
            expected
        );
    }
    #[test]
    fn invalid_logs_are_rejected() {
        let mut p = fixture();
        p.review_log.as_mut().unwrap().version = 2;
        assert!(validate(&p).is_err());
        let mut p = fixture();
        p.review_log.as_mut().unwrap().entries[0].action = "future-action".into();
        assert!(validate(&p).is_err());
        let mut p = fixture();
        p.review_log.as_mut().unwrap().entries[0].source_out = f64::NAN;
        assert!(validate(&p).is_err());
        let mut p = fixture();
        let e = p.review_log.as_ref().unwrap().entries[0].clone();
        p.review_log.as_mut().unwrap().entries.push(e);
        assert!(validate(&p).is_err());
    }
    #[tokio::test]
    async fn log_survives_save_reopen_and_snapshot() {
        let p = fixture();
        let dir = std::env::temp_dir().join(format!("review-log-{}.scribe", uuid::Uuid::new_v4()));
        crate::project::save(&p, &dir).await.unwrap();
        let expected = serde_json::to_value(&p).unwrap();
        assert_eq!(
            serde_json::to_value(crate::project::load(&dir).await.unwrap()).unwrap(),
            expected
        );
        let snapshot = crate::snapshots::create(&dir, &p, "review log")
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(crate::snapshots::restore(&dir, &snapshot.id).await.unwrap())
                .unwrap(),
            expected
        );
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
