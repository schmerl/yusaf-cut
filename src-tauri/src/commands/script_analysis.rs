//! Bounded unprompted evidence. Never writes recognition anchors or caches.
use crate::{
    edl::Project,
    jobs::{JobHandle, JobKind},
    AppState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct ScriptAnalysisState {
    runs: Mutex<HashMap<String, (bool, Arc<AtomicBool>)>>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioWindow {
    pub segment_id: String,
    pub source_in: f64,
    pub source_out: f64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowEvidence {
    pub segment_id: String,
    pub source_in: f64,
    pub source_out: f64,
    pub text: String,
}
#[derive(Serialize)]
pub struct AnalysisEvidence {
    pub engine: String,
    pub model: String,
    pub windows: Vec<WindowEvidence>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    request_id: String,
    completed: usize,
    total: usize,
}
struct TemporaryDirectory(PathBuf);
impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fingerprint_model(path: &std::path::Path, cancel: &AtomicBool) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Analysis cancelled.".into());
        }
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn file_stamp(path: &std::path::Path) -> Result<(u64, Option<std::time::SystemTime>), String> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| "A local analysis input is unavailable. Relink/setup and retry.")?;
    Ok((metadata.len(), metadata.modified().ok()))
}

fn validate_windows(project: &Project, windows: &[AudioWindow]) -> Result<Vec<String>, String> {
    crate::transcript::validate_project(project).map_err(|e| e.to_string())?;
    if windows.is_empty() || windows.len() > 2000 {
        return Err("Choose a nonempty analysis scope (at most 2000 audio windows).".into());
    }
    windows.iter().map(|window| {
        let segment = project.segments.iter().find(|s| s.id == window.segment_id).ok_or("The audio occurrence changed.")?;
        if !window.source_in.is_finite() || !window.source_out.is_finite() || window.source_in < 0.0 || window.source_in < segment.source_in ||
            window.source_out > segment.source_out || window.source_out <= window.source_in || window.source_out - window.source_in > 30.0 + 1e-6 {
            return Err("Audio analysis must stay inside one surviving source range of at most 30 seconds.".into());
        }
        let media = project.media.get(&segment.media_id).ok_or("Missing source media.")?;
        if window.source_out > media.duration { return Err("Audio analysis exceeds source duration.".into()); }
        if !std::path::Path::new(&media.path).is_file() { return Err("Source media is unavailable locally. Relink it and retry.".into()); }
        Ok(media.path.clone())
    }).collect()
}

async fn run_child(
    app: &AppHandle,
    binary: &str,
    args: Vec<String>,
    cancel: &AtomicBool,
    job: &JobHandle,
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) || job.is_cancelled() {
        return Err("Analysis cancelled.".into());
    }
    let (mut events, child) = app
        .shell()
        .sidecar(binary)
        .map_err(|_| {
            format!("Local {binary} capability is unavailable. Complete local setup and retry.")
        })?
        .args(args)
        .spawn()
        .map_err(|e| format!("Could not start local {binary}: {e}"))?;
    let mut child = Some(child);
    let mut poll = tokio::time::interval(std::time::Duration::from_millis(50));
    let timeout = tokio::time::sleep(std::time::Duration::from_secs(300));
    tokio::pin!(timeout);
    loop {
        tokio::select! {
            _ = poll.tick() => {
                if cancel.load(Ordering::SeqCst) || job.is_cancelled() {
                    if let Some(child) = child.take() { let _ = child.kill(); }
                    return Err("Analysis cancelled.".into());
                }
            },
            _ = &mut timeout => {
                if let Some(child) = child.take() { let _ = child.kill(); }
                return Err(format!("Local {binary} timed out. No reconciliation changes were committed."));
            },
            event = events.recv() => match event {
                Some(CommandEvent::Terminated(payload)) => return if payload.code == Some(0) { Ok(()) } else { Err(format!("Local {binary} failed. Check the installed model/capability and retry.")) },
                None => return Err(format!("Local {binary} ended without a completion status.")),
                _ => {},
            }
        }
    }
}

