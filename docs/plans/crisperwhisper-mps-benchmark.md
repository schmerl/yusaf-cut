# CrisperWhisper Apple GPU benchmark

Status: Local benchmark, October 28, 2026. The recorded results justify making
MPS the default on this Mac, with CPU retained as a selectable compatibility path.

## Setup

- Apple M3 Max, 96 GB unified memory; PyTorch 2.14.1 reports MPS available.
- CrisperWhisper 2.0.3 medium, verbatim mode, word timestamps, Transformers
  5.21.0, same 16 kHz mono WAV for both runs.
- Audio duration: 1,413.9 seconds (23 minutes 34 seconds), processed as 55
  overlapping windows. The CPU run used the packaged bridge; the MPS run used
  the same bridge source from the development environment with `device="mps"`.
- Inference timings exclude model loading, audio extraction, and app startup.

| Device | Model load | Inference | Output words |
|---|---:|---:|---:|
| CPU | 8.57 s | 3,956.98 s | 3,072 |
| MPS | 6.22 s | 220.31 s | 3,071 |

MPS inference was 18.0 times faster. The difficult window 18 took 554.5 s on
CPU, including coverage recovery, and 7.43 s on MPS. Across the full output,
3,067 words matched in order after case/punctuation normalization; four words
changed and one `[breath]` token was absent on MPS. For the matching words,
median start/end time difference was zero, 95th percentile was zero, and the
largest start/end differences were 1.06/0.98 seconds. These comparisons do not
establish which transcript is more accurate; representative differences still
need listening review.

The rebuilt one-file sidecar completed a 60-second MPS sample in 15.19 s of
inference and produced exactly the same words and timings as the Python MPS
run on that sample. This confirms the packaged binary includes device selection
and the compatibility workaround. Its cold-start cost is separate from inference.

## Compatibility finding

The first MPS attempt failed in Transformers 5.21.0: its MPS-only deferred stop
check accesses `.layers` on `EncoderDecoderCache`, which has no such property.
For this pinned version, the bridge disables only that deferred stop optimization
and uses the ordinary synchronous stop check. The successful benchmarks used
this workaround. It changes generation scheduling, not the CrisperWhisper model,
word-timing setting, or requested output. Remove the workaround after testing a
Transformers release that fixes the cache path.

## Remaining acceptance

The updated sidecar was packaged and probed, the short MPS transcription passed
through that binary, and native/frontend checks passed. After the open project
is saved, restart the dev app with the new binary. Keep CPU selectable if MPS
fails or runs out of memory on another machine. Listen to the few differing
words and the largest timing outlier before declaring the quality equivalent.
