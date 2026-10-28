//! Transcription engine parsers.
//!
//! The actual binary invocations are in `commands::transcribe`. This module
//! contains pure JSON parsers for whisper.cpp and CrisperWhisper output.
//!
//! WhisperKit was removed in v3.2.0 — restore from commit 4726d25 if needed.
//!
//! `parse_whisper_json` is exposed as a pure function so it can be unit-tested
//! without spawning any binary.

use crate::edl::Word;
use anyhow::{Context, Result};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct CrisperWord {
    text: String,
    start: f64,
    end: f64,
}

/// Parse the bridge's word-level result without treating `[UM]` and `[UH]`
/// as metadata. Those are spoken filler tokens in CrisperWhisper's output.
pub fn parse_crisper_words(json: &str) -> Result<Vec<Word>> {
    let parsed: Vec<CrisperWord> = serde_json::from_str(json).context("invalid CrisperWhisper JSON")?;
    parsed
        .into_iter()
        .map(|word| {
            if word.text.trim().is_empty()
                || !word.start.is_finite()
                || !word.end.is_finite()
                || word.start < 0.0
                || word.end <= word.start
            {
                anyhow::bail!("invalid CrisperWhisper word or timestamp");
            }
            Ok(Word {
                id: Uuid::new_v4().to_string(),
                text: word.text,
                start: word.start,
                end: word.end,
                confidence: 1.0, // The API does not provide calibrated per-word confidence.
                speaker: None,
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct WhisperJson {
    transcription: Vec<WhisperSegment>,
}

#[derive(Debug, Deserialize)]
struct WhisperSegment {
    #[allow(dead_code)]
    text: String,
    offsets: WhisperOffsets,
    tokens: Vec<WhisperToken>,
}

#[derive(Debug, Deserialize)]
struct WhisperOffsets {
    from: u64,
    #[allow(dead_code)]
    to: u64,
}

#[derive(Debug, Deserialize)]
struct WhisperToken {
    text: String,
    offsets: WhisperOffsets,
    p: f64, // probability
}

/// Assemble spoken words from Whisper's subword tokens. Leading whitespace
/// starts a word; continuation tokens and standalone punctuation belong to
/// the preceding word. Punctuation has no extra audio range of its own.
pub fn parse_whisper_json(json: &str) -> Result<Vec<Word>> {
    let parsed: WhisperJson = serde_json::from_str(json).context("invalid whisper JSON")?;
    let mut words: Vec<Word> = Vec::new();
    for seg in parsed.transcription {
        let mut segment_has_word = false;
        let mut pending_prefix = String::new();
        for tok in seg.tokens {
            let text = tok.text.trim();
            // Skip Whisper special tokens like <|startoftranscript|>, [BLANK_AUDIO], etc.
            if text.is_empty() || text.starts_with("<|") || text.starts_with('[') {
                continue;
            }
            // Whisper often emits sentence punctuation as separate tokens.
            if text.chars().all(|c| !c.is_alphanumeric()) {
                if let Some(previous) = words.last_mut() {
                    previous.text.push_str(text);
                } else {
                    pending_prefix.push_str(text);
                }
                continue;
            }
            let (start_ms, end_ms) = token_offsets_ms(&seg.offsets, &tok.offsets);
            let starts_word = !segment_has_word
                || tok.text.chars().next().is_some_and(char::is_whitespace);
            if starts_word {
                words.push(Word {
                    id: Uuid::new_v4().to_string(),
                    text: format!("{pending_prefix}{text}"),
                    start: ms_to_sec(start_ms),
                    end: ms_to_sec(end_ms),
                    confidence: tok.p.clamp(0.0, 1.0),
                    speaker: None,
                });
                pending_prefix.clear();
            } else if let Some(previous) = words.last_mut() {
                previous.text.push_str(text);
                previous.end = previous.end.max(ms_to_sec(end_ms));
                previous.confidence = previous.confidence.min(tok.p.clamp(0.0, 1.0));
            }
            segment_has_word = true;
        }
    }
    Ok(words)
}

fn token_offsets_ms(seg: &WhisperOffsets, tok: &WhisperOffsets) -> (u64, u64) {
    // whisper.cpp `--output-json-full` (post-~1.5.0) emits token t0/t1 as
    // *absolute* millisecond offsets in the source audio timeline.
    //
    // Some older/alternative builds emit token offsets *relative* to the
    // segment start instead. We distinguish the two forms by checking whether
    // the token range is plausibly contained within the segment range:
    //
    //   absolute  → tok.from ∈ [seg.from, seg.to]  (or at least tok.from >= seg.from)
    //   relative  → tok.from is small (< seg.from), add seg.from to both
    //
    // Edge case: when seg.from == 0 both interpretations look identical.
    // In that case we trust the token offsets directly (absolute), because
    // the segment-relative form would produce the same values anyway.
    //
    // We also guard against tokens whose `to` accidentally undershoots `from`
    // (corrupted JSON): clamp `to` to at least `from + 1 ms` so the editor
    // never shows a zero-duration word.
    let (start, end) = if seg.from == 0 || tok.from >= seg.from {
        // Absolute offsets — use directly.
        (tok.from, tok.to)
    } else {
        // Relative offsets — add segment start.
        (seg.from + tok.from, seg.from + tok.to)
    };

    // Safety clamp: ensure end > start (a zero-width word causes visual glitches).
    let end = end.max(start + 1);
    (start, end)
}

fn ms_to_sec(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crisper_words_preserve_fillers_repeats_and_punctuation() {
        let words = parse_crisper_words(r#"[{"text":"[UM]","start":1.16,"end":1.28},{"text":"requests","start":8.24,"end":8.48},{"text":"requests","start":9.36,"end":9.85},{"text":"REST,","start":20.4,"end":20.66}]"#).unwrap();
        assert_eq!(words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            vec!["[UM]", "requests", "requests", "REST,"]);
        assert_eq!(words[2].start, 9.36);
        assert_eq!(words[3].end, 20.66);
        assert!(parse_crisper_words(r#"[{"text":"bad","start":2,"end":1}]"#).is_err());
    }

    #[test]
    fn parses_minimal_whisper_output() {
        // whisper.cpp emits `offsets.from`/`offsets.to` in milliseconds.
        // This fixture matches older wrappers where token offsets are relative
        // to the segment start.
        let json = r#"{
            "transcription": [
              {
                "text": " hello world",
                "offsets": {"from": 0, "to": 1500},
                "tokens": [
                  {"text": " hello", "offsets": {"from": 0, "to": 500}, "p": 0.99},
                  {"text": " world", "offsets": {"from": 600, "to": 1100}, "p": 0.95}
                ]
              }
            ]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "hello");
        assert!((words[0].start - 0.0).abs() < 1e-9);
        assert!((words[0].end - 0.5).abs() < 1e-9);
        assert_eq!(words[1].text, "world");
        assert!((words[1].start - 0.6).abs() < 1e-9);
        assert!((words[1].confidence - 0.95).abs() < 1e-9);
    }

    #[test]
    fn parses_absolute_token_offsets_without_doubling_segment_start() {
        // Current whisper.cpp writes token offsets from token.t0/t1, which are
        // already absolute in the source audio timeline.
        let json = r#"{
            "transcription": [
              {
                "text": " later words",
                "offsets": {"from": 30000, "to": 32000},
                "tokens": [
                  {"text": " later", "offsets": {"from": 30100, "to": 30500}, "p": 0.99},
                  {"text": " words", "offsets": {"from": 30600, "to": 31100}, "p": 0.95}
                ]
              }
            ]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "later");
        assert!((words[0].start - 30.1).abs() < 1e-9);
        assert!((words[0].end - 30.5).abs() < 1e-9);
        assert_eq!(words[1].text, "words");
        assert!((words[1].start - 30.6).abs() < 1e-9);
    }

    #[test]
    fn keeps_sentence_punctuation_but_drops_special_tokens() {
        let json = r#"{
            "transcription": [
              {
                "text": "[MUSIC] hi.",
                "offsets": {"from": 0, "to": 1000},
                "tokens": [
                  {"text": "<|startoftranscript|>", "offsets":{"from":0,"to":0}, "p":1.0},
                  {"text": "[MUSIC]", "offsets":{"from":0,"to":100}, "p":1.0},
                  {"text": " hi", "offsets":{"from":100,"to":500}, "p":0.9},
                  {"text": ".", "offsets":{"from":500,"to":600}, "p":1.0}
                ]
              }
            ]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "hi.");
        assert!((words[0].end - 0.5).abs() < 1e-9);
    }

    #[test]
    fn joins_subwords_contractions_and_punctuation_from_real_whisper_shape() {
        let json = r#"{
            "transcription": [{
                "text": " REST, we've used SeatNum. Is that required?",
                "offsets": {"from": 20000, "to": 25500},
                "tokens": [
                    {"text":" R","offsets":{"from":20040,"to":20170},"p":0.87},
                    {"text":"EST","offsets":{"from":20170,"to":20560},"p":0.99},
                    {"text":",","offsets":{"from":20560,"to":20660},"p":0.67},
                    {"text":" we","offsets":{"from":20660,"to":21000},"p":0.95},
                    {"text":"'ve","offsets":{"from":21000,"to":21200},"p":0.91},
                    {"text":" used","offsets":{"from":21200,"to":21600},"p":0.99},
                    {"text":" Se","offsets":{"from":21600,"to":21900},"p":0.86},
                    {"text":"at","offsets":{"from":21900,"to":22200},"p":0.93},
                    {"text":"N","offsets":{"from":22200,"to":22300},"p":0.97},
                    {"text":"um","offsets":{"from":22300,"to":22700},"p":0.99},
                    {"text":".","offsets":{"from":22700,"to":23000},"p":0.99},
                    {"text":" Is","offsets":{"from":23000,"to":23400},"p":0.96},
                    {"text":" that","offsets":{"from":23400,"to":24000},"p":0.97},
                    {"text":" required","offsets":{"from":24000,"to":25000},"p":0.91},
                    {"text":"?","offsets":{"from":25000,"to":25500},"p":0.99}
                ]
            }]
        }"#;
        let words = parse_whisper_json(json).unwrap();
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["REST,", "we've", "used", "SeatNum.", "Is", "that", "required?"]
        );
        assert!((words[0].start - 20.04).abs() < 1e-9);
        assert!((words[0].end - 20.56).abs() < 1e-9);
        assert!((words[3].end - 22.7).abs() < 1e-9);
        assert!((words[6].end - 25.0).abs() < 1e-9);
    }
}
