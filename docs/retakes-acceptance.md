# Retakes feature acceptance audit

Feature stack: `feature/retakes-00-feasibility` through
`feature/retakes-06-acceptance`, based on `feature/transcript-correction-completion`.

## Automated evidence

- `npm run check`: TypeScript and ESLint pass.
- `npm test -- --reporter=dot`: 204 tests pass, including retake candidate
  projection/grouping, cut transactions, review queue, UI, audition, IPC, and
  existing caption, EDL, save, and repeated-media playback coverage.
- `npm run test:rust`: 49 tests pass, including model manifest validation,
  malformed data and native serialization.
- Sidecar `unittest` discovery: six retake protocol and validation tests pass.
- `npx tauri build --bundles app`: release application bundle built; its
  `Contents/MacOS` contains the `mlx-sidecar` executable.
- The full sidecar `pytest` suite could not run in this environment because
  `pytest` is absent from its virtual environment and PyPI name resolution is
  unavailable. This is a test-environment limitation, not a passing test.

The local MLX proof of concept used the pinned Apache-2.0 Qwen3-8B 4-bit
model: eight of eight targeted synthetic cases passed. That small set cannot
measure precision or recall on a lecture. The model is downloaded separately,
with SHA-256 checks from `sidecars/mlx-llm/retake-model.json`; it is not part of
the Git tree. The prior bundled-sidecar offline smoke check passed without a
developer Python path.

## Remaining acceptance

The user requested automated tests only and explicitly excluded evaluation
against the supplied lecture video. No representative-video detector metrics,
native listening, save/reopen, MP4 or caption export, or source-file hash check
has been claimed. Use [the manual walkthrough](manual-retakes.md) for those
checks. In particular, mocked playback tests cannot certify audible joins.