#[tauri::command]
pub async fn cancel_script_analysis(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&request_id).map_err(|_| "Invalid analysis request ID.")?;
    let mut runs = state.script_analysis.runs.lock().await;
    if let Some((_, flag)) = runs.get(&request_id) {
        flag.store(true, Ordering::SeqCst);
    } else if runs.len() < 128 {
        runs.insert(request_id, (false, Arc::new(AtomicBool::new(true))));
    }
    Ok(())
}

#[tauri::command]
pub async fn analyze_script_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Project,
    windows: Vec<AudioWindow>,
    request_id: String,
    model: super::transcribe::WhisperModel,
) -> Result<AnalysisEvidence, String> {
    uuid::Uuid::parse_str(&request_id).map_err(|_| "Invalid analysis request ID.")?;
    let paths = validate_windows(&project, &windows)?;
    let model_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models")
        .join(model.filename());
    if !model_path.is_file() {
        return Err("The selected local Whisper model is not installed. Install it in transcription settings, then retry. No model is downloaded by reconciliation.".into());
    }
    let flag = {
        let mut runs = state.script_analysis.runs.lock().await;
        if runs.len() >= 128 {
            return Err(
                "Too many outstanding analysis requests; restart the app and retry.".into(),
            );
        }
        let entry = runs
            .entry(request_id.clone())
            .or_insert_with(|| (false, Arc::new(AtomicBool::new(false))));
        if entry.0 {
            return Err("This analysis request is already running.".into());
        }
        entry.0 = true;
        entry.1.clone()
    };
    let job = state
        .jobs
        .create(
            &app,
            JobKind::ScriptReconcile,
            "Analyzing presentation script",
        )
        .await;
    let _serial = state.jobs.serialise(JobKind::ScriptReconcile).await;
    job.mark_running().await;
    let result = async {
        let model_stamp = file_stamp(&model_path)?;
        let mut source_stamps = HashMap::new();
        for source in &paths { source_stamps.insert(source.clone(), file_stamp(std::path::Path::new(source))?); }
        let path_for_hash = model_path.clone();
        let flag_for_hash = flag.clone();
        let fingerprint =
            tokio::task::spawn_blocking(move || fingerprint_model(&path_for_hash, &flag_for_hash))
                .await
                .map_err(|e| e.to_string())??;
        let path = std::env::temp_dir().join(format!("yusafcut-script-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&path)
            .await
            .map_err(|e| e.to_string())?;
        let directory = TemporaryDirectory(path);
        let mut evidence = Vec::new();
        for (index, (window, source)) in windows.iter().zip(paths).enumerate() {
            if flag.load(Ordering::SeqCst) || job.is_cancelled() {
                return Err("Analysis cancelled.".into());
            }
            // Unique outputs cannot be mistaken for a prior window's evidence
            // if a broken recognizer exits without writing a fresh JSON file.
            let wav = directory.0.join(format!("audio-{index}.wav"));
            let prefix = directory.0.join(format!("recognition-{index}"));
            run_child(
                &app,
                "ffmpeg",
                vec![
                    "-y".into(),
                    "-nostdin".into(),
                    "-v".into(),
                    "error".into(),
                    "-ss".into(),
                    window.source_in.to_string(),
                    "-i".into(),
                    source,
                    "-t".into(),
                    (window.source_out - window.source_in).to_string(),
                    "-map".into(),
                    "0:a:0".into(),
                    "-vn".into(),
                    "-ac".into(),
                    "1".into(),
                    "-ar".into(),
                    "16000".into(),
                    "-c:a".into(),
                    "pcm_s16le".into(),
                    wav.to_string_lossy().into(),
                ],
                &flag,
                &job,
            )
            .await?;
            // Independent baseline only. No script prompt, grammar, translation,
            // conditioning, ensure_coreml_encoder download, or raw-cache writes.
            run_child(
                &app,
                "whisper-cli",
                vec![
                    "-m".into(),
                    model_path.to_string_lossy().into(),
                    "-f".into(),
                    wav.to_string_lossy().into(),
                    "-l".into(),
                    "auto".into(),
                    "-ojf".into(),
                    "-of".into(),
                    prefix.to_string_lossy().into(),
                    "-bo".into(),
                    "5".into(),
                    "-bs".into(),
                    "5".into(),
                ],
                &flag,
                &job,
            )
            .await?;
            let raw = tokio::fs::read_to_string(prefix.with_extension("json"))
                .await
                .map_err(|_| "Audio recognition produced no readable evidence.")?;
            let words = crate::transcribe::parse_whisper_json(&raw).map_err(|e| e.to_string())?;
            let _ = tokio::fs::remove_file(&wav).await;
            let _ = tokio::fs::remove_file(prefix.with_extension("json")).await;
            evidence.push(WindowEvidence {
                segment_id: window.segment_id.clone(),
                source_in: window.source_in,
                source_out: window.source_out,
                text: words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            });
            job.set_progress((index + 1) as f64 / windows.len() as f64, None)
                .await;
            app.emit(
                "script:progress",
                Progress {
                    request_id: request_id.clone(),
                    completed: index + 1,
                    total: windows.len(),
                },
            )
            .ok();
        }
        if flag.load(Ordering::SeqCst) || job.is_cancelled() {
            return Err("Analysis cancelled.".into());
        }
        if file_stamp(&model_path)? != model_stamp || source_stamps.iter().any(|(source, stamp)| file_stamp(std::path::Path::new(source)).as_ref() != Ok(stamp)) {
            return Err("Source media or the local model changed during analysis. No changes were committed; retry with stable inputs.".into());
        }
        Ok(AnalysisEvidence {
            engine: format!("whisper-cpp-unprompted/{}", env!("CARGO_PKG_VERSION")),
            model: format!("{}#{}", model.filename(), fingerprint),
            windows: evidence,
        })
    }
    .await;
    state.script_analysis.runs.lock().await.remove(&request_id);
    if flag.load(Ordering::SeqCst) || job.is_cancelled() {
        job.mark_cancelled().await;
    } else if let Err(error) = &result {
        job.mark_failed(error).await;
    } else {
        job.mark_completed().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_are_occurrence_scoped_bounded_and_cannot_bridge_a_cut() {
        let mut project: Project = serde_json::from_str(include_str!(
            "../../../tests/fixtures/transcript-corrections.json"
        ))
        .unwrap();
        let source = std::env::temp_dir().join(format!("script-window-{}", uuid::Uuid::new_v4()));
        std::fs::write(&source, b"synthetic source presence only").unwrap();
        project.media.get_mut("m1").unwrap().path = source.to_string_lossy().into();
        let valid = AudioWindow {
            segment_id: "s2".into(),
            source_in: 0.0,
            source_out: 3.0,
        };
        assert!(validate_windows(&project, &[valid.clone()]).is_ok());
        for (id, start, end) in [
            ("s2", -1.0, 2.0),
            ("s2", 2.0, 4.0),
            ("missing", 0.0, 2.0),
            ("s2", f64::NAN, 2.0),
            ("s2", 1.0, 1.0),
        ] {
            assert!(validate_windows(
                &project,
                &[AudioWindow {
                    segment_id: id.into(),
                    source_in: start,
                    source_out: end
                }]
            )
            .is_err());
        }
        // A different reused occurrence may have different surviving bounds.
        project.segments[1].source_in = 1.0;
        assert!(validate_windows(&project, &[valid.clone()]).is_err());
        let other_occurrence = AudioWindow {
            segment_id: "s1".into(),
            ..valid
        };
        assert!(validate_windows(&project, &[other_occurrence]).is_ok());
        std::fs::remove_file(source).unwrap();
        assert!(validate_windows(
            &project,
            &[AudioWindow {
                segment_id: "s1".into(),
                source_in: 0.0,
                source_out: 2.0
            }]
        )
        .is_err());
    }
}
