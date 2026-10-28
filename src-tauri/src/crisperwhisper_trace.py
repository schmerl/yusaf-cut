"""Best-effort numeric checkpoints inside CrisperWhisper's longform path.

The installed Python package is bundled by PyInstaller. These wrappers observe
its existing calls without changing arguments, results, or transcript text.
"""

import importlib
import logging
import time


def install_chunk_tracing(model, diagnostic):
    """Trace feature extraction, decoding, and word alignment per longform window."""
    engine = getattr(model, "_engine", None)
    if engine is None or not all(hasattr(engine, name) for name in (
        "extract_features_with_mel", "generate_with_repair_and_attention"
    )):
        diagnostic("chunk_tracing_unavailable", reason="engine_hooks_missing")
        return

    try:
        timing = importlib.import_module("crisperwhisper.word_timing")
        continuation = importlib.import_module("crisperwhisper.longform.continuation")
        if not hasattr(timing, "extract_word_timings"):
            diagnostic("chunk_tracing_unavailable", reason="alignment_hook_missing")
            return

        state = {"chunk": 0}
        original_features = engine.extract_features_with_mel
        original_decode = engine.generate_with_repair_and_attention
        original_align = timing.extract_word_timings

        def features(audio, *args, **kwargs):
            state["chunk"] += 1
            chunk = state["chunk"]
            diagnostic("chunk_started", chunkIndex=chunk, audioSeconds=round(len(audio) / 16000, 2))
            started = time.monotonic()
            try:
                result = original_features(audio, *args, **kwargs)
            except BaseException as exc:
                diagnostic("chunk_stage_error", chunkIndex=chunk, stage="features", errorType=type(exc).__name__)
                raise
            diagnostic("chunk_features_ready", chunkIndex=chunk, elapsedSeconds=time.monotonic() - started)
            return result

        def decode(*args, **kwargs):
            chunk = state["chunk"]
            diagnostic("chunk_decode_started", chunkIndex=chunk)
            started = time.monotonic()
            try:
                result = original_decode(*args, **kwargs)
            except BaseException as exc:
                diagnostic("chunk_stage_error", chunkIndex=chunk, stage="decode", errorType=type(exc).__name__)
                raise
            diagnostic("chunk_decode_finished", chunkIndex=chunk,
                       elapsedSeconds=time.monotonic() - started, tokenCount=len(result[0]))
            return result

        def align(*args, **kwargs):
            chunk = state["chunk"]
            diagnostic("chunk_alignment_started", chunkIndex=chunk)
            started = time.monotonic()
            try:
                result = original_align(*args, **kwargs)
            except BaseException as exc:
                diagnostic("chunk_stage_error", chunkIndex=chunk, stage="alignment", errorType=type(exc).__name__)
                raise
            diagnostic("chunk_alignment_finished", chunkIndex=chunk,
                       elapsedSeconds=time.monotonic() - started, wordCount=len(result))
            return result

        engine.extract_features_with_mel = features
        engine.generate_with_repair_and_attention = decode
        timing.extract_word_timings = align

        class ChunkLogHandler(logging.Handler):
            def emit(self, record):
                # Only numeric, known CrisperWhisper events enter our log.
                if record.msg == "Continuation longform (+timestamps): %.1fs -> %d chunk(s) (stride=%.0fs, overlap=%.0fs)":
                    duration, count, stride, overlap = record.args
                    diagnostic("longform_planned", audioSeconds=duration, chunkCount=count,
                               strideSeconds=stride, overlapSeconds=overlap)
                elif record.msg == "Chunk %d/%d: %d words (%d confirmed, %d timed)":
                    index, count, words, confirmed, timed = record.args
                    diagnostic("chunk_completed", chunkIndex=index, chunkCount=count,
                               wordCount=words, confirmedCount=confirmed, timedCount=timed)
                elif record.msg == "Chunk %d/%d produced empty output.":
                    index, count = record.args
                    diagnostic("chunk_empty", chunkIndex=index, chunkCount=count)

        continuation.logger.addHandler(ChunkLogHandler())
        continuation.logger.setLevel(logging.INFO)
        diagnostic("chunk_tracing_enabled")
    except Exception as exc:
        diagnostic("chunk_tracing_unavailable", reason=type(exc).__name__)
