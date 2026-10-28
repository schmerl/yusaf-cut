"""Verify numeric longform checkpoints preserve CrisperWhisper call behavior."""

import importlib.util
import logging
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


TRACE_PATH = Path(__file__).resolve().parents[1] / "src-tauri/src/crisperwhisper_trace.py"
spec = importlib.util.spec_from_file_location("crisperwhisper_trace", TRACE_PATH)
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)


class FakeEngine:
    def extract_features_with_mel(self, audio):
        return ("features", "mel")

    def generate_with_repair_and_attention(self, features, prompt, **kwargs):
        return ([1, 2, 3], "attention")


class ChunkTracingTests(unittest.TestCase):
    def test_stage_events_and_results_without_audio_or_text(self):
        package = types.ModuleType("crisperwhisper")
        package.__path__ = []
        timing = types.ModuleType("crisperwhisper.word_timing")
        timing.extract_word_timings = lambda *args, **kwargs: ["word", "word"]
        continuation = types.ModuleType("crisperwhisper.longform.continuation")
        continuation.logger = logging.getLogger("fake_crisper_success")
        model = types.SimpleNamespace(_engine=FakeEngine())
        events = []

        with patch.dict(sys.modules, {"crisperwhisper": package, "crisperwhisper.word_timing": timing,
                                      "crisperwhisper.longform.continuation": continuation}):
            trace.install_chunk_tracing(model, lambda phase, **details: events.append((phase, details)))
            continuation.logger.info("Continuation longform (+timestamps): %.1fs -> %d chunk(s) (stride=%.0fs, overlap=%.0fs)", 1200.0, 46, 26, 4)
            self.assertEqual(model._engine.extract_features_with_mel([0] * 32000), ("features", "mel"))
            self.assertEqual(model._engine.generate_with_repair_and_attention("features", [1]), ([1, 2, 3], "attention"))
            self.assertEqual(timing.extract_word_timings("features"), ["word", "word"])
            continuation.logger.info("Chunk %d/%d: %d words (%d confirmed, %d timed)", 1, 46, 7, 6, 6)

        self.assertEqual([phase for phase, _ in events], [
            "chunk_tracing_enabled", "longform_planned", "chunk_started", "chunk_features_ready",
            "chunk_decode_started", "chunk_decode_finished",
            "chunk_alignment_started", "chunk_alignment_finished", "chunk_completed",
        ])
        self.assertEqual(events[2][1], {"chunkIndex": 1, "audioSeconds": 2.0})
        self.assertEqual(events[5][1]["tokenCount"], 3)
        self.assertEqual(events[7][1]["wordCount"], 2)
        self.assertEqual(events[8][1]["chunkCount"], 46)
        self.assertNotIn("'word'", repr(events))

    def test_decode_failure_records_chunk_and_reraises(self):
        class FailingEngine(FakeEngine):
            def generate_with_repair_and_attention(self, *args, **kwargs):
                raise IndexError("index 447 is out of bounds")

        package = types.ModuleType("crisperwhisper")
        package.__path__ = []
        timing = types.ModuleType("crisperwhisper.word_timing")
        timing.extract_word_timings = lambda *args, **kwargs: []
        continuation = types.ModuleType("crisperwhisper.longform.continuation")
        continuation.logger = logging.getLogger("fake_crisper_failure")
        model = types.SimpleNamespace(_engine=FailingEngine())
        events = []
        with patch.dict(sys.modules, {"crisperwhisper": package, "crisperwhisper.word_timing": timing,
                                      "crisperwhisper.longform.continuation": continuation}):
            trace.install_chunk_tracing(model, lambda phase, **details: events.append((phase, details)))
            model._engine.extract_features_with_mel([0] * 16000)
            with self.assertRaises(IndexError):
                model._engine.generate_with_repair_and_attention("features", [1])
        self.assertEqual(events[-1], ("chunk_stage_error", {
            "chunkIndex": 1, "stage": "decode", "errorType": "IndexError"
        }))


if __name__ == "__main__":
    unittest.main()
