//! Short, rendered review passages: playback never seeks at an internal edit.
use crate::edl::Project;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AuditionState {
    renders: Mutex<HashMap<String, Render>>,
    cancelled: Mutex<HashSet<String>>,
}
struct Render {
    child: Option<CommandChild>,
    path: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAudition {
    path: String,
    duration: f64,
}

/// Clip source ranges in output order; no recognition words or padding are used.
fn ranges(project: &Project, start: f64, end: f64) -> Result<Vec<(String, f64, f64)>, String> {
    let duration: f64 = project
        .segments
        .iter()
        .map(|s| s.source_out - s.source_in)
        .sum();
    if !start.is_finite()
        || !end.is_finite()
        || start < 0.0
        || end <= start
        || end > duration + 1e-8
    {
        return Err("Invalid audition bounds".into());
    }
    let mut cursor = 0.0;
    let mut result: Vec<(String, f64, f64)> = Vec::new();
    for segment in &project.segments {
        let segment_end = cursor + segment.source_out - segment.source_in;
        let from = cursor.max(start);
        let to = segment_end.min(end);
        if to > from {
            let path = project
                .media
                .get(&segment.media_id)
                .ok_or("Missing audition media")?
                .path
                .clone();
            let sin = segment.source_in + from - cursor;
            let sout = segment.source_in + to - cursor;
            if let Some(last) = result.last_mut() {
                if last.0 == path && (last.2 - sin).abs() < 1e-9 {
                    last.2 = sout;
                    cursor = segment_end;
                    continue;
                }
            }
            result.push((path, sin, sout));
        }
        cursor = segment_end;
    }
    Ok(result)
}
struct RenderPlan {
    args: Vec<String>,
    audio_only: bool,
}
fn render_plan(project: &Project, start: f64, end: f64) -> Result<RenderPlan, String> {
    let ranges = ranges(project, start, end)?;
    let is_audio = |path: &str| {
        project
            .media
            .values()
            .find(|m| m.path == path)
            .is_some_and(|m| m.width == 0 || m.height == 0)
    };
    let audio_only = ranges.iter().all(|(path, _, _)| is_audio(path));
    // A separate fast-seeked input for each retained range also handles a jump
    // from the end of a long recording to its repeated beginning without
    // decoding the whole intervening source.
    let specs: Vec<_> = ranges
        .iter()
        .enumerate()
        .map(|(idx, (_, sin, sout))| (idx, 0.0, sout - sin))
        .collect();
    let mut graph = super::export::build_segment_filter(&specs, ",scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1", audio_only);
    let mut argv: Vec<String> = vec!["-y".into(), "-v".into(), "error".into()];
    for (input, sin, sout) in &ranges {
        argv.extend([
            "-ss".into(),
            sin.to_string(),
            "-t".into(),
            (sout - sin).to_string(),
            "-i".into(),
            input.clone(),
        ]);
    }
    if !audio_only {
        let mut next = ranges.len();
        for (idx, (input, sin, sout)) in ranges.iter().enumerate() {
            if !is_audio(input) {
                continue;
            }
            // Mixed audio/video context gets a blank picture for audio-only
            // passages while keeping the shared continuous audio clock.
            graph = graph.replace(&format!("[{idx}:v]"), &format!("[{next}:v]"));
            argv.extend([
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!("color=c=black:s=640x360:r=30:d={}", sout - sin),
            ]);
            next += 1;
        }
    }
    argv.extend([
        "-filter_complex".into(),
        graph,
        "-map".into(),
        "[mainvox]".into(),
    ]);
    Ok(RenderPlan {
        args: argv,
        audio_only,
    })
}

fn valid_request_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}

