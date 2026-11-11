//! Additive stored Markdown and durable evidence. Text remains in transcript runs.
use crate::edl::Project;
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EditAuthorship {
    Manual,
    Script,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditProvenance {
    pub author: EditAuthorship,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredScript {
    pub revision: String,
    pub name: String,
    pub markdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScriptResultKind {
    Wording,
    Notation,
    Punctuation,
    OffScript,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScriptResultStatus {
    Suggested,
    Applied,
    Accepted,
    Kept,
    Reverted,
    Dismissed,
    OffScript,
    Cut,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptEvidence {
    pub engine: String,
    pub model: String,
    pub policy: String,
    pub unprompted: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows: Option<Vec<EvidenceWindow>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceWindow {
    pub source_in: f64,
    pub source_out: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptReviewRecord {
    pub id: String,
    pub policy: String,
    pub script_revision: String,
    pub media_id: String,
    pub occurrence_lineage: String,
    pub anchor_ids: Vec<String>,
    pub before_text: String,
    pub after_text: String,
    pub context_before: String,
    pub context_after: String,
    pub source_in: f64,
    pub source_out: f64,
    pub script_from: usize,
    pub script_to: usize,
    pub kind: ScriptResultKind,
    pub status: ScriptResultStatus,
    pub reason: String,
    pub evidence: ScriptEvidence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub historical_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptAssistance {
    pub version: u32,
    pub active_revision: String,
    pub scripts: Vec<StoredScript>,
    pub records: Vec<ScriptReviewRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sync_links: Vec<ScriptSyncLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptSyncLink {
    pub id: String,
    pub script_revision: String,
    pub media_id: String,
    pub occurrence_lineage: String,
    pub anchor_ids: Vec<String>,
    pub script_from: usize,
    pub script_to: usize,
}

fn short(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.encode_utf16().count() <= limit
}

pub fn validate(project: &Project) -> Result<()> {
    let Some(metadata) = &project.script_assistance else {
        return Ok(());
    };
    ensure!(
        metadata.version == 1,
        "unsupported script assistance version"
    );
    ensure!(
        metadata.scripts.len() <= 100 && metadata.records.len() <= 10000,
        "script assistance size limit"
    );
    let mut scripts = HashMap::new();
    let mut total = 0;
    for script in &metadata.scripts {
        ensure!(
            short(&script.name, 512) && !script.markdown.trim().is_empty(),
            "empty script/name"
        );
        total += script.markdown.len();
        ensure!(
            script.markdown.len() <= 2 * 1024 * 1024 && total <= 40 * 1024 * 1024,
            "script size limit"
        );
        ensure!(
            script.revision == hex::encode(Sha256::digest(script.markdown.as_bytes())),
            "script revision hash mismatch"
        );
        ensure!(
            scripts.insert(&script.revision, script).is_none(),
            "duplicate script revision"
        );
    }
    ensure!(
        scripts.contains_key(&metadata.active_revision),
        "missing active script"
    );
    ensure!(
        metadata.sync_links.len() <= 1000,
        "too many script sync links"
    );
    let mut link_ids = HashSet::new();
    for link in &metadata.sync_links {
        ensure!(
            short(&link.id, 128) && link_ids.insert(&link.id),
            "invalid/duplicate script sync link"
        );
        ensure!(
            short(&link.media_id, 4096) && short(&link.occurrence_lineage, 4096),
            "invalid script sync identity"
        );
        ensure!(
            !link.anchor_ids.is_empty()
                && link.anchor_ids.len() <= 10000
                && link.anchor_ids.iter().all(|id| short(id, 4096))
                && link.anchor_ids.iter().collect::<HashSet<_>>().len() == link.anchor_ids.len(),
            "invalid script sync anchors"
        );
        let script = scripts
            .get(&link.script_revision)
            .ok_or_else(|| anyhow::anyhow!("missing script sync revision"))?;
        let units: Vec<_> = script.markdown.encode_utf16().collect();
        ensure!(
            link.script_from < link.script_to && link.script_to <= units.len(),
            "invalid script sync range"
        );
        ensure!(
            String::from_utf16(&units[link.script_from..link.script_to]).is_ok(),
            "script sync range splits a Unicode character"
        );
    }
    let mut ids = HashSet::new();
    for record in &metadata.records {
        ensure!(
            short(&record.id, 128) && ids.insert(&record.id),
            "duplicate/invalid script record ID"
        );
        let script = scripts
            .get(&record.script_revision)
            .ok_or_else(|| anyhow::anyhow!("missing historical script evidence"))?;
        ensure!(
            short(&record.policy, 4096)
                && short(&record.media_id, 4096)
                && short(&record.occurrence_lineage, 4096),
            "invalid script record identity"
        );
        ensure!(
            !record.anchor_ids.is_empty()
                && record.anchor_ids.len() <= 10000
                && record.anchor_ids.iter().all(|id| short(id, 4096)),
            "invalid script anchors"
        );
        ensure!(
            record.anchor_ids.iter().collect::<HashSet<_>>().len() == record.anchor_ids.len(),
            "duplicate script anchors"
        );
        ensure!(
            record.source_in.is_finite()
                && record.source_in >= 0.0
                && record.source_out.is_finite()
                && record.source_out > record.source_in,
            "invalid script audio range"
        );
        ensure!(
            record.script_to >= record.script_from
                && record.script_to <= script.markdown.encode_utf16().count(),
            "invalid script source range"
        );
        let source_units: Vec<_> = script.markdown.encode_utf16().collect();
        ensure!(
            String::from_utf16(&source_units[record.script_from..record.script_to]).is_ok(),
            "script range splits a Unicode character"
        );
        ensure!(
            [
                &record.before_text,
                &record.after_text,
                &record.context_before,
                &record.context_after
            ]
            .iter()
            .all(|text| text.encode_utf16().count() <= 100000),
            "invalid result text"
        );
        ensure!(
            !record.before_text.trim().is_empty() && short(&record.reason, 4096),
            "empty script evidence"
        );
        ensure!(
            record
                .historical_reason
                .as_ref()
                .map_or(true, |s| short(s, 4096)),
            "invalid historical reason"
        );
        if record.historical_reason.is_none() && !matches!(record.status, ScriptResultStatus::Cut) {
            let anchors: HashSet<_> = project
                .segments
                .iter()
                .filter(|segment| {
                    segment.media_id == record.media_id
                        && crate::filler_review::lineage(segment) == record.occurrence_lineage
                })
                .flat_map(|segment| {
                    segment
                        .words
                        .iter()
                        .filter(|word| {
                            word.end > segment.source_in && word.start < segment.source_out
                        })
                        .map(|word| &word.id)
                })
                .collect();
            ensure!(
                project.media.contains_key(&record.media_id)
                    && record.anchor_ids.iter().all(|id| anchors.contains(id)),
                "active script record refers to removed audio"
            );
        }
        let evidence = &record.evidence;
        ensure!(
            evidence
                .windows
                .as_ref()
                .map_or(true, |windows| !windows.is_empty()
                    && windows.len() <= 2000
                    && windows.iter().all(|window| window.source_in.is_finite()
                        && window.source_in >= 0.0
                        && window.source_out.is_finite()
                        && window.source_out > window.source_in
                        && window.source_out - window.source_in <= 30.0 + 1e-6
                        && window.text.encode_utf16().count() <= 100000)),
            "invalid bounded audio evidence"
        );
        ensure!(
            [&evidence.engine, &evidence.model, &evidence.policy]
                .iter()
                .all(|s| short(s, 4096))
                && evidence.unprompted.encode_utf16().count() <= 100000
                && evidence
                    .prompted
                    .as_ref()
                    .map_or(true, |s| s.encode_utf16().count() <= 100000),
            "invalid acoustic evidence"
        );
        // Historical records intentionally survive removed media/anchors. Active
        // actionability is checked from surviving occurrence mappings, not IDs alone.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fixture() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/script-assistance.json")).unwrap()
    }

    #[test]
    fn shared_typescript_schema_round_trips_without_a_second_transcript() {
        let project = fixture();
        crate::transcript::validate_project(&project).unwrap();
        let expected: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/script-assistance.json"))
                .unwrap();
        assert_eq!(serde_json::to_value(&project).unwrap(), expected);
        let script = &project.script_assistance.as_ref().unwrap().scripts[0];
        let record = &project.script_assistance.as_ref().unwrap().records[0];
        let units: Vec<_> = script.markdown.encode_utf16().collect();
        assert_eq!(
            String::from_utf16(&units[record.script_from..record.script_to]).unwrap(),
            "idempotency"
        );
    }

    #[test]
    fn malformed_script_metadata_is_rejected() {
        let base = serde_json::to_value(fixture()).unwrap();
        for (pointer, replacement) in [
            ("/scriptAssistance/version", json!(2)),
            ("/scriptAssistance/activeRevision", json!("missing")),
            (
                "/scriptAssistance/scripts/0/markdown",
                json!("tampered source"),
            ),
            (
                "/scriptAssistance/records/0/scriptRevision",
                json!("missing"),
            ),
            ("/scriptAssistance/records/0/sourceIn", json!(-1)),
            ("/scriptAssistance/records/0/sourceOut", json!(0)),
            ("/scriptAssistance/records/0/scriptTo", json!(99999)),
            ("/scriptAssistance/records/0/scriptFrom", json!(10)),
            (
                "/scriptAssistance/records/0/anchorIds",
                json!(["missing-audio-anchor"]),
            ),
            ("/scriptAssistance/records/0/anchorIds", json!(["w0", "w0"])),
            ("/scriptAssistance/records/0/evidence/policy", json!("")),
            ("/scriptAssistance/records/0/status", json!("future-status")),
            (
                "/segments/0/transcript/blocks/0/runs/0/provenance/author",
                json!("future-author"),
            ),
        ] {
            let mut value = base.clone();
            *value.pointer_mut(pointer).unwrap() = replacement;
            let result = serde_json::from_value::<Project>(value);
            assert!(
                result.is_err() || crate::transcript::validate_project(&result.unwrap()).is_err(),
                "accepted {pointer}"
            );
        }
    }

    #[tokio::test]
    async fn text_only_suggestions_save_without_claiming_audio_evidence() {
        let bundle =
            std::env::temp_dir().join(format!("script-text-{}.scribe", uuid::Uuid::new_v4()));
        let mut project = fixture();
        let record = project
            .script_assistance
            .as_mut()
            .unwrap()
            .records
            .iter_mut()
            .find(|r| r.id == "pending-example")
            .unwrap();
        record.evidence.engine = "script-text-comparison-v1".into();
        record.evidence.model = "not-used".into();
        record.evidence.policy = "text-only-review-v1".into();
        record.evidence.unprompted.clear();
        record.evidence.windows = None;
        crate::project::save(&project, &bundle).await.unwrap();
        let loaded = crate::project::load(&bundle).await.unwrap();
        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            serde_json::to_value(&project).unwrap()
        );
        let _ = tokio::fs::remove_dir_all(bundle).await;
    }

    #[tokio::test]
    async fn sync_links_survive_save_and_snapshot_and_reject_malformed_ranges() {
        let mut project = fixture();
        let metadata = project.script_assistance.as_mut().unwrap();
        let length = metadata
            .scripts
            .iter()
            .find(|s| s.revision == metadata.active_revision)
            .unwrap()
            .markdown
            .encode_utf16()
            .count();
        metadata.sync_links.push(ScriptSyncLink {
            id: "sync-one".into(),
            script_revision: metadata.active_revision.clone(),
            media_id: "m1".into(),
            occurrence_lineage: "occurrence-1".into(),
            anchor_ids: vec!["w0".into(), "w1".into()],
            script_from: 0,
            script_to: length,
        });
        let bundle =
            std::env::temp_dir().join(format!("script-sync-{}.scribe", uuid::Uuid::new_v4()));
        crate::project::save(&project, &bundle).await.unwrap();
        let loaded = crate::project::load(&bundle).await.unwrap();
        assert_eq!(
            serde_json::to_value(&project).unwrap(),
            serde_json::to_value(&loaded).unwrap()
        );
        let snapshot = crate::snapshots::create(&bundle, &project, "sync links")
            .await
            .unwrap();
        let restored = crate::snapshots::restore(&bundle, &snapshot.id)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&project).unwrap(),
            serde_json::to_value(&restored).unwrap()
        );
        for (field, value) in [
            ("scriptFrom", json!(10)),
            ("scriptTo", json!(length + 1)),
            ("anchorIds", json!(["w0", "w0"])),
            ("scriptRevision", json!("missing")),
        ] {
            let mut invalid = serde_json::to_value(&project).unwrap();
            invalid["scriptAssistance"]["syncLinks"][0][field] = value;
            let parsed = serde_json::from_value::<Project>(invalid);
            assert!(
                parsed.is_err() || validate(&parsed.unwrap()).is_err(),
                "accepted malformed {field}"
            );
        }
        // Removed anchors remain durable so the helper can display a stale link.
        project.script_assistance.as_mut().unwrap().sync_links[0].anchor_ids =
            vec!["removed-word".into()];
        validate(&project).unwrap();
        let _ = tokio::fs::remove_dir_all(bundle).await;
    }

    #[tokio::test]
    async fn save_reopen_and_snapshot_preserve_scripts_authorship_and_history() {
        let bundle =
            std::env::temp_dir().join(format!("script-roundtrip-{}.scribe", uuid::Uuid::new_v4()));
        let project = fixture();
        let expected = serde_json::to_value(&project).unwrap();
        crate::project::save(&project, &bundle).await.unwrap();
        assert_eq!(
            serde_json::to_value(crate::project::load(&bundle).await.unwrap()).unwrap(),
            expected
        );
        let snapshot = crate::snapshots::create(&bundle, &project, "script review")
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(
                crate::snapshots::restore(&bundle, &snapshot.id)
                    .await
                    .unwrap()
            )
            .unwrap(),
            expected
        );
        let mut invalid = project.clone();
        invalid.script_assistance.as_mut().unwrap().version = 2;
        assert!(crate::project::save(&invalid, &bundle).await.is_err());
        assert!(crate::snapshots::create(&bundle, &invalid, "invalid")
            .await
            .is_err());
        assert_eq!(
            serde_json::to_value(crate::project::load(&bundle).await.unwrap()).unwrap(),
            expected
        );
        let external = bundle.join("invalid.json");
        tokio::fs::write(&external, serde_json::to_vec(&invalid).unwrap())
            .await
            .unwrap();
        assert!(crate::project::load(&external).await.is_err());
        let _ = tokio::fs::remove_dir_all(bundle).await;
    }
}
