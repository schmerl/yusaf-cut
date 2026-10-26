//! Occurrence-scoped text overlays. Source words and EDL ranges remain authoritative.
use crate::edl::{Project, Segment, Word};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptMetadata {
    pub version: u32,
    pub occurrence_id: String,
    pub originals: Vec<Word>,
    pub blocks: Vec<TranscriptBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TranscriptBlock {
    pub id: String,
    pub runs: Vec<TranscriptRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptRun {
    pub id: String,
    pub text: String,
    pub separator_before: String,
    pub anchor_ids: Vec<String>,
}

fn nonempty(value: &str) -> bool {
    !value.trim().is_empty()
}

fn validate_segment(segment: &Segment, metadata: &TranscriptMetadata) -> Result<()> {
    ensure!(
        metadata.version == 1,
        "unsupported transcript metadata version"
    );
    ensure!(nonempty(&metadata.occurrence_id), "empty occurrence ID");
    ensure!(
        segment.source_in.is_finite()
            && segment.source_in >= 0.0
            && segment.source_out.is_finite()
            && segment.source_out > segment.source_in,
        "invalid transcript segment range"
    );
    let words: Vec<_> = segment
        .words
        .iter()
        .filter(|w| w.end > segment.source_in && w.start < segment.source_out)
        .collect();
    ensure!(
        words.len() == metadata.originals.len(),
        "transcript anchor coverage mismatch"
    );
    let mut anchor_ids = HashSet::new();
    for (i, (word, current)) in metadata.originals.iter().zip(words).enumerate() {
        ensure!(
            nonempty(&word.id) && anchor_ids.insert(&word.id),
            "duplicate/empty anchor ID"
        );
        ensure!(
            word.start.is_finite()
                && word.end.is_finite()
                && word.start >= 0.0
                && word.end > word.start
                && word.confidence.is_finite()
                && (0.0..=1.0).contains(&word.confidence),
            "invalid original anchor"
        );
        ensure!(
            word.id == current.id && word.start == current.start && word.end == current.end,
            "original anchors differ from surviving audio"
        );
        if i > 0 {
            ensure!(
                word.start >= metadata.originals[i - 1].start,
                "unordered anchors"
            );
        }
    }
    let mut ids = HashSet::new();
    let mut cursor = 0;
    for block in &metadata.blocks {
        ensure!(
            nonempty(&block.id) && ids.insert(&block.id),
            "duplicate/empty block ID"
        );
        ensure!(!block.runs.is_empty(), "empty transcript block");
        let mut has_text = false;
        for run in &block.runs {
            ensure!(
                nonempty(&run.id) && ids.insert(&run.id),
                "duplicate/empty run ID"
            );
            ensure!(
                run.separator_before.chars().all(char::is_whitespace),
                "invalid run spacing"
            );
            ensure!(!run.anchor_ids.is_empty(), "unanchored run");
            for id in &run.anchor_ids {
                ensure!(
                    metadata.originals.get(cursor).map(|w| &w.id) == Some(id),
                    "unknown, repeated, or unordered anchor reference"
                );
                cursor += 1;
            }
            has_text |= nonempty(&run.text);
        }
        ensure!(has_text, "empty spoken paragraph");
    }
    ensure!(
        cursor == metadata.originals.len(),
        "unmapped transcript anchors"
    );
    Ok(())
}

/// Validate before persistence or restoration, without mutating legacy data.
pub fn validate_project(project: &Project) -> Result<()> {
    ensure!(project.version == 1, "unsupported project version");
    let mut occurrences = HashSet::new();
    let mut segments = HashSet::new();
    for segment in &project.segments {
        ensure!(
            nonempty(&segment.id) && segments.insert(&segment.id),
            "duplicate/empty segment ID"
        );
        if let Some(metadata) = &segment.transcript {
            ensure!(
                project.media.contains_key(&segment.media_id),
                "unknown transcript source media"
            );
            validate_segment(segment, metadata)?;
            ensure!(
                occurrences.insert(&metadata.occurrence_id),
                "duplicate occurrence ID"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn fixture() -> Project {
        serde_json::from_str(include_str!(
            "../../tests/fixtures/transcript-corrections.json"
        ))
        .unwrap()
    }

    #[test]
    fn additive_metadata_and_legacy_segments_round_trip() {
        let project = fixture();
        validate_project(&project).unwrap();
        let value = serde_json::to_value(&project).unwrap();
        let roundtrip: Project = serde_json::from_value(value.clone()).unwrap();
        validate_project(&roundtrip).unwrap();
        assert_eq!(serde_json::to_value(roundtrip).unwrap(), value);
        assert!(project.segments[1].transcript.is_none());
        assert!(value["segments"][1].get("transcript").is_none());
        assert_eq!(
            value["segments"][0]["transcript"]["blocks"][0]["runs"][3]["text"],
            ""
        );
    }

    #[test]
    fn malformed_metadata_is_rejected() {
        let base = serde_json::to_value(fixture()).unwrap();
        let cases: Vec<(&str, Value)> = vec![
            ("/version", json!(2)),
            ("/segments/0/transcript/version", json!(2)),
            ("/segments/0/transcript/occurrenceId", json!("")),
            ("/segments/0/transcript/originals/0/start", json!(-1)),
            (
                "/segments/0/transcript/blocks/0/runs/0/anchorIds/0",
                json!("missing"),
            ),
            ("/segments/0/transcript/blocks/0/runs/1/id", json!("r1")),
            (
                "/segments/0/transcript/blocks/0/runs/0/anchorIds",
                json!([]),
            ),
        ];
        for (path, value) in cases {
            let mut data = base.clone();
            *data.pointer_mut(path).unwrap() = value;
            let project: Project = serde_json::from_value(data).unwrap();
            assert!(validate_project(&project).is_err(), "accepted {path}");
        }
        let mut project = fixture();
        for run in &mut project.segments[0].transcript.as_mut().unwrap().blocks[0].runs {
            run.text = " ".into();
        }
        assert!(validate_project(&project).is_err());
        let mut project = fixture();
        project.segments[1].transcript = project.segments[0].transcript.clone();
        assert!(validate_project(&project).is_err());
    }

    #[tokio::test]
    async fn native_save_load_and_snapshot_preserve_overlay() {
        let bundle = std::env::temp_dir().join(format!(
            "correction-roundtrip-{}.scribe",
            uuid::Uuid::new_v4()
        ));
        let project = fixture();
        let expected = serde_json::to_value(&project).unwrap();
        crate::project::save(&project, &bundle).await.unwrap();
        let saved = crate::project::load(&bundle).await.unwrap();
        assert_eq!(serde_json::to_value(saved).unwrap(), expected);
        let snapshot = crate::snapshots::create(&bundle, &project, "corrected")
            .await
            .unwrap();
        let restored = crate::snapshots::restore(&bundle, &snapshot.id)
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), expected);

        let mut invalid = fixture();
        invalid.segments[0].transcript.as_mut().unwrap().version = 2;
        assert!(crate::project::save(&invalid, &bundle).await.is_err());
        assert!(crate::snapshots::create(&bundle, &invalid, "invalid")
            .await
            .is_err());
        assert_eq!(
            serde_json::to_value(crate::project::load(&bundle).await.unwrap()).unwrap(),
            expected
        );
        // A malformed external file is rejected on load as well as on write.
        let bad_file = bundle.join("invalid.json");
        tokio::fs::write(&bad_file, serde_json::to_vec(&invalid).unwrap())
            .await
            .unwrap();
        assert!(crate::project::load(&bad_file).await.is_err());
        // Restoration must also reject invalid metadata in an external snapshot.
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder
            .write_all(&serde_json::to_vec(&invalid).unwrap())
            .unwrap();
        let mut entries = tokio::fs::read_dir(bundle.join("snapshots")).await.unwrap();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            if entry.file_name().to_string_lossy().ends_with(".json.gz") {
                tokio::fs::write(entry.path(), encoder.finish().unwrap())
                    .await
                    .unwrap();
                break;
            }
        }
        assert!(crate::snapshots::restore(&bundle, &snapshot.id)
            .await
            .is_err());
        tokio::fs::remove_dir_all(bundle).await.unwrap();
    }
}
