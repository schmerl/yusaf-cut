"""Small JSON bridge for an externally installed CrisperWhisper 2 environment.

The app passes only a WAV path, a fixed model size, and an optional language.
Diagnostics from Transformers remain on stderr; stdout is one JSON document.
"""

import json
import multiprocessing
import sys

# Torch can start multiprocessing's resource tracker after model load. In a
# frozen build, its child process invokes this executable with Python flags.
multiprocessing.freeze_support()

from crisperwhisper import CrisperWhisperModel

if sys.argv[1:] == ["--probe"]:
    from importlib.metadata import version

    print(json.dumps({"crisperwhisper": version("crisperwhisper")}))
    raise SystemExit(0)


wav_path, model_size, language = sys.argv[1:4]
model = CrisperWhisperModel(model_size, backend="transformers")
result = model.transcribe(
    wav_path,
    language=None if language == "auto" else language,
    mode="verbatim",
    word_timestamps=True,
)
print(
    json.dumps(
        [
            {"text": word.word, "start": word.start, "end": word.end}
            for word in (result.words or [])
        ]
    )
)
