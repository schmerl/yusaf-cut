//! Additive review metadata. Native persistence checks references; frontend
//! projection additionally checks exact wording/rule fingerprints before use.
use crate::edl::Project;
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FillerPolicy {
    pub optional: Vec<String>,
    pub custom: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FillerOutcome {
    Kept,
    TextRemoved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FillerDecision {
    pub candidate_id: String,
    pub fingerprint: String,
    pub media_id: String,
    pub occurrence_lineage: String,
    pub anchor_ids: Vec<String>,
    pub outcome: FillerOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FillerReviewMetadata {
    pub version: u32,
    pub policy: FillerPolicy,
    pub decisions: Vec<FillerDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FillerAudio {
    pub candidate_id: String,
    pub rule: String,
    pub text: String,
    pub originals: Vec<crate::edl::Word>,
}

pub fn lineage(segment: &crate::edl::Segment) -> String {
    segment.occurrence_lineage.clone().unwrap_or_else(|| {
        segment
            .transcript
            .as_ref()
            .map(|t| t.occurrence_id.clone())
            .unwrap_or_else(|| format!("transcript:{}", segment.id))
    })
}

pub fn validate(project: &Project) -> Result<()> {
    let mut edges: HashMap<String, (serde_json::Value, Vec<(f64, f64)>)> = HashMap::new();
    let mut occurrences: HashMap<String, Vec<&crate::edl::Segment>> = HashMap::new();
    for segment in &project.segments {
        if let Some(audio) = &segment.filler_audio {
            ensure!(
                segment.precise == Some(true)
                    && segment.occurrence_lineage.is_some()
                    && project.media.contains_key(&segment.media_id)
                    && segment.words.is_empty()
                    && segment.transcript.is_none(),
                "invalid filler audio fragment"
            );
            ensure!(
                !audio.candidate_id.is_empty()
                    && !audio.rule.is_empty()
                    && !audio.text.is_empty()
                    && !audio.originals.is_empty(),
                "invalid filler audio provenance"
            );
            let originals = serde_json::to_value(&audio.originals)?;
            let previous = edges
                .entry(audio.candidate_id.clone())
                .or_insert_with(|| (originals.clone(), Vec::new()));
            ensure!(
                previous.0 == originals
                    && !previous
                        .1
                        .iter()
                        .any(|(from, to)| *from < segment.source_out && *to > segment.source_in),
                "ambiguous/duplicated retained filler edges"
            );
            previous.1.push((segment.source_in, segment.source_out));
            let mut start = f64::INFINITY;
            let mut end = f64::NEG_INFINITY;
            for word in &audio.originals {
                ensure!(
                    !word.id.is_empty()
                        && word.start >= 0.0
                        && word.start.is_finite()
                        && word.end.is_finite()
                        && word.end > word.start
                        && word.confidence.is_finite()
                        && (0.0..=1.0).contains(&word.confidence),
                    "invalid filler audio anchor"
                );
                start = start.min(word.start);
                end = end.max(word.end);
            }
            ensure!(
                segment.source_in >= start && segment.source_out <= end,
                "filler audio outside recognition range"
            );
        }
        let id = lineage(segment);
        if let Some(audio) = &segment.filler_audio {
            let identity: serde_json::Value = serde_json::from_str(&audio.candidate_id)?;
            let anchors: Vec<_> = audio.originals.iter().map(|w| &w.id).collect();
            ensure!(
                identity
                    == serde_json::json!([
                        project.id,
                        segment.media_id,
                        id,
                        anchors,
                        audio.rule,
                        0
                    ]),
                "filler audio belongs to another occurrence"
            );
        }
        ensure!(
            !id.trim().is_empty() && id.encode_utf16().count() <= 1000,
            "invalid occurrence lineage"
        );
        if segment.occurrence_lineage.is_some() {
            ensure!(
                segment.source_in.is_finite()
                    && segment.source_out.is_finite()
                    && segment.source_in >= 0.0
                    && segment.source_out > segment.source_in,
                "invalid occurrence source interval"
            );
        }
        let previous = occurrences.entry(id).or_default();
        for other in previous.iter() {
            ensure!(
                other.media_id == segment.media_id,
                "lineage crosses source media"
            );
            ensure!(
                !segment
                    .words
                    .iter()
                    .any(|w| other.words.iter().any(|a| a.id == w.id)),
                "ambiguous occurrence anchors"
            );
        }
        previous.push(segment);
    }
    let Some(review) = &project.filler_review else {
        return Ok(());
    };
    ensure!(
        review.version == 1 && review.decisions.len() <= 100000,
        "invalid filler metadata version/size"
    );
    const OPTIONAL: &[&str] = &[
        "mm",
        "mhm",
        "like",
        "so",
        "right",
        "okay",
        "basically",
        "actually",
        "you know",
        "i mean",
        "sort of",
        "kind of",
        "literally",
        "honestly",
        "ok",
        "well",
        "anyway",
        "i guess",
        "you see",
    ];
    for terms in [&review.policy.optional, &review.policy.custom] {
        ensure!(terms.len() <= 100, "too many filler terms");
        let mut seen = HashSet::new();
        for term in terms {
            ensure!(
                !term.trim().is_empty()
                    && term.encode_utf16().count() <= 200
                    && term == &term.trim().to_lowercase()
                    && seen.insert(term),
                "invalid filler term"
            );
        }
    }
    ensure!(
        review
            .policy
            .optional
            .iter()
            .all(|t| OPTIONAL.contains(&t.as_str())),
        "unknown optional filler term"
    );
    let mut decisions = HashSet::new();
    for decision in &review.decisions {
        ensure!(
            !decision.candidate_id.is_empty()
                && !decision.fingerprint.is_empty()
                && decisions.insert(&decision.candidate_id),
            "invalid/duplicate filler decision"
        );
        ensure!(
            !decision.anchor_ids.is_empty(),
            "unanchored filler decision"
        );
        let segments = occurrences.get(&decision.occurrence_lineage);
        ensure!(
            segments.is_some_and(|segments| segments.iter().any(|s| {
                if s.media_id != decision.media_id {
                    return false;
                }
                let ids: Vec<_> = s.words.iter().map(|w| &w.id).collect();
                ids.windows(decision.anchor_ids.len())
                    .any(|window| window.iter().copied().eq(decision.anchor_ids.iter()))
            })),
            "unknown filler occurrence/anchors"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Project {
        serde_json::from_str(include_str!("../../tests/fixtures/filler-review.json")).unwrap()
    }

    #[tokio::test]
    async fn native_save_reopen_and_snapshot_preserve_review_metadata() {
        for project in [
            fixture(),
            serde_json::from_str(include_str!(
                "../../tests/fixtures/filler-retained-edges.json"
            ))
            .unwrap(),
        ] {
            crate::transcript::validate_project(&project).unwrap();
            let expected = serde_json::to_value(&project).unwrap();
            let bundle =
                std::env::temp_dir().join(format!("filler-{}.scribe", uuid::Uuid::new_v4()));
            crate::project::save(&project, &bundle).await.unwrap();
            let loaded = crate::project::load(&bundle).await.unwrap();
            assert_eq!(serde_json::to_value(loaded).unwrap(), expected);
            let snapshot = crate::snapshots::create(&bundle, &project, "reviewed")
                .await
                .unwrap();
            let restored = crate::snapshots::restore(&bundle, &snapshot.id)
                .await
                .unwrap();
            assert_eq!(serde_json::to_value(restored).unwrap(), expected);
            tokio::fs::remove_dir_all(bundle).await.unwrap();
        }
    }

    #[test]
    fn malformed_audio_edges_are_rejected() {
        let value: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/filler-retained-edges.json"
        ))
        .unwrap();
        for (path, invalid) in [
            ("/segments/1/precise", json!(false)),
            ("/segments/1/sourceIn", json!(-1)),
            ("/segments/1/fillerAudio/candidateId", json!("[]")),
            ("/segments/1/fillerAudio/originals/0/end", json!(-1)),
        ] {
            let mut data = value.clone();
            *data.pointer_mut(path).unwrap() = invalid;
            let project: Project = serde_json::from_value(data).unwrap();
            assert!(
                crate::transcript::validate_project(&project).is_err(),
                "accepted {path}"
            );
        }
    }

    #[test]
    fn malformed_metadata_cannot_be_persisted() {
        let value = serde_json::to_value(fixture()).unwrap();
        for (path, invalid) in [
            ("/fillerReview/version", json!(2)),
            ("/fillerReview/policy/optional", json!(["unknown"])),
            ("/fillerReview/decisions/0/anchorIds", json!(["missing"])),
            ("/fillerReview/decisions/0/mediaId", json!("missing")),
            (
                "/fillerReview/decisions/0/occurrenceLineage",
                json!("missing"),
            ),
            ("/segments/1/occurrenceLineage", json!("recording-1")),
        ] {
            let mut data = value.clone();
            *data.pointer_mut(path).unwrap() = invalid;
            let project: Project = serde_json::from_value(data).unwrap();
            assert!(
                crate::transcript::validate_project(&project).is_err(),
                "accepted {path}"
            );
        }
        let mut data = value;
        data["fillerReview"]["decisions"][0]["outcome"] = json!("cut-everything");
        assert!(serde_json::from_value::<Project>(data).is_err());
    }
}
