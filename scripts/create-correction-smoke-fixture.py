#!/usr/bin/env python3
"""Create disposable 6s correction test project with a synthetic test-tone video.
Requires ffmpeg on PATH. Does not read or modify any user recording.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "src-tauri/target/manual-corrections"

def main():
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required on PATH to generate the optional smoke fixture")
    DEST.mkdir(parents=True, exist_ok=True)
    video = DEST / "test-tone.mp4"
    subprocess.run([
        ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video),
    ], check=True)
    project = json.loads((ROOT / "tests/fixtures/transcript-corrections.json").read_text())
    project["id"] = "manual-correction-smoke"
    project["name"] = "Correction smoke test"
    media = project["media"]["m1"]
    media.update(path=str(video), duration=3, width=640, height=360,
                 sha256=hashlib.sha256(video.read_bytes()).hexdigest())
    bundle = DEST / "Correction-smoke.scribe"
    bundle.mkdir(exist_ok=True)
    (bundle / "project.json").write_text(json.dumps(project, ensure_ascii=False, indent=2) + "\n")
    print(bundle)
    print("Expected: 6s timeline, two occurrences of the same 3s test-tone clip.")
    print("First: idempotency are not the serveur. Second: item potency aren’t the old server.")
    print("The audio is a test tone; use a COPY of a real lecture to assess speech synchronization.")

if __name__ == "__main__":
    main()