#[tauri::command]
pub async fn prepare_filler_audition(
    app: AppHandle,
    state: State<'_, AuditionState>,
    project: Project,
    start: f64,
    end: f64,
    request_id: String,
) -> Result<PreparedAudition, String> {
    if !valid_request_id(&request_id) {
        return Err("Invalid audition request".into());
    }
    crate::transcript::validate_project(&project).map_err(|e| e.to_string())?;
    let plan = render_plan(&project, start, end)?;
    let audio_only = plan.audio_only;
    let mut argv = plan.args;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("filler-auditions");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let path = dir.join(format!(
        "{request_id}.{}",
        if audio_only { "m4a" } else { "mp4" }
    ));
    if !audio_only {
        argv.extend([
            "-map".into(),
            "[outv]".into(),
            "-fps_mode".into(),
            "vfr".into(),
            "-c:v".into(),
            "h264_videotoolbox".into(),
            "-b:v".into(),
            "1500k".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
        ]);
    }
    argv.extend([
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        path.to_string_lossy().into_owned(),
    ]);
    // Check cancellation and register the child without an intervening await.
    let mut cancelled = state.cancelled.lock().await;
    if cancelled.remove(&request_id) {
        return Err("Audition cancelled".into());
    }
    let mut renders = state.renders.lock().await;
    let (mut rx, child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?
        .args(argv)
        .spawn()
        .map_err(|e| e.to_string())?;
    renders.insert(
        request_id.clone(),
        Render {
            child: Some(child),
            path: path.clone(),
        },
    );
    drop(renders);
    drop(cancelled);
    let mut error = String::new();
    let mut success = false;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(bytes) => {
                if error.len() < 8192 {
                    error.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
            CommandEvent::Terminated(exit) => {
                success = exit.code == Some(0);
                break;
            }
            _ => {}
        }
    }
    let mut renders = state.renders.lock().await;
    if let Some(render) = renders.get_mut(&request_id) {
        render.child = None;
    } else {
        drop(renders);
        let _ = tokio::fs::remove_file(&path).await;
        return Err("Audition cancelled".into());
    }
    if !success {
        renders.remove(&request_id);
        drop(renders);
        let _ = tokio::fs::remove_file(&path).await;
        return Err(format!("Could not prepare audition: {error}"));
    }
    Ok(PreparedAudition {
        path: path.to_string_lossy().into_owned(),
        duration: end - start,
    })
}

#[tauri::command]
pub async fn release_filler_audition(
    state: State<'_, AuditionState>,
    request_id: String,
) -> Result<(), String> {
    if !valid_request_id(&request_id) {
        return Err("Invalid audition request".into());
    }
    let mut cancelled = state.cancelled.lock().await;
    let mut renders = state.renders.lock().await;
    if let Some(mut render) = renders.remove(&request_id) {
        if let Some(child) = render.child.take() {
            let _ = child.kill();
        }
        drop(renders);
        drop(cancelled);
        let _ = tokio::fs::remove_file(render.path).await;
    } else {
        // A close can arrive before the corresponding prepare command starts.
        if cancelled.len() > 256 {
            cancelled.clear();
        }
        cancelled.insert(request_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prepared_before_contains_filler_tone_and_cut_preview_removes_it() {
        use std::process::Command;
        if Command::new("ffmpeg").arg("-version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("audition-content-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("source.mp4");
        // A distinctive filler tone late in a compressed, long-GOP source.
        // This tests real per-input fast seeking, not just filter strings or duration.
        let tone = "aevalsrc=if(between(t\\,10.35\\,10.65)\\,sin(2*PI*1800*t)\\,sin(2*PI*220*t)):s=48000:d=15";
        let generated = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=16x16:rate=30:duration=15",
                "-f",
                "lavfi",
                "-i",
                tone,
                "-c:v",
                "mpeg4",
                "-g",
                "300",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
            ])
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let mut before: Project = serde_json::from_str(include_str!(
            "../../../tests/fixtures/filler-retained-edges.json"
        ))
        .unwrap();
        before.media.get_mut("m1").unwrap().path = path.to_string_lossy().into_owned();
        before.media.get_mut("m1").unwrap().duration = 15.0;
        let mut segment = before.segments[0].clone();
        segment.source_in = 0.0;
        segment.source_out = 15.0;
        segment.words.clear();
        segment.transcript = None;
        segment.occurrence_lineage = None;
        before.segments = vec![segment.clone()];
        let mut preview = before.clone();
        segment.source_out = 10.35;
        let mut right = segment.clone();
        right.id = "right".into();
        right.source_in = 10.65;
        right.source_out = 15.0;
        preview.segments = vec![segment, right];
        for (project, end, expected_samples, contains_filler) in [
            (&before, 12.65, 206400, true),
            (&preview, 12.35, 192000, false),
        ] {
            crate::transcript::validate_project(project).unwrap();
            let plan = render_plan(project, 8.35, end).unwrap();
            let rendered = Command::new("ffmpeg")
                .args(plan.args)
                .args([
                    "-f",
                    "f32le",
                    "pipe:1",
                    "-map",
                    "[outv]",
                    "-fps_mode",
                    "vfr",
                    "-f",
                    "null",
                    "-",
                ])
                .output()
                .unwrap();
            assert!(
                rendered.status.success(),
                "{}",
                String::from_utf8_lossy(&rendered.stderr)
            );
            let samples: Vec<f32> = rendered
                .stdout
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            assert_eq!(samples.len(), expected_samples);
            let (mut real, mut imag) = (0.0, 0.0);
            for (i, sample) in samples.iter().enumerate() {
                let phase = 2.0 * std::f64::consts::PI * 1800.0 * i as f64 / 48000.0;
                real += *sample as f64 * phase.cos();
                imag += *sample as f64 * phase.sin();
            }
            let strength = 2.0 * real.hypot(imag) / samples.len() as f64;
            if contains_filler {
                assert!(strength > 0.05, "before must contain filler: {strength}");
            } else {
                assert!(strength < 0.001, "preview must remove filler: {strength}");
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn bounded_ranges_remove_the_cut_and_preserve_output_occurrences() {
        let project: Project = serde_json::from_str(include_str!(
            "../../../tests/fixtures/filler-retained-edges.json"
        ))
        .unwrap();
        let clips = ranges(&project, 0.3, 0.8).unwrap();
        assert_eq!(clips.len(), 2);
        assert!((clips[0].1 - 0.3).abs() < 1e-9);
        assert!((clips[0].2 - 0.55).abs() < 1e-9);
        assert!((clips[1].1 - 0.75).abs() < 1e-9);
        assert!((clips[1].2 - 1.0).abs() < 1e-9);
        assert!(ranges(&project, f64::NAN, 1.0).is_err());
        assert!(ranges(&project, 0.0, 6.0).is_err());
    }
}
