//! Local, bounded acoustic estimates. Word/EDL boundaries are hard limits;
//! energy is evidence for an editable proposal, never a semantic filler classifier.
use crate::edl::Project;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const RATE: usize = 16000;
const FRAME: usize = 160; // 10ms analysis windows, 5ms hop
const HOP: usize = 80;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryEstimate {
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub reason: String,
    pub limited_by_neighbor: bool,
}
impl BoundaryEstimate {
    fn uncertain(reason: &str) -> Self {
        Self {
            start: None,
            end: None,
            reason: reason.into(),
            limited_by_neighbor: false,
        }
    }
}
struct Bounds {
    start: f64,
    end: f64,
    earliest: f64,
    latest: f64,
    window_start: f64,
    window_end: f64,
    previous: bool,
    following: bool,
}
fn bounds(
    project: &Project,
    segment_id: &str,
    anchor_ids: &[String],
) -> Result<(String, Bounds), String> {
    crate::transcript::validate_project(project).map_err(|e| e.to_string())?;
    let segment = project
        .segments
        .iter()
        .find(|s| s.id == segment_id)
        .ok_or("Occurrence changed")?;
    if anchor_ids.is_empty() || segment.filler_audio.is_some() {
        return Err("No isolated recognized occurrence".into());
    }
    let first = segment
        .words
        .iter()
        .position(|w| w.id == anchor_ids[0])
        .ok_or("Occurrence changed")?;
    let end = first
        .checked_add(anchor_ids.len())
        .ok_or("Invalid anchors")?;
    let selected = segment.words.get(first..end).ok_or("Occurrence changed")?;
    if !selected.iter().map(|w| &w.id).eq(anchor_ids.iter()) {
        return Err("Occurrence is interrupted by other speech".into());
    }
    let start = selected
        .iter()
        .map(|w| w.start)
        .fold(f64::INFINITY, f64::min);
    let finish = selected
        .iter()
        .map(|w| w.end)
        .fold(f64::NEG_INFINITY, f64::max);
    let earliest = segment.words[..first]
        .iter()
        .map(|w| w.end)
        .fold(segment.source_in, f64::max);
    let latest = segment.words[end..]
        .iter()
        .map(|w| w.start)
        .fold(segment.source_out, f64::min);
    if !start.is_finite()
        || !finish.is_finite()
        || finish <= start
        || earliest >= latest
        || finish <= earliest
        || start >= latest
    {
        return Err("Word timings leave no isolated audio interval. Adjust the transcript timing group manually.".into());
    }
    let window_start = earliest.max(start - 1.0);
    let window_end = latest.min(finish + 1.0);
    if window_end <= window_start || window_end - window_start > 10.0 {
        return Err("Audio interval is too long to estimate. Adjust manually.".into());
    }
    let path = project
        .media
        .get(&segment.media_id)
        .ok_or("Missing source media")?
        .path
        .clone();
    Ok((
        path,
        Bounds {
            start,
            end: finish,
            earliest,
            latest,
            window_start,
            window_end,
            previous: first > 0,
            following: end < segment.words.len(),
        },
    ))
}

fn analyze(samples: &[f32], bounds: &Bounds) -> BoundaryEstimate {
    let energy: Vec<f64> = samples
        .windows(FRAME)
        .step_by(HOP)
        .map(|frame| {
            let mean = frame.iter().map(|v| *v as f64).sum::<f64>() / FRAME as f64;
            (frame
                .iter()
                .map(|v| (*v as f64 - mean).powi(2))
                .sum::<f64>()
                / FRAME as f64)
                .sqrt()
        })
        .collect();
    if energy.len() < 3 || energy.iter().any(|v| !v.is_finite()) {
        return BoundaryEstimate::uncertain("Not enough usable audio to estimate boundaries.");
    }
    let mut sorted = energy.clone();
    sorted.sort_by(f64::total_cmp);
    let noise = sorted[sorted.len() / 5];
    let signal = sorted[(sorted.len() * 95 / 100).min(sorted.len() - 1)];
    if signal < 0.0005 || signal < noise * 2.5 {
        return BoundaryEstimate::uncertain("No clear speech/background contrast inside the neighboring-word interval. Adjust manually and preview.");
    }
    let threshold = (noise * 3.0).max(signal * 0.12).max(0.00001);
    // Close only brief energy dips inside a burst, not actual pauses.
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (i, value) in energy.iter().enumerate() {
        if *value < threshold {
            continue;
        }
        if let Some(last) = runs.last_mut() {
            if i - last.1 <= 5 {
                last.1 = i;
                continue;
            }
        }
        runs.push((i, i));
    }
    let spans: Vec<_> = runs
        .iter()
        .map(|(first, last)| {
            (
                bounds.window_start + (*first * HOP) as f64 / RATE as f64,
                bounds.window_start + (*last * HOP + FRAME) as f64 / RATE as f64,
            )
        })
        .collect();
    let overlapping: Vec<_> = spans
        .iter()
        .filter(|(from, to)| *from < bounds.end && *to > bounds.start)
        .copied()
        .collect();
    let selected = if !overlapping.is_empty() {
        (overlapping[0].0, overlapping.last().unwrap().1)
    } else {
        let mut nearby: Vec<_> = spans
            .iter()
            .map(|(from, to)| {
                (
                    (bounds.start - to).max(from - bounds.end).max(0.0),
                    (*from, *to),
                )
            })
            .collect();
        nearby.sort_by(|a, b| a.0.total_cmp(&b.0));
        if nearby.is_empty()
            || nearby[0].0 > 0.04
            || (nearby.len() > 1 && nearby[1].0 - nearby[0].0 < 0.01)
        {
            return BoundaryEstimate::uncertain("No unambiguous audio burst near the recognized filler. Adjust manually and preview.");
        }
        nearby[0].1
    };
    if (selected.0 <= bounds.window_start + 0.005 && bounds.window_start > bounds.earliest + 0.01)
        || (selected.1 >= bounds.window_end - 0.005 && bounds.window_end < bounds.latest - 0.01)
    {
        return BoundaryEstimate::uncertain(
            "Audio continues beyond the local search window. Adjust manually and preview.",
        );
    }
    // Protect neighboring word edges, including hidden words. Never shrink a
    // usable recognition interval merely to insert a safety margin.
    let left = bounds.earliest
        + if bounds.previous {
            ((bounds.start - bounds.earliest) / 2.0).clamp(0.0, 0.01)
        } else {
            0.0
        };
    let right = bounds.latest
        - if bounds.following {
            ((bounds.latest - bounds.end) / 2.0).clamp(0.0, 0.01)
        } else {
            0.0
        };
    let start = (selected.0 - 0.02).min(bounds.start).max(left);
    let end = (selected.1 + 0.02).max(bounds.end).min(right);
    if end <= start {
        return BoundaryEstimate::uncertain(
            "Neighboring word timings leave no usable cut interval.",
        );
    }
    let limited = selected.0 - 0.02 < left || selected.1 + 0.02 > right;
    BoundaryEstimate {
        start: Some(start),
        end: Some(end),
        limited_by_neighbor: limited,
        reason: if limited {
            "Audio estimate reaches a neighboring-word limit. Preview carefully before cutting."
        } else {
            "Audio-informed estimate. Preview before cutting."
        }
        .into(),
    }
}

