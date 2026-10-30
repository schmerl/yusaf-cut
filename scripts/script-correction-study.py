#!/usr/bin/env python3
"""Read-only acoustic feasibility study. No project writes or model downloads.

prepare: explicit source bounds -> hashed 16 kHz mono excerpts + blind label page.
decode: development excerpts only -> independent/prompted/adversarial decodes.
Held-out decoding is deliberately a separate, future release-gate operation.
All generated transcripts, paths, labels and excerpts stay in the private output folder.
"""
import argparse
import hashlib
import html
import json
import math
import platform
import re
import resource
import subprocess
import sys
import time
from pathlib import Path

POLICY = "script-acoustic-study-v1"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(args, log, timeout=300):
    # No shell, interpolation, network or cloud fallback. Kill and reap on timeout.
    with log.open("w", encoding="utf-8") as stream:
        subprocess.run([str(arg) for arg in args], stdout=stream, stderr=stream,
                       check=True, timeout=timeout)


def validate_case(case, project):
    case_id = case.get("id", "")
    if not isinstance(case_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", case_id):
        raise ValueError("Case IDs must be short lowercase letters/numbers/hyphens")
    if case.get("split") not in ("development", "held-out"):
        raise ValueError(f"{case_id}: choose development or held-out before analysis")
    bounds = [case.get("sourceIn"), case.get("sourceOut")]
    if not all(type(n) in (int, float) and math.isfinite(n) for n in bounds):
        raise ValueError(f"{case_id}: source bounds must be finite seconds")
    start, end = bounds
    if start < 0 or not 0 < end - start <= 30:
        raise ValueError(f"{case_id}: choose a positive excerpt of at most 30 seconds")
    segments = [s for s in project["segments"] if s["id"] == case.get("segmentId")]
    if len(segments) != 1:
        raise ValueError(f"{case_id}: choose one unambiguous segment occurrence")
    segment = segments[0]
    if start < segment["sourceIn"] or end > segment["sourceOut"]:
        raise ValueError(f"{case_id}: excerpt crosses an existing cut")
    media = project["media"][segment["mediaId"]]
    if end > media["duration"]:
        raise ValueError(f"{case_id}: excerpt exceeds source duration")
    words = [w for w in segment["words"] if w["end"] > start and w["start"] < end]
    if not words:
        raise ValueError(f"{case_id}: excerpt has no surviving recognition anchors")
    for key in ("scriptExcerpt", "adversarialPrompt", "purpose"):
        if not isinstance(case.get(key), str) or not case[key].strip():
            raise ValueError(f"{case_id}: missing {key}")
    return segment, media, words


def label_page(cases, study_id):
    # Escape all source/user content; no remote links, Markdown rendering or fetch.
    cards = []
    for case in cases:
        cid = case["id"]
        cards.append(f'''<article data-id="{cid}">
<h2>{html.escape(cid)} · {html.escape(case['split'])}</h2>
<audio controls preload="none" src="{cid}.wav"></audio>
<label>What was actually spoken? Include repetitions, fillers and unfinished words.
<textarea class="spoken" rows="3"></textarea></label>
<label>Audibility <select class="audibility"><option value="">Choose…</option>
<option>clear</option><option>uncertain</option><option>inaudible</option></select></label>
<label>Notes about names, identifiers, intentional deviations or cut joins
<textarea class="notes" rows="2"></textarea></label>
<details><summary>After listening and writing your answer, inspect the comparison</summary>
<p>Purpose: {html.escape(case['purpose'])}</p>
<p>Source time: {case['sourceIn']:.2f}–{case['sourceOut']:.2f} seconds</p>
<p>Original recognition (may contain errors): {html.escape(case['originalRecognition'])}</p>
<p>Script excerpt (guidance, not ground truth): {html.escape(case['scriptExcerpt'])}</p>
<label>Does the script's wording match the audio? <select class="match">
<option value="">Choose…</option><option>yes</option><option>no</option><option>uncertain</option>
</select></label></details></article>''')
    return '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src 'self' file:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Script correction listening study</title>
<style>body{font:17px system-ui;max-width:850px;margin:2rem auto;padding:0 1rem;color:#182333}
article{border:1px solid #aab;padding:1rem;margin:1.5rem 0;border-radius:8px}
label{display:block;margin:1rem 0}textarea{display:block;width:98%;font:inherit}
audio{width:100%}button,select{font:inherit;padding:.4rem}summary{cursor:pointer}
.notice{background:#fff2cb;padding:1rem}</style>
<h1>Script correction listening study</h1>
<p class="notice">Listen before revealing text. Write what you hear; use “uncertain”
where needed. This page does not change any project and never sends data anywhere.
Keep this page and your exported labels private. Answers are kept only in this
open tab until you download them; download before closing or refreshing.</p>
<p>Use headphones. Replay as needed. Keep restarts/fillers in your transcription.
The held-out labels are for later evaluation; they will not be used to tune the rule.</p>
''' + "\n".join(cards) + '''
<button id="download">Download listening labels</button><p id="status" role="status"></p>
<script>
document.querySelector('#download').onclick = () => {
 const cases = [...document.querySelectorAll('article')].map(card => ({
   id: card.dataset.id, spoken: card.querySelector('.spoken').value,
   audibility: card.querySelector('.audibility').value,
   scriptMatchesAudio: card.querySelector('.match').value,
   notes: card.querySelector('.notes').value
 }));
 const blob = new Blob([JSON.stringify({version:1,studyId:STUDY_ID,cases},null,2)], {type:'application/json'});
 const url = URL.createObjectURL(blob), link = document.createElement('a');
 link.href = url; link.download = 'listening-labels.json'; link.click();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
 document.querySelector('#status').textContent = 'Labels downloaded. Keep the JSON with this study.';
};
</script></html>'''.replace("STUDY_ID", json.dumps(study_id))


def prepare(config_path, output, ffmpeg):
    config_path, output = Path(config_path).resolve(), Path(output).resolve()
    config = read_json(config_path)
    if config.get("version") != 1 or not config.get("cases"):
        raise ValueError("Expected a version 1 study config with cases")
    projects, inputs, cases, ids = {}, {}, [], set()
    # Validate the entire batch before creating/extracting anything.
    for case in config["cases"]:
        project_path = Path(case["project"]).resolve()
        if project_path.is_dir():
            project_path /= "project.json"
        script_path = Path(case["script"]).resolve()
        if project_path not in projects:
            projects[project_path] = read_json(project_path)
        project = projects[project_path]
        if project.get("version") != 1:
            raise ValueError("Unsupported project version")
        segment, media, words = validate_case(case, project)
        if case["id"] in ids:
            raise ValueError("Duplicate case ID")
        ids.add(case["id"])
        media_path = Path(media["path"]).resolve()
        if not media_path.is_file():
            raise ValueError(f"{case['id']}: source media is unavailable locally")
        for path in (project_path, script_path, media_path):
            if output == path or path.is_relative_to(output) or output.is_relative_to(project_path.parent):
                raise ValueError("Output must be separate from source projects and inputs")
            if path not in inputs:
                inputs[path] = sha256(path)
        script_path.read_text(encoding="utf-8")  # Strict UTF-8; never fetch linked resources.
        cases.append({**case, "project": str(project_path), "script": str(script_path),
                      "mediaPath": str(media_path), "mediaSha256": inputs[media_path],
                      "occurrenceLineage": segment.get("occurrenceLineage", segment["id"]),
                      "anchorIds": [w["id"] for w in words],
                      "originalRecognition": " ".join(w["text"] for w in words)})
    output.mkdir(parents=True, exist_ok=False)  # Never overwrite a prior study.
    study_id = hashlib.sha256(config_path.read_bytes()).hexdigest()
    manifest = {"version": 1, "policy": POLICY, "studyId": study_id,
                "configSha256": sha256(config_path), "machine": platform.machine(),
                "system": platform.platform(), "cases": cases,
                "inputs": {str(path): digest for path, digest in inputs.items()},
                "ffmpegSha256": sha256(ffmpeg), "status": "preparing"}
    write_json(output / "study.json", manifest)
    try:
        for case in cases:
            run([ffmpeg, "-nostdin", "-v", "error", "-ss", case["sourceIn"],
                 "-i", case["mediaPath"], "-t", case["sourceOut"] - case["sourceIn"],
                 "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                 output / (case["id"] + ".wav")], output / (case["id"] + ".extract.log"))
            case["audioSha256"] = sha256(output / (case["id"] + ".wav"))
        verify_inputs(manifest)
        # Disposable project copies for checking the same passages in the native
        # editor. Media remains referenced read-only; never copy recognition caches.
        manifest["reviewProjects"] = []
        for index, (path, project) in enumerate(projects.items(), 1):
            bundle = output / f"review-project-{index}.scribe"
            bundle.mkdir()
            copy = {**project, "id": f"study-{study_id[:16]}-{index}",
                    "name": "Listening study copy — " + project.get("name", "Untitled")}
            write_json(bundle / "project.json", copy)
            manifest["reviewProjects"].append({"sourceProject": str(path), "copy": str(bundle)})
        manifest["status"] = "ready"
        write_json(output / "study.json", manifest)
        (output / "listen.html").write_text(label_page(cases, study_id), encoding="utf-8")
    except BaseException:
        manifest["status"] = "failed"
        write_json(output / "study.json", manifest)
        raise
    return output / "listen.html"


def verify_inputs(manifest):
    for path, digest in manifest["inputs"].items():
        if sha256(path) != digest:
            raise ValueError("A study input changed; prepare a new study")


def decode(study, whisper, model, case_ids, no_gpu=False):
    study = Path(study).resolve()
    manifest = read_json(study / "study.json")
    if manifest.get("policy") != POLICY or manifest.get("status") != "ready":
        raise ValueError("Prepare a complete study before decoding")
    chosen = [case for case in manifest["cases"] if case["id"] in case_ids]
    if len(chosen) != len(set(case_ids)) or not chosen:
        raise ValueError("Choose existing development case IDs")
    if any(case["split"] != "development" for case in chosen):
        raise ValueError("Held-out decoding is locked during feasibility development")
    verify_inputs(manifest)
    model_hash, engine_hash = sha256(model), sha256(whisper)
    results = study / ("decodes-" + str(time.time_ns()))
    results.mkdir()
    run_info = {"policy": POLICY, "studyId": manifest["studyId"], "modelSha256": model_hash,
                "modelName": Path(model).name, "engineSha256": engine_hash,
                "machine": platform.machine(), "system": platform.platform(),
                "gpuDisabled": no_gpu, "status": "running", "results": []}
    write_json(results / "run.json", run_info)
    try:
        for case in chosen:
            audio = study / (case["id"] + ".wav")
            if sha256(audio) != case["audioSha256"]:
                raise ValueError("Excerpt changed; prepare a new study")
            for mode, prompt in [("unprompted", None), ("script", case["scriptExcerpt"]),
                                 ("adversarial", case["adversarialPrompt"])]:
                prefix = results / (case["id"] + "-" + mode)
                args = [whisper, "-m", model, "-f", audio, "-l", "en", "-ojf", "-of", prefix,
                        "-bo", "5", "-bs", "5", "-tp", "0", "-tpi", "0", "-nf"]
                if no_gpu:
                    args += ["-ng"]
                if prompt is not None:
                    args += ["--prompt", prompt]
                started = time.monotonic()
                run(args, prefix.with_suffix(".log"))
                decoded = read_json(prefix.with_suffix(".json"))
                text = " ".join(row["text"].strip() for row in decoded["transcription"])
                run_info["results"].append({"id": case["id"], "mode": mode, "text": text,
                                             "elapsedSeconds": time.monotonic() - started,
                                             # Darwin reports bytes; Linux reports KiB.
                                             # High-water mark over children so far, not an incremental delta.
                                             "childPeakMemoryBytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
                                             * (1 if sys.platform == "darwin" else 1024)})
                write_json(results / "run.json", run_info)
        verify_inputs(manifest)
        run_info["status"] = "complete"
    except BaseException:
        run_info["status"] = "failed"
        raise
    finally:
        write_json(results / "run.json", run_info)
    return results / "run.json"


def validate_labels(study, labels):
    manifest = read_json(Path(study) / "study.json")
    labels = read_json(labels)
    if labels.get("version") != 1 or labels.get("studyId") != manifest.get("studyId"):
        raise ValueError("Labels belong to another study or unsupported version")
    expected = {case["id"] for case in manifest["cases"]}
    seen = set()
    for case in labels.get("cases", []):
        if case.get("id") not in expected or case["id"] in seen:
            raise ValueError("Unknown or duplicate labeled case")
        seen.add(case["id"])
        if case.get("audibility") not in ("clear", "uncertain", "inaudible"):
            raise ValueError(f"{case['id']}: choose audibility")
        if case.get("scriptMatchesAudio") not in ("yes", "no", "uncertain"):
            raise ValueError(f"{case['id']}: choose whether the script matches")
        if not isinstance(case.get("spoken"), str) or not case["spoken"].strip():
            raise ValueError(f"{case['id']}: transcribe speech or write [inaudible]")
    if seen != expected:
        raise ValueError("Label every case, using uncertain where necessary")
    # Deliberately print coverage only, never held-out labels during development.
    return f"Validated {len(seen)} listening labels. Held-out wording remains undisclosed."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    prep.add_argument("--config", type=Path, required=True)
    prep.add_argument("--output", type=Path, required=True)
    prep.add_argument("--ffmpeg", type=Path, required=True)
    rec = commands.add_parser("decode")
    rec.add_argument("--study", type=Path, required=True)
    rec.add_argument("--whisper", type=Path, required=True)
    rec.add_argument("--model", type=Path, required=True)
    rec.add_argument("--case", action="append", required=True)
    rec.add_argument("--no-gpu", action="store_true")
    labels = commands.add_parser("validate-labels")
    labels.add_argument("--study", type=Path, required=True)
    labels.add_argument("--labels", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            print(prepare(args.config, args.output, args.ffmpeg.resolve()))
        elif args.command == "decode":
            print(decode(args.study, args.whisper.resolve(), args.model.resolve(), args.case, args.no_gpu))
        else:
            print(validate_labels(args.study, args.labels))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"Study stopped: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Study cancelled; no project was changed", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
