//! Read-only local retake analysis and verified model setup.
use crate::{
    jobs::{JobHandle, JobKind},
    AppState,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

const MANIFEST: &str = include_str!("../../../sidecars/mlx-llm/retake-model.json");
const MAX_RESPONSE: u64 = 262_144;
#[derive(Deserialize)]
struct Manifest {
    id: String,
    revision: String,
    files: Vec<ModelFile>,
}
#[derive(Deserialize)]
struct ModelFile {
    path: String,
    size: u64,
    sha256: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    installed: bool,
    model_id: String,
    revision: String,
    size_bytes: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisWord {
    text: String,
    start: f64,
    end: f64,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Attempt {
    start: usize,
    end: usize,
    complete: bool,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub struct Span {
    start: usize,
    end: usize,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct Group {
    kind: String,
    attempts: Vec<Attempt>,
    markers: Vec<Span>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisWindow {
    id: String,
    records: Vec<AnalysisWord>,
    hypotheses: Vec<Group>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WindowResult {
    id: String,
    groups: Vec<Group>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SidecarResponse {
    id: String,
    groups: Option<Vec<Group>>,
    error: Option<String>,
}

fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST).expect("embedded retake model manifest")
}
fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../models/retakes-qwen3-8b");
        if dev.is_dir() {
            return Ok(dev);
        }
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models/retakes")
        .join(manifest().revision))
}
fn installed(path: &Path, manifest: &Manifest) -> bool {
    manifest.files.iter().all(|f| {
        path.join(&f.path)
            .metadata()
            .map(|m| m.is_file() && m.len() == f.size)
            .unwrap_or(false)
    })
}
#[tauri::command]
pub async fn retake_model_status(app: AppHandle) -> Result<ModelStatus, String> {
    let m = manifest();
    Ok(ModelStatus {
        installed: installed(&model_dir(&app)?, &m),
        size_bytes: m.files.iter().map(|f| f.size).sum(),
        model_id: m.id,
        revision: m.revision,
    })
}
async fn cancelled(job: &JobHandle) {
    let notify = job.cancel_notify();
    loop {
        if job.is_cancelled() {
            return;
        }
        tokio::select! { _ = notify.notified() => {}, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
    }
}
async fn finish_job<T>(job: &JobHandle, result: Result<T, String>) -> Result<T, String> {
    match &result {
        Ok(_) => job.mark_completed().await,
        Err(_) if job.is_cancelled() => job.mark_cancelled().await,
        Err(e) => job.mark_failed(e).await,
    }
    result
}
fn announce_job(app: &AppHandle, run_id: &str, job: &JobHandle) {
    let _ = app.emit(
        "retakes:job",
        serde_json::json!({ "runId":run_id, "jobId":job.id() }),
    );
}

#[tauri::command]
pub async fn download_retake_model(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), String> {
    let job = state
        .jobs
        .create(
            &app,
            JobKind::DownloadModel,
            "Download retake model (4.6 GB)",
        )
        .await;
    announce_job(&app, &run_id, &job);
    let result = tokio::select! {
        _ = cancelled(&job) => Err("Retake model download cancelled".into()),
        result = async {
            let _guard = state.jobs.serialise(JobKind::DownloadModel).await;
            job.mark_running().await;
            let m = manifest();
            let path = model_dir(&app)?;
            tokio::fs::create_dir_all(&path).await.map_err(|e| e.to_string())?;
            let client = reqwest::Client::builder().timeout(Duration::from_secs(1800)).build().map_err(|e| e.to_string())?;
            let total: u64 = m.files.iter().map(|f| f.size).sum();
            let mut complete = 0u64;
            for file in &m.files {
                let target = path.join(&file.path);
                if verify_file(&target, file).await.is_ok() { complete += file.size; continue; }
                let url = format!("https://huggingface.co/{}/resolve/{}/{}", m.id, m.revision, file.path);
                let response = client.get(url).send().await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())?;
                let partial = target.with_extension("download");
                let mut out = tokio::fs::File::create(&partial).await.map_err(|e| e.to_string())?;
                let mut stream = response.bytes_stream();
                let mut size = 0;
                let mut hash = Sha256::new();
                let mut last_reported = 0;
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|e| e.to_string())?;
                    size += chunk.len() as u64;
                    if size > file.size { return Err("Model download exceeds pinned size".into()); }
                    hash.update(&chunk);
                    out.write_all(&chunk).await.map_err(|e| e.to_string())?;
                    if size - last_reported > 8_000_000 {
                        job.set_progress((complete+size) as f64 / total as f64, None).await;
                        last_reported = size;
                    }
                }
                out.flush().await.map_err(|e| e.to_string())?;
                drop(out);
                if size != file.size || hex::encode(hash.finalize()) != file.sha256 {
                    let _ = tokio::fs::remove_file(&partial).await;
                    return Err("Retake model checksum mismatch. Retry the download.".into());
                }
                tokio::fs::rename(&partial, &target).await.map_err(|e| e.to_string())?;
                complete += size;
                job.set_progress(complete as f64 / total as f64, None).await;
            }
            Ok(())
        } => result,
    };
    finish_job(&job, result).await
}
async fn verify_file(path: &Path, file: &ModelFile) -> Result<(), String> {
    let mut input = tokio::fs::File::open(path)
        .await
        .map_err(|e| e.to_string())?;
    if input.metadata().await.map_err(|e| e.to_string())?.len() != file.size {
        return Err("Model file size mismatch".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1_048_576];
    loop {
        let n = input.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if hex::encode(hash.finalize()) != file.sha256 {
        return Err("Retake model checksum mismatch. Download the model again.".into());
    }
    Ok(())
}
fn validate_windows(windows: &[AnalysisWindow]) -> Result<(), String> {
    if windows.len() > 2000 {
        return Err("Too many retake windows".into());
    }
    for w in windows {
        if w.records.is_empty()
            || w.records.len() > 400
            || w.id.len() > 100
            || w.hypotheses.len() > 32
        {
            return Err("Invalid retake window size".into());
        }
        for (i, r) in w.records.iter().enumerate() {
            if r.text.len() > 4096
                || !r.start.is_finite()
                || !r.end.is_finite()
                || r.start < 0.
                || r.end <= r.start
                || (i > 0 && r.start < w.records[i - 1].start)
            {
                return Err("Invalid retake word".into());
            }
        }
        for g in &w.hypotheses {
            if ![
                "word-stutter",
                "phrase-restart",
                "abandoned-start",
                "spoken-correction",
                "reworded-retake",
            ]
            .contains(&g.kind.as_str())
                || g.attempts.len() != 2
                || g.markers.len() > 16
            {
                return Err("Invalid retake hypothesis".into());
            }
            let mut occupied = std::collections::HashSet::new();
            for (a, b) in g
                .attempts
                .iter()
                .map(|a| (a.start, a.end))
                .chain(g.markers.iter().map(|a| (a.start, a.end)))
            {
                if a >= b || b > w.records.len() || (a..b).any(|i| !occupied.insert(i)) {
                    return Err("Invalid retake spans".into());
                }
            }
            let first = &g.attempts[0];
            let last = &g.attempts[1];
            if first.end > last.start
                || w.records[last.start].start - w.records[first.start].start > 30.
            {
                return Err("Retake comparison exceeds nearby window".into());
            }
        }
    }
    Ok(())
}
fn validate_response(window: &AnalysisWindow, bytes: &[u8]) -> Result<WindowResult, String> {
    let response: SidecarResponse =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid retake response: {e}"))?;
    if response.id != window.id {
        return Err("Retake response ID mismatch".into());
    }
    if let Some(error) = response.error {
        return Err(format!("Retake analysis failed: {error}"));
    }
    let groups = response.groups.ok_or("Missing retake results")?;
    if groups.len() > window.hypotheses.len() {
        return Err("Unexpected retake results".into());
    }
    for g in &groups {
        if !window.hypotheses.iter().any(|h| {
            h.kind == g.kind
                && h.markers == g.markers
                && h.attempts.len() == g.attempts.len()
                && h.attempts
                    .iter()
                    .zip(&g.attempts)
                    .all(|(a, b)| a.start == b.start && a.end == b.end)
        }) {
            return Err("Model changed retake spans".into());
        }
    }
    Ok(WindowResult {
        id: window.id.clone(),
        groups,
    })
}
async fn read_response(
    reader: &mut BufReader<tokio::process::ChildStdout>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut bounded = reader.take(MAX_RESPONSE + 1);
    bounded
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE || bytes.last() != Some(&b'\n') {
        return Err("Retake sidecar stopped or exceeded response limit".into());
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn analyze_retake_windows(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    windows: Vec<AnalysisWindow>,
) -> Result<Vec<WindowResult>, String> {
    validate_windows(&windows)?;
    let job = state
        .jobs
        .create(&app, JobKind::AnalyzeRetakes, "Find retakes")
        .await;
    announce_job(&app, &run_id, &job);
    let result = tokio::select! {
        _ = cancelled(&job) => Err("Retake detection cancelled".into()),
        result = async {
            let _guard=state.jobs.serialise(JobKind::AnalyzeRetakes).await;
            job.mark_running().await;
            let path=model_dir(&app)?;
            for file in &manifest().files { verify_file(&path.join(&file.path),file).await?; }
            let mut command;
            #[cfg(debug_assertions)] {
                let repo=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
                command=Command::new(repo.join("sidecars/mlx-llm/.venv/bin/python"));
                command.args(["-m","mlx_llm.retake_server"]).env("PYTHONPATH",repo.join("sidecars/mlx-llm"));
            }
            #[cfg(not(debug_assertions))] {
                command=Command::new(std::env::current_exe().map_err(|e| e.to_string())?.parent().ok_or("Missing executable directory")?.join("mlx-sidecar"));
                command.arg("--retakes");
            }
            command.arg("--model").arg(&path).env("HF_HUB_OFFLINE","1").env("TRANSFORMERS_OFFLINE","1")
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
            let mut child=command.spawn().map_err(|e| format!("Retake runtime unavailable: {e}"))?;
            let mut writer=child.stdin.take().ok_or("Missing retake input pipe")?;
            let mut reader=BufReader::new(child.stdout.take().ok_or("Missing retake output pipe")?);
            let mut results=Vec::new();
            for (index,window) in windows.iter().enumerate() {
                let request=serde_json::json!({"id":window.id,"records":window.records,"hypotheses":window.hypotheses});
                let mut line=serde_json::to_vec(&request).map_err(|e| e.to_string())?;
                line.push(b'\n');
                writer.write_all(&line).await.map_err(|e| e.to_string())?;
                writer.flush().await.map_err(|e| e.to_string())?;
                let bytes=tokio::time::timeout(Duration::from_secs(180),read_response(&mut reader)).await.map_err(|_| "Retake analysis timed out. Try a shorter project.".to_string())??;
                results.push(validate_response(window,&bytes)?);
                job.set_progress((index+1) as f64/windows.len() as f64,None).await;
            }
            let _=child.kill().await;
            Ok(results)
        } => result,
    };
    finish_job(&job, result).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window() -> AnalysisWindow {
        serde_json::from_value(serde_json::json!({"id":"w","records":[{"text":"POST","start":0.,"end":0.2},{"text":"PUT","start":1.,"end":1.2}],"hypotheses":[{"kind":"spoken-correction","attempts":[{"start":0,"end":1,"complete":false},{"start":1,"end":2,"complete":false}],"markers":[]}]})).unwrap()
    }
    #[test]
    fn validates_manifest_and_bounded_inputs() {
        let m = manifest();
        assert_eq!(m.revision.len(), 40);
        assert!(m
            .files
            .iter()
            .all(|f| f.sha256.len() == 64 && !f.path.contains('/')));
        assert!(validate_windows(&[window()]).is_ok());
        let mut w = window();
        w.records[1].start = 30.001;
        w.records[1].end = 31.;
        assert!(validate_windows(&[w]).is_err());
        let mut w = window();
        w.hypotheses[0].attempts[0].end = 3;
        assert!(validate_windows(&[w]).is_err());
    }
    #[test]
    fn model_can_change_only_completeness() {
        let w = window();
        let ok = serde_json::json!({"id":"w","groups":[{"kind":"spoken-correction","attempts":[{"start":0,"end":1,"complete":true},{"start":1,"end":2,"complete":true}],"markers":[]}]});
        assert!(validate_response(&w, &serde_json::to_vec(&ok).unwrap()).is_ok());
        let mut bad = ok.clone();
        bad["groups"][0]["attempts"][0]["end"] = 2.into();
        assert!(validate_response(&w, &serde_json::to_vec(&bad).unwrap()).is_err());
        assert!(validate_response(&w, b"not json").is_err());
        assert!(validate_response(&w, br#"{"id":"stale","groups":[]}"#).is_err());
    }
    #[tokio::test]
    async fn detects_corrupt_model_files() {
        let path = std::env::temp_dir().join(format!("retake-model-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&path, b"abc").await.unwrap();
        let f = ModelFile {
            path: "test".into(),
            size: 3,
            sha256: hex::encode(Sha256::digest(b"abc")),
        };
        assert!(verify_file(&path, &f).await.is_ok());
        tokio::fs::write(&path, b"xyz").await.unwrap();
        assert!(verify_file(&path, &f).await.is_err());
        tokio::fs::remove_file(path).await.unwrap();
    }
}
