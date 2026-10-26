# Architecture

This document explains how the code maps to the spec at the repo root.

## Layered view

```
┌──────────────────────────────────────────────────────────────────┐
│ React + Tauri webview                                            │
│                                                                  │
│   ┌───────────────────────┐   ┌────────────────────────────────┐ │
│   │ TranscriptEditor      │   │ VideoPreview / Waveform        │ │
│   │ (TipTap + Word/Pause) │◀──┤ (HTML5 <video> + WaveSurfer)   │ │
│   └─────────┬─────────────┘   └────────────┬───────────────────┘ │
│             │                              │                     │
│             ▼                              ▼                     │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │  Zustand stores                                          │   │
│   │    projectStore  — EDL + project metadata                │   │
│   │    playerStore   — playback position, markers, zoom      │   │
│   │    uiStore       — modal state, loaders, toasts          │   │
│   │    jobsStore     — background job mirror from Rust       │   │
│   │  + zundo (50-step undo on projectStore)                  │   │
│   └────────────────┬─────────────────────────────────────────┘   │
└────────────────────┼─────────────────────────────────────────────┘
                     │ Tauri `invoke` / events
                     ▼
┌──────────────────────────────────────────────────────────────────┐
│ Rust backend (src-tauri/)                                        │
│                                                                  │
│   commands/{media,transcribe,project,export,snapshots,llm,       │
│             jobs,misc,pauses}                                    │
│   ├── parse_ffprobe_json  (pure, tested)                         │
│   ├── parse_whisper_json  (pure, tested)                         │
│   └── filter graph builder (pure, tested)                        │
│                                                                  │
│   sidecar processes:                                             │
│     - ffprobe                                                    │
│     - ffmpeg (with VideoToolbox hw encode/decode)                │
│     - whisper-cli (Core ML + Metal, whisper.cpp)                 │
│     - mlx-sidecar (optional on-device LLM, `mlx-sidecar` feat)  │
└──────────────────────────────────────────────────────────────────┘
```

## The EDL contract

Playback tracks the selected segment occurrence separately from native media
time. Reused source ranges have identical media IDs/source times but distinct
output positions. VideoPreview retains the occurrence chosen by output seeking
and advances by timeline order at segment/media end; it must not pick the first
matching source range when processing a native frame or time-update event.

### Transcript correction model and editor (Phases 1–4)

Segments optionally carry versioned `transcript` metadata: occurrence ID,
original word anchors, stable blocks, and editable text runs. Audio remains
defined by `segment.words` and the EDL ranges. `src/lib/transcript.ts` provides
explicit, pure legacy normalization and an output-order projection with display
offsets and source/output timing. The editor and captions consume that projection.
Native save/load and snapshot boundaries validate and preserve overlays.
Project loading never seeds the raw-recognition cache with saved project text.

See [the model design and Phase 2 integration obligations](plans/03-transcript-model-design.md).

`src/lib/transcriptEdits.ts` supplies immutable text replacement, atomic batches,
paragraph split/join, original restoration primitives, and occurrence-scoped
speech cuts. EDL cut/split operations reconcile retained overlays and reject
partial corrected-group cuts. Normalized overlays are materialized at the first
text operation, not merely by opening an old project.

The TipTap document uses stable paragraph IDs and plain text, with projected
decorations for timing groups. Local transactions are validated before entering
the project store. IME composition stays in a draft editor document until it
can be validated; autosave and export see the last valid project. Echoed local
commits update decorations without replacing the document/caret. External
undo/load/cuts rebuild from the model and restore a logical paragraph/offset.
Playback decorations cache their projected block lookup for the current project.

Zundo is the sole committed history: successive typing within 800ms can share
one checkpoint, while explicit cuts/batches/restores are atomic. Delayed history
capture was removed. `src/lib/projectSaves.ts` serializes native writes and
acknowledges only the saved project reference/session, so a late save cannot mark
newer edits or a different opened project clean. Undo/redo recomputes dirty state
against the acknowledged saved revision.

Everything important happens through `Project`:

```ts
type Project = {
  version: 1;
  id: string; name: string;
  createdAt: string; updatedAt: string;
  media: Record<MediaId, SourceMedia>;
  segments: Segment[];              // ORDER MATTERS — this IS the timeline
  settings: { exportPreset; paddingMs };
  chapters?: Chapter[];             // output-timeline chapter markers
  musicTracks?: MusicTrack[];       // audio bed tracks
}
```

**Invariants** (enforced by tests):

1. `Word.start` / `Word.end` are immutable source timecodes.
2. Source timecodes (`sourceIn`, `sourceOut`) refer to the original media file.
3. Deleting a word range splits the affected segment(s) and drops the middle.
4. `paddingMs` is applied at the *boundary* of cuts only — never to the start of
   the first surviving run or the end of the last surviving run.

`tests/edl.test.ts` is the canonical reference. Read it before changing any
EDL operation.

## UI loading pattern

### Project opening

`src/lib/openProject.ts` provides the shared saved-project loader used by the
toolbar Open action, File → Open Project, and drag-and-drop. Project paths are
identified before media import, so `.scribe` directories and their `project.json`
files bypass FFprobe. File → Open Project uses a native directory picker.
The loader restores the project baseline, clears stale pause/playback state,
and records the containing bundle as `filePath`, including when the selected
input was the internal JSON file. Autosave and snapshots therefore continue
to operate on the bundle directory.

### Progress indicators

Every operation that blocks the UI **must** show a progress indicator. The
`uiStore` tracks five loader states:

| Field | Shown when |
|---|---|
| `mediaLoading` | ffprobe probe in progress (import or project open) |
| `transcribeProgress` | whisper-cli transcription running |
| `exportingProgress` | ffmpeg export in progress |
| `modelDownloadProgress` | model .bin/.zip download in progress |
| `editOperationLabel` | any heavy synchronous edit (Trim Silences, etc.) |

For synchronous heavy operations (anything that runs on the JS main thread and
blocks for > 100 ms), use the double-`requestAnimationFrame` deferred pattern
so React renders the dialog before the work starts:

```ts
setEditOperationLabel("Doing X…");
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    try {
      doHeavyWork();
    } finally {
      setEditOperationLabel(null);
    }
  });
});
```

## Transcription engine

YusafCut uses **whisper.cpp** exclusively via the `whisper-cli` sidecar with Core
ML + Metal acceleration. Key CLI flags for timestamp accuracy:

- `--split-on-word` — per-token word boundaries
- `--word-thold 0.01` — keep all tokens even with low probability
- `--max-len 0` — unbounded segment length; prevents timestamp compression drift
- `--best-of 5 --beam-size 5` — beam search for transcript quality

WhisperKit (ANE) was removed in v3.2.0 because quantized models produced
inaccurate word timestamps causing video/text drift. To restore it, run:
`git show 4726d25:src-tauri/src/commands/transcribe.rs`

## Why a single `<video>` element

We chose one `<video>` element driving the source media, with the player
jumping over deleted ranges in `timeupdate`. Browsers seek MP4s in tens of
milliseconds, which satisfies the ~50 ms accuracy target in the spec.

Creating a second `<video>` node when the layout switches from the landing
screen to the editing view would unmount and remount the element, dropping
the loaded source and decoded buffers. The `App` component always renders the
same `<aside>` wrapping the single `VideoPreview` instance and only toggles
CSS classes to move it between the landing and editing layouts.

## Toolbar responsive overflow

The Toolbar uses a `ResizeObserver` on a sentinel element at the right edge of
the left button group. When the toolbar width drops below 860 px the `compact`
state flips to `true`, and each button group renders as a "More ▾" dropdown
(Radix `DropdownMenu`) instead of a flat row of buttons. This keeps all actions
reachable at any window size without hiding any functionality.

## Cross-platform code that isn't

The Tauri shell supports Linux and Windows, but YusafCut explicitly targets
Apple Silicon macOS. The architectural choice rests on whisper.cpp's Core ML +
Metal path and FFmpeg's VideoToolbox. We accept the lock-in for the
performance moat per spec section 1's non-goals.
