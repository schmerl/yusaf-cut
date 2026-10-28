"""Small JSON bridge for an externally installed CrisperWhisper 2 environment.

The app passes only a WAV path, a fixed model size, and an optional language.
Diagnostics from Transformers remain on stderr; stdout is one JSON document.
"""

import json
import sys

from crisperwhisper import CrisperWhisperModel


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
            for word in result.words
        ]
    )
)