#[tauri::command]
pub async fn estimate_filler_boundaries(
    app: AppHandle,
    project: Project,
    segment_id: String,
    anchor_ids: Vec<String>,
) -> Result<BoundaryEstimate, String> {
    let (path, bounds) = bounds(&project, &segment_id, &anchor_ids)?;
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args([
            "-v",
            "error",
            "-ss",
            &bounds.window_start.to_string(),
            "-i",
            &path,
            "-t",
            &(bounds.window_end - bounds.window_start).to_string(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "f32le",
            "pipe:1",
        ])
        .set_raw_out(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let mut success = false;
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(20));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => { let _ = child.kill(); return Err("Boundary estimation timed out. Adjust manually.".into()); }
            event = rx.recv() => match event {
                Some(CommandEvent::Stdout(data)) => {
                    bytes.extend(data);
                    if bytes.len() > RATE * 10 * 4 { let _ = child.kill(); return Err("Boundary analysis exceeded its local window.".into()); }
                }
                Some(CommandEvent::Terminated(exit)) => success = exit.code == Some(0),
                Some(CommandEvent::Error(error)) => { let _ = child.kill(); return Err(error); },
                None => break,
                _ => {}
            }
        }
    }
    if !success {
        return Err("Could not read audio for boundary estimation. Adjust manually.".into());
    }
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    Ok(analyze(&samples, &bounds))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window() -> Bounds {
        Bounds {
            start: 11.48,
            end: 11.50,
            earliest: 10.52,
            latest: 11.62,
            window_start: 10.52,
            window_end: 11.62,
            previous: true,
            following: true,
        }
    }
    fn samples(bursts: &[(f64, f64)]) -> Vec<f32> {
        (0..17600)
            .map(|i| {
                let time = 10.52 + i as f64 / RATE as f64;
                let amplitude = if bursts.iter().any(|(a, b)| time >= *a && time < *b) {
                    0.08
                } else {
                    0.001
                };
                (amplitude * (2.0 * std::f64::consts::PI * 137.0 * time).sin()) as f32
            })
            .collect()
    }
    #[test]
    fn expands_peak_only_timing_to_local_burst_with_neighbor_limit() {
        let result = analyze(&samples(&[(10.52, 10.78), (11.44, 11.62)]), &window());
        assert!((result.start.unwrap() - 11.42).abs() < 0.02);
        assert!((result.end.unwrap() - 11.61).abs() < 1e-8);
        assert!(result.limited_by_neighbor);
    }
    #[test]
    fn ignores_distant_bursts_and_rejects_quiet_or_ambiguous_audio() {
        assert!(analyze(&samples(&[]), &window()).start.is_none());
        assert!(
            analyze(&samples(&[(11.42, 11.455), (11.525, 11.56)]), &window())
                .start
                .is_none()
        );
        assert!(analyze(&samples(&[(10.52, 11.62)]), &window())
            .start
            .is_none());
        assert!(analyze(&samples(&[(10.52, 10.75)]), &window())
            .start
            .is_none());
        assert!(analyze(&vec![0.0; 17600], &window()).start.is_none());
    }
    #[test]
    fn word_bounds_use_all_anchors_and_existing_cut_limits() {
        let mut p: Project = serde_json::from_str(include_str!(
            "../../../tests/fixtures/transcript-corrections.json"
        ))
        .unwrap();
        p.segments[0].source_in = 0.2;
        let (_, b) = bounds(&p, "s1", &["w4".into()]).unwrap();
        assert_eq!(b.earliest, 2.3);
        assert_eq!(b.latest, 2.6);
        assert!(bounds(&p, "s1", &["w1".into(), "w4".into()]).is_err());
    }
}
