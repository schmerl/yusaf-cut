"""Exercise bridge diagnostics without downloading or loading a speech model."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


BRIDGE = Path(__file__).resolve().parents[1] / "src-tauri/src/crisperwhisper_bridge.py"


class BridgeDiagnosticsTests(unittest.TestCase):
    def run_bridge(self, source, device="cpu", transformers_version="test"):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "crisperwhisper.py").write_text(source)
            if device == "mps":
                package = root / "transformers"
                (package / "generation").mkdir(parents=True)
                (package / "__init__.py").write_text(f"__version__ = {transformers_version!r}\n")
                (package / "generation" / "__init__.py").write_text("")
                (package / "generation" / "utils.py").write_text(
                    "class DeferredStopCheck:\n"
                    "    @staticmethod\n"
                    "    def is_supported(*args, **kwargs): return True\n"
                )
            diagnostics = root / "diagnostics.jsonl"
            wav = root / "private-recording.wav"
            env = {**os.environ, "PYTHONPATH": str(root)}
            result = subprocess.run(
                [sys.executable, str(BRIDGE), str(wav), "medium", "auto", str(diagnostics), "test-run", device],
                env=env, capture_output=True, text=True, check=False,
            )
            events = [json.loads(line) for line in diagnostics.read_text().splitlines()]
            self.assertNotIn(str(wav), diagnostics.read_text())
            return result, events

    def test_success_records_model_inference_and_word_count(self):
        result, events = self.run_bridge("""
from types import SimpleNamespace
class CrisperWhisperModel:
    def __init__(self, *args, **kwargs): pass
    def transcribe(self, *args, **kwargs):
        return SimpleNamespace(words=[SimpleNamespace(word='hello', start=0.1, end=0.4)])
""")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(json.loads(result.stdout)), 1)
        self.assertEqual([e["phase"] for e in events], [
            "bridge_started", "device_selected", "library_imported", "model_loaded",
            "chunk_tracing_unavailable",
            "inference_started", "inference_finished", "json_written",
        ])

    def test_mps_is_forwarded_to_model(self):
        result, events = self.run_bridge("""
from types import SimpleNamespace
class CrisperWhisperModel:
    def __init__(self, *args, **kwargs):
        if kwargs.get('device') != 'mps': raise AssertionError('MPS not forwarded')
    def transcribe(self, *args, **kwargs):
        return SimpleNamespace(words=[SimpleNamespace(word='hello', start=0.1, end=0.4)])
""", device="mps")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(next(e for e in events if e["phase"] == "device_selected")["details"], {"device": "mps"})

    def test_mps_disables_incompatible_deferred_stop_in_pinned_transformers(self):
        result, events = self.run_bridge("""
from types import SimpleNamespace
from transformers.generation.utils import DeferredStopCheck
class CrisperWhisperModel:
    def __init__(self, *args, **kwargs):
        assert DeferredStopCheck.is_supported(None, None, False, False) is False
    def transcribe(self, *args, **kwargs):
        return SimpleNamespace(words=[SimpleNamespace(word='hello', start=0.1, end=0.4)])
""", device="mps", transformers_version="5.21.0")
        self.assertEqual(result.returncode, 0)
        self.assertIn("mps_deferred_stop_disabled", [e["phase"] for e in events])

    def test_timestamp_index_error_is_classified(self):
        result, events = self.run_bridge("""
class CrisperWhisperModel:
    def __init__(self, *args, **kwargs): pass
    def transcribe(self, *args, **kwargs):
        raise IndexError('index 447 is out of bounds for dimension 2 with size 447')
""")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(events[-1]["details"], {
            "errorType": "IndexError", "errorCode": "token_timestamp_index_out_of_bounds"
        })


if __name__ == "__main__":
    unittest.main()
