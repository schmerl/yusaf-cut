"""JSON bridge for the bundled CrisperWhisper runtime.

The app passes only a WAV path, a fixed model size, and an optional language.
Diagnostics from Transformers remain on stderr; stdout is one JSON document.
"""

import json
import multiprocessing
import os
import sys
import time
from datetime import datetime, timezone

# Torch can start multiprocessing's resource tracker after model load. In a
# frozen build, its child process invokes this executable with Python flags.
multiprocessing.freeze_support()

if sys.argv[1:] == ["--probe"]:
    from importlib.metadata import version

    print(json.dumps({"crisperwhisper": version("crisperwhisper")}))
    raise SystemExit(0)


wav_path, model_size, language = sys.argv[1:4]
diagnostics_path = sys.argv[4] if len(sys.argv) > 4 else None
run_id = sys.argv[5] if len(sys.argv) > 5 else None


def diagnostic(phase, **details):
    if not diagnostics_path or not run_id:
        return
    record = json.dumps({
        "time": datetime.now(timezone.utc).isoformat(),
        "runId": run_id,
        "phase": phase,
        "details": details,
    }) + "\n"
    try:
        fd = os.open(diagnostics_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            os.write(fd, record.encode("utf-8"))
        finally:
            os.close(fd)
    except OSError:
        pass  # Diagnostics must never prevent a transcript.


try:
    started = time.monotonic()
    diagnostic("bridge_started")
    from crisperwhisper import CrisperWhisperModel
    diagnostic("library_imported", elapsedSeconds=time.monotonic() - started)
    model = CrisperWhisperModel(model_size, backend="transformers")
    diagnostic("model_loaded", elapsedSeconds=time.monotonic() - started)
    inference_started = time.monotonic()
    diagnostic("inference_started")
    result = model.transcribe(
        wav_path,
        language=None if language == "auto" else language,
        mode="verbatim",
        word_timestamps=True,
    )
    words = [
        {"text": word.word, "start": word.start, "end": word.end}
        for word in (result.words or [])
    ]
    diagnostic("inference_finished", elapsedSeconds=time.monotonic() - inference_started, wordCount=len(words))
    print(json.dumps(words))
    diagnostic("json_written", wordCount=len(words))
except BaseException as exc:
    error_code = "token_timestamp_index_out_of_bounds" if (
        isinstance(exc, IndexError) and "out of bounds" in str(exc)
    ) else "unclassified"
    diagnostic("bridge_error", errorType=type(exc).__name__, errorCode=error_code)
    raise
