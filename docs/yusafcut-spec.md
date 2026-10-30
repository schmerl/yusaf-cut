# YusafCut — Local-First Text-Based Video Editor for Apple Silicon

> **Hand this entire document to Claude Code as the project brief.** It is structured so you can paste it whole, or paste it phase-by-phase as you build.

---

## 1. What we're building

An open-source desktop video editor for macOS (Apple Silicon) where **the transcript IS the timeline**. Correct transcript text directly without changing the recording; explicitly **Cut speech** to remove the corresponding audio/video. Review filler occurrences individually, listen to a proposed cut, and choose whether to keep the sound, hide its text, or cut it. Reorder paragraphs, the video reorders. Everything runs **100% locally** using the Mac's CPU/GPU/Neural Engine — no cloud, no telemetry, no API keys required.

This document includes the implemented manual transcript-correction and filler-review workflows. The original build phases remain as project history; the behavior specified below supersedes their earlier text-deletion and bulk-filler designs. Detailed requirements and acceptance records are linked from the relevant sections.

**Product name (working):** YusafCut
**License:** AGPL-3.0 (or MIT — decide before first public release)
**Target user:** Podcasters, YouTubers, course creators, journalists, anyone who edits talking-head or interview video.

### Core value proposition

- **Edit video like a Google Doc.** The transcript is the primary editing surface.
- **Fully local.** Works on a plane. Your footage never leaves your machine.
- **Apple Silicon native.** Whisper runs via whisper.cpp with Core ML + Metal. LLM features use MLX. Video uses VideoToolbox hardware encode/decode.
- **Open source.** Anyone can audit, fork, or self-host.

### Explicit non-goals (v1)

- No multi-camera / multi-track NLE features (Premiere/Resolve territory).
- No color grading, no VFX, no motion graphics.
- No Windows / Linux build for v1 (Apple Silicon optimization is the moat).
- No collaboration / cloud sync.
- No mobile app.

---

## 2. Tech stack (locked decisions)

| Layer | Choice | Why |
|---|---|---|
| Shell | **Tauri 2.x** | Native macOS feel, small binary, Rust core, web frontend. Lighter than Electron. |
| Frontend | **React + TypeScript + Vite** | Standard, fast, good ecosystem for the transcript UI. |
| UI components | **shadcn/ui + Tailwind CSS** | Composable, themeable, ships nothing you don't use. |
| Transcript editor | **TipTap (ProseMirror)** | Battle-tested rich-text editor; perfect fit for word-timestamp metadata on nodes. |
| State | **Zustand** | Minimal, no boilerplate, works great with undo middleware. |
| Backend (in-process) | **Rust** (Tauri commands) | FFI to whisper.cpp, FFmpeg, MLX via sidecar. |
| Transcription | **whisper.cpp** with Core ML + Metal | Fastest local Whisper on Apple Silicon. |
| Video processing | **FFmpeg** with VideoToolbox | Hardware H.264/HEVC encode/decode. |
| Local LLM (optional) | **MLX (Python sidecar)** or **llama.cpp** | MLX is Apple-native; llama.cpp is more portable. Start with MLX. |
| Player | **HTML5 `<video>`** driven by an EDL | Simpler than embedding AVPlayer; good enough for v1. Re-evaluate for v2. |
| Waveform | **WaveSurfer.js** | Mature, performant, integrates with our timestamp model. |
| Packaging | **Tauri bundler** → `.dmg` | Universal binary, code-signed, notarized. |

### Project layout

```
yusafcut/
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands/       # Tauri command handlers
│   │   ├── transcribe.rs   # whisper.cpp FFI
│   │   ├── media.rs        # FFmpeg wrapper
│   │   ├── edl.rs          # Edit Decision List logic
│   │   ├── project.rs      # Project file I/O
│   │   └── llm.rs          # Sidecar process management
│   ├── binaries/           # Bundled whisper-cli, ffmpeg, mlx-sidecar
│   └── Cargo.toml
├── src/                    # React frontend
│   ├── components/
│   │   ├── TranscriptEditor/
│   │   ├── VideoPreview/
│   │   ├── Waveform/
│   │   ├── Toolbar/
│   │   └── ui/             # shadcn components
│   ├── stores/             # Zustand stores
│   ├── lib/
│   │   ├── edl.ts          # EDL types & helpers
│   │   ├── ipc.ts          # Tauri invoke wrappers
│   │   └── timecode.ts
│   ├── App.tsx
│   └── main.tsx
├── sidecars/
│   └── mlx-llm/            # Python MLX sidecar (packaged as binary)
├── docs/
├── tests/
└── package.json
```

---

## 3. The Edit Decision List (EDL) — central data model

Everything in the editor is a thin layer over a single immutable data structure: the **EDL**. Get this right and the rest is plumbing.

```ts
// src/lib/edl.ts

export type MediaId = string; // UUID for an imported source file

export interface SourceMedia {
  id: MediaId;
  path: string;              // absolute path on disk
  duration: number;          // seconds
  fps: number;
  width: number;
  height: number;
  audioSampleRate: number;
  sha256: string;            // for project integrity
}

export interface Word {
  id: string;                // stable UUID — survives edits
  text: string;
  start: number;             // seconds, relative to source media
  end: number;
  confidence: number;        // 0..1 from Whisper
  speaker?: string;          // optional speaker label
}

export interface Segment {
  id: string;
  mediaId: MediaId;
  words: Word[];             // source timing anchors, not corrected display text
  // Explicit ranges govern playback/duration, independently of displayed text.
  // They support trimming beyond word boundaries and wordless retained edges.
  sourceIn: number;
  sourceOut: number;
  transcript?: TranscriptMetadata; // versioned display runs, originals, anchor mappings
  occurrenceLineage?: string; // stable across splits; distinct for repeated placements
  precise?: boolean;         // honor exact EDL edges in export, without added padding
  fillerAudio?: FillerAudio; // provenance for wordless retained filler-edge audio
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  media: Record<MediaId, SourceMedia>;
  segments: Segment[];       // ORDER MATTERS — this is the timeline
  fillerReview?: FillerReviewMetadata; // versioned detection policy and review decisions
  settings: {
    exportPreset: "youtube-1080p" | "podcast-audio" | "custom";
    paddingMs: number;       // default audio padding around cuts, e.g. 80ms
  };
}
```

### Key invariants

1. **Recognition anchors are immutable during editing.** Corrected display text lives in an occurrence-scoped transcript overlay; ordinary text deletion hides text while retaining its audio anchors. Explicit speech cuts remove source ranges. Text corrections never rewrite word `start`/`end` values.
2. **Source timecodes are immutable.** A word's `start`/`end` always refers to the original source media. The "output" timeline is derived by concatenating segments in order.
3. **Segments are the unit of cut.** Explicitly cutting speech splits surviving source ranges and removes the selected interval. Duration derives from segment ranges, not displayed word counts; wordless retained audio edges can survive a filler cut.
4. **All edits are project transformations.** Text corrections change transcript metadata; speech cuts change the EDL. Source media is never modified. Preview may render temporary derived clips before final export.
5. **Repeated placements are independent.** Correcting or reviewing one occurrence of reused media must not change another occurrence. Playback, highlighting, and review decisions use occurrence identity as well as source time.

The schema above is an excerpt. `TranscriptMetadata` stores versioned blocks/runs,
original recognized words (including text-hidden words), and anchor associations;
a corrected phrase may share one timing group. `FillerReviewMetadata` stores the
detection policy and occurrence-specific Keep/text-removal decisions. Skip and
audition settings are session state. Full types live in `src/lib/edl.ts`,
`src/lib/transcript.ts`, `src/lib/fillerReview.ts`, and `src/lib/fillerActions.ts`.
Optional metadata round-trips through native save/load and snapshots while the
outer project format remains version 1. Older projects load without manual
migration; unsupported metadata versions are rejected, and older app binaries
may discard the new fields on save.

### Derived: output timeline

```ts
// Pure function — given an EDL, compute the output time of each word
export function computeTimeline(project: Project): TimelineEntry[] {
  let outputCursor = 0;
  const result: TimelineEntry[] = [];
  for (const seg of project.segments) {
    const segDuration = seg.sourceOut - seg.sourceIn;
    result.push({
      segmentId: seg.id,
      mediaId: seg.mediaId,
      sourceIn: seg.sourceIn,
      sourceOut: seg.sourceOut,
      outputStart: outputCursor,
      outputEnd: outputCursor + segDuration,
    });
    outputCursor += segDuration;
  }
  return result;
}
```

---

## 4. MVP scope (Phase 1 — ship in ~4–6 weeks of focused work)

**Definition of MVP:** A single user can open a `.mp4`, get a transcript, explicitly cut speech, preview the cut, and export a new `.mp4`. The implemented editor also supports text-only corrections and individual filler review as described below.

### MVP feature list

- [ ] Open a single video file (`.mp4`, `.mov`)
- [ ] Transcribe with Whisper (`large-v3-turbo` default, model picker in settings)
- [ ] Display transcript with word-level highlighting synced to playback
- [ ] Click places the caret; Cmd-click seeks to the word/phrase's output position
- [ ] Type, paste, or delete transcript text without changing audio/video
- [ ] Select words or whole timing groups → Cut speech → preview reflects cut
- [ ] Review fillers individually with before/preview/result playback and independent text/audio choices
- [ ] Undo / redo (50 steps)
- [ ] Save / load project file (`.scribe` — JSON + media references)
- [ ] Export cut video as `.mp4` (H.264, AAC, hardware-accelerated)
- [ ] First-run flow: download Whisper model on demand, show progress

### Out of MVP scope (Phase 2+)

- Multiple source files / multi-clip projects
- Speaker diarization
- LLM-powered editing ("cut this to 90 seconds", "remove tangents")
- Subtitle/caption export (SRT, VTT)
- Custom export presets
- Reorder paragraphs by drag
- B-roll / overlay tracks

Manual transcript correction, contextual find/replace, original-text restoration,
and filler review have since been implemented; they are no longer deferred items.

---

## 5. Build plan — phase by phase

### Phase 0 — Project scaffolding (Day 1)

**Goal:** Empty Tauri app launches, shows "Hello YusafCut", builds to a `.dmg`.

Tasks for Claude Code:
1. `npm create tauri-app@latest yusafcut` — React + TypeScript template.
2. Add Tailwind, shadcn/ui, Zustand, TipTap, WaveSurfer.js.
3. Configure `tauri.conf.json` for macOS-only build, set bundle identifier `dev.yusafcut.app`.
4. Set up `pnpm` (preferred) or `npm` scripts: `dev`, `build`, `lint`, `test`.
5. Add Vitest + React Testing Library.
6. Add Rust test scaffolding (`cargo test` working).
7. Set up GitHub Actions CI: lint, typecheck, test, build (don't sign yet).
8. Write a one-page `CONTRIBUTING.md`.

**Acceptance:** `pnpm tauri dev` launches a window. `pnpm tauri build` produces an unsigned `.app`.

---

### Phase 1 — Media import + FFprobe (Day 2–3)

**Goal:** User drags a video in, we extract metadata and show it.

Tasks:
1. Bundle a static `ffmpeg` and `ffprobe` binary for `arm64-apple-darwin` into `src-tauri/binaries/`. Use the Tauri "external binary" pattern with the `-aarch64-apple-darwin` suffix so they ship correctly.
2. Rust command `import_media(path) -> SourceMedia`:
   - Run `ffprobe -v error -print_format json -show_format -show_streams`.
   - Parse duration, fps, dimensions, audio sample rate.
   - Compute SHA-256 of file (streaming, don't load into memory).
   - Return `SourceMedia` struct.
3. Frontend: drag-and-drop zone, file picker, recent-files list (stored in Tauri's `appDataDir`).
4. Show imported media info in a sidebar.

**Acceptance:** Drag in `test.mp4`, see filename, duration, resolution displayed correctly.

---

### Phase 2 — Whisper transcription pipeline (Day 4–8)

**This is the hardest phase. Get it right.**

**Goal:** Click "Transcribe" → see progress → get word-level JSON back.

Tasks:
1. **Bundle whisper.cpp.** Build `whisper-cli` from source with Core ML and Metal flags:
   ```
   WHISPER_COREML=1 WHISPER_METAL=1 make -j
   ```
   Ship the binary in `src-tauri/binaries/`. Also ship the Core ML model conversion script.

2. **Model management.** On first transcribe:
   - Show model picker: `tiny`, `base`, `small`, `medium`, `large-v3-turbo` (default).
   - Download from Hugging Face: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin`.
   - Also download the Core ML companion: `ggml-{model}-encoder.mlmodelc.zip`, unzip.
   - Store in `~/Library/Application Support/dev.yusafcut.app/models/`.
   - Show download progress, support resume, verify SHA-256.

3. **Audio extraction.** Before transcribing, extract 16kHz mono WAV from the video:
   ```
   ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le tmp.wav
   ```

4. **Run whisper-cli** with word-level timestamps:
   ```
   whisper-cli -m model.bin -f tmp.wav --output-json-full --word-thold 0.01 -ml 1
   ```
   `-ml 1` forces max 1 token per segment (gives word-level segments). Parse the JSON.

5. **Stream progress.** whisper-cli writes progress to stderr — parse lines like `[00:00:30.000 --> 00:00:32.500]` and emit Tauri events to the frontend so the UI can show a progress bar.

6. **Convert to our `Word[]` schema.** Generate stable UUIDs. Drop tokens that are pure whitespace/punctuation artifacts.

7. **Build initial EDL.** One segment containing all words, `sourceIn=0`, `sourceOut=duration`.

**Acceptance:** Transcribe a 5-minute video, get accurate word-level JSON, total time under 60 seconds on M2 Pro with `large-v3-turbo`.

**Gotchas:**
- Core ML model conversion happens once at first-load and takes 30–60s — show a "Optimizing model for your Mac" message.
- whisper.cpp's word timestamps are approximate. Don't promise frame-accuracy; promise ~50ms accuracy.
- Some users will have files in formats ffmpeg can't decode without extra codecs — catch and show a friendly error.

---

### Phase 3 — Transcript editor UI (Day 9–14)

**Goal:** Edit transcript text directly, with playback-linked highlighting and explicit speech cuts.

Tasks:
1. **TipTap setup with timed transcript runs.** Project display runs into editable inline nodes inside paragraphs, retaining associations to immutable source word anchors. A corrected phrase may map to several original words as one timing group.
2. **Render strategy.** Paragraphs are grouped by speaker (later) or by sentence-end punctuation + pause heuristics (now). A pause > 750ms starts a new paragraph.
3. **Playback sync.** Subscribe to `<video>` `timeupdate`. Find the word whose `[start, end]` brackets `currentTime`. Add a CSS class `is-playing` to that word. Smooth-scroll if it goes off-screen.
4. **Caret and seeking.** Click places the caret. Cmd-click seeks to the word/timing group's start in the selected output occurrence without changing playing/paused state. Ordinary selection and typing must not seek.
5. **Selection.** Standard text selection works because TipTap is just contenteditable underneath. Track which words are selected via ProseMirror's selection state.
6. **Recognition styling.** Low recognition confidence can mark original recognition for review; it must not be presented as confidence in user-authored text. Vocal filler highlighting follows the shared policy in section 6.1.

#### Editable transcript behavior

- Editing is enabled by default. Type, paste plain text, correct capitalization/punctuation, or replace phrases with different word counts. Delete/Backspace and Cmd-X remove text only; audio, source ranges, playback order, and output duration stay unchanged.
- A replacement such as “item potency” → “idempotency” shares the original phrase's timing span. Highlight and seek the group together; do not invent exact timestamps for newly displayed words or bridge an existing audio cut.
- Text-hidden words remain audible and recoverable from original-text metadata, but are omitted from transcript display and captions. A paragraph retaining speech must retain non-whitespace text; reject invalid deletion/replacement atomically without saving an empty spoken paragraph.
- Space and J/K/L type normally while editing. Paste strips external formatting/node attributes. Selection, caret, input-method composition, and autosave must remain stable. Project history owns undo/redo, with useful typing groups and atomic replacements/cuts.
- Find/replace searches literal words or phrases within projected paragraphs, including corrected groups. Provide previous/next navigation, current-match highlighting, case sensitivity, whole-word matching, Replace current, and atomic Replace all. Partial matching is the default: emphasize the exact substring and lightly shade its containing token; replacement changes only the exact match. Do not match across removed speech or silently apply a partial invalid batch.
- Selected timing groups or whole paragraphs expose original recognized text and **Restore original text**. Restoration is undoable and survives save/reopen, recovers hidden text, and preserves unrelated corrections and subsequent audio cuts. Legacy projects use their available loaded transcript as the original baseline.
- Before re-transcription replaces corrections, offer **Cancel**, **Proceed**, and **Snapshot first**. Snapshot first saves the current revision before snapshotting; cancellation or save/snapshot failure stops replacement. Stage results for all requested clips before a guarded commit. Failure, concurrent edits, or project switches leave existing corrections intact. Success replaces the affected recognition baseline while preserving surviving audio ranges and unaffected corrections, and resets session undo; snapshots provide persistent recovery.

**Acceptance:** Correct a phrase, hide a word, find/replace a contextual occurrence,
and restore original text without changing duration. Cmd-click seeks the correct
reused-media occurrence. Explicit whole-group cuts shorten the timeline; partial
group cuts are rejected. Save/reopen, snapshots, and SRT/VTT preserve corrections
and their timing associations.

See [manual correction requirements](requirements/03-transcript-corrections.md),
[model design](plans/03-transcript-model-design.md), and
[acceptance evidence and remaining native checks](transcript-correction-acceptance.md).

---

### Phase 4 — The actual editing (Day 15–18)

**Goal:** Explicitly cut selected speech → video plays without that part.

Tasks:
1. **Explicit Cut speech operation.** When the user invokes **Cut speech** or **Cmd-Shift-X** with selected words or complete corrected timing groups:
   - Find the segment(s) containing the selected words.
   - Split each affected segment at the selection boundaries (creating up to 3 segments per original).
   - Remove the middle segment(s) — the ones fully inside the selection.
   - Apply `paddingMs` (default 80ms) — keep that much audio before/after each surviving segment edge to avoid clipped consonants.
   - Recompute output timeline.
   - Reject partial corrected timing groups rather than expanding the cut silently. A whole-paragraph cut includes surviving anchors whose text was previously hidden. Ordinary Delete/Backspace/Cmd-X remain text-only.
   - Filler-review cuts use the exact validated proposal in section 6.1, without the ordinary cut's additional padding.
2. **Player playback over the EDL.** This is subtle. Options:
   - **Option A (chosen for MVP):** Use a single `<video>` element. On `timeupdate`, check if `currentTime` is inside a "deleted" range; if so, jump to the next surviving segment's `sourceIn`. Coarse but works.
   - **Rendered filler auditions (implemented):** Before/Preview/Result use a short locally rendered continuous clip. Render preparation may take time, but internal joins must not introduce source-seek pauses. The main source player remains paused during audition.
3. **Undo/redo.** Wrap the Zustand store with an undo middleware (e.g. `zundo`). Snapshot the EDL on every edit. Cap at 50 steps.
4. **Visual feedback and recovery.** Text-only deletions disappear from displayed text/captions while their anchors remain. Explicit speech cuts remove the selected speech from the edited timeline. Undo restores a cut; restoring original text alone must not restore cut audio.

**Acceptance:** Explicitly cut a sentence, hit play, and hear the shortened edit. Undo brings it back. Deleting the sentence's text alone must not remove audio and is rejected if it would empty a spoken paragraph.

**Critical:** The transcript view and the video view must never drift out of sync. The single source of truth is the EDL.

---

### Phase 5 — Project save/load (Day 19–20)

Save/load and snapshots preserve the transcript overlays, originals, hidden text,
timing groups, precise cut boundaries, retained filler-edge provenance, and
project-level filler detection/review metadata described in sections 3, Phase 3,
and 6.1. Autosave writes are serialized and revision/session checked: an older
write cannot clear newer edits or overwrite a different project's state. Review
navigation, listening, and uncommitted boundary estimates do not dirty the project.

Saved `.scribe` projects are directories. **File → Open Project** selects a
directory, while the toolbar's **Open** action and drag-and-drop also recognize
the internal `project.json` file. These inputs use the project loader rather
than the media importer. Loading from the JSON retains the containing directory
as the project's save/snapshot path.

**Goal:** Quit the app, come back, pick up exactly where you left off.

Tasks:
1. **`.scribe` file format.** A folder (presented as a single file via macOS bundle, like `.app`) containing:
   ```
   MyProject.scribe/
   ├── project.json        # the Project struct
   ├── transcripts/        # raw whisper output per media
   └── media-refs.json     # original paths + SHA-256 for relinking
   ```
2. **Don't copy media into the project.** Reference by absolute path. If the file moves, show a "relink media" dialog using SHA-256 to confirm matches.
3. **Auto-save.** Every 30 seconds + on every edit (debounced 2s). Write atomically (write to `.tmp`, then rename).
4. **Recent files menu.** Standard macOS recent items.

**Acceptance:** Edit a project, quit, reopen, every edit is preserved.

---

### Phase 6 — Export (Day 21–24)

**Goal:** Render the EDL to a final `.mp4`.

Tasks:
1. **Generate the FFmpeg render graph from surviving ranges.** Trim each segment to its EDL interval. Concatenate audio independently and place video frames on the edited output timeline so frame rounding cannot pad each audio join with silence. Support audio-only ranges and retained filler edges.
2. **Hardware-accelerated encode:**
   ```
   ffmpeg -hwaccel videotoolbox \
     [inputs and concat filter] \
     -c:v h264_videotoolbox -b:v 8M \
     -c:a aac -b:a 192k \
     -movflags +faststart \
     output.mp4
   ```
3. **Progress.** Parse ffmpeg's `out_time_ms=` from `-progress pipe:1`. Emit Tauri events. Show a progress bar with ETA.
4. **Cancellation.** Send SIGTERM to the ffmpeg child process.
5. **Export presets.**
   - **YouTube 1080p:** H.264, 8 Mbps, AAC 192k, faststart.
   - **Podcast audio:** strip video, AAC 128k, output `.m4a`.
   - **Custom:** expose bitrate, codec.

**Acceptance:** Export a 5-minute edit, get a clean `.mp4` that plays in QuickTime, takes under 30s on M2 Pro.

For precise filler cuts, honor the accepted boundaries without adding a second
padding pass or rounding outward to keyframes. Export must remove the same source
content as Preview cut/Play result and shorten the timeline by the accepted
interval. Audio sample timing and video frame timing can differ by their natural
sample/frame resolution; that must not accumulate into inserted silence at joins.
Exact cuts bypass smart-copy paths that would change their boundaries.

**Critical:** Use stream-copy (`-c copy`) when no re-encoding is needed (e.g. cuts on keyframes only) — drops export time to seconds. For frame-accurate cuts, you must re-encode the cut boundaries; do a "smart cut" where most of the video is copied and only the few seconds around each cut are re-encoded. This is the killer feature for export speed. Implement re-encode-all for v1, smart-cut for v1.1.

---

### Phase 7 — Polish for MVP release (Day 25–30)

- [ ] App icon, About dialog, version info
- [ ] Keyboard shortcuts: Space (play/pause), J/K/L (transport) outside text editing; Cmd+Z/Shift+Cmd+Z (undo/redo), Cmd+S (save), Cmd+E (export), Cmd-Shift-X (Cut speech). Within the transcript, Space/J/K/L type text and Delete/Backspace/Cmd-X edit text only.
- [ ] Dark mode (follow system)
- [ ] Error boundaries — never show a white screen of death
- [ ] Crash reporter (local file only — no telemetry)
- [ ] First-run onboarding: 30-second tour with a sample video
- [ ] Code-sign with Developer ID, notarize, staple
- [ ] DMG with background image and Applications symlink
- [ ] Auto-update via Tauri's updater (signed manifest hosted on GitHub Releases)
- [ ] README with screenshot, install instructions, build-from-source instructions
- [ ] CHANGELOG.md, SECURITY.md, CODE_OF_CONDUCT.md

---

## 6. Phase 2 features (post-MVP, prioritized)

The filler-review and caption workflows below have been implemented. Other
entries retain their original planning scope; detailed acceptance records take
precedence over the original effort estimates.

### 6.1 Individual filler review and cut preview

**Goal:** Review audible filler occurrences individually and choose independently
whether to retain their transcript text and their recorded speech. This replaces
the earlier bulk “remove all” filler design; a candidate is not a recommendation
to delete the word.

#### Detection and navigation

- Use one matching policy for transcript highlighting, review candidates, and counts. Highlight vocal fillers by default, including bracketed recognition such as `[AH]`, `[UM]`, and `[UH]`, with case/punctuation normalization for matching while preserving the displayed spelling.
- Offer selectable built-in terms and custom literal words/phrases. Ordinary words such as “like” and discourse phrases require explicit opt-in. Prefer longer overlapping phrase matches rather than duplicate candidates. Store detection choices in the project.
- **Review fillers** opens a panel alongside the transcript, accessible from the transcript toolbar, Toolbox, and Search. Show the current occurrence, neighboring transcript context, source/output times, and queue position in playback order. Highlight the active occurrence in the editor.
- Include fillers hidden by text-only corrections when their audio survives; label them **Text removed, audio retained**. Provide **Unreviewed**, **Kept**, **Audio retained**, and **All** filters. Resolved text-only decisions leave the default unresolved queue.
- Keep decisions occurrence-specific, including repeated placements of the same media. Reconcile candidate identity after edits, splits, undo/redo, recognition replacement, and reload; stale candidates must not affect another source interval.

#### Decisions and recovery

| Action | Transcript/captions | Audio/video and duration | Review behavior |
|---|---|---|---|
| **Keep** | Preserve current text | Preserve audio and duration | Persist the decision; revisit through Kept |
| **Remove text only** | Hide this candidate's text | Preserve audio and duration | Revisit through Audio retained |
| **Cut filler speech** | Remove all of this candidate's text | Remove the validated source interval and shorten the timeline | Keep the accepted item available for result playback and undo |
| **Skip** | Unchanged | Unchanged | Defer for this session and move to another occurrence |

Keep, text removal, and cuts are individually undoable and do not automatically
advance. Previous/Next navigation is explicit. Keep and text-removal decisions
survive save/reopen; Skip resets between sessions. **Undo this decision** reverses
the current decision when its history is still applicable. To revise an accepted
cut, undo it, adjust its boundaries, then preview and accept again.

Reject text removal that would leave a spoken paragraph empty. If a correction
groups a filler with neighboring speech, allow listening and Keep/Skip but disable
an isolated filler cut; never silently enlarge it to remove the neighboring words.

#### Listening and boundary adjustment

- Playback is explicit: **Play before**, **Preview cut**, **Play result**, and **Stop**. Before and Preview use the same surrounding material; Preview leaves the project unchanged, and Result auditions the accepted edit. Provide adjustable context (initially two seconds each side) and optional looping (initially off); these are session settings.
- Prepare bounded local audition clips and play continuously through internal joins. Preparation can show progress, but source-seeking delays must not become gaps in the audition. Pause/isolate the main source player. Stop, navigation, project edits/switches, and superseding requests must prevent stale clips or delayed playback events from starting.
- Put playback above an initially collapsed **Adjust cut boundaries** section. Show a compact removed-duration readout; a round information icon opens recognition timing, neighboring-word limits, and estimation details. Avoid a persistent short-span warning or verbose timing diagnostics in the main card.
- Adjust Start and End independently in milliseconds, with ±10 ms nudges. Negative Start removes earlier sound; positive Start retains the leading edge. Positive End removes more trailing sound; negative End retains the trailing edge. Show the proposed source range and validate it before preview/acceptance.
- Bound adjustments by the previous token's end, next token's start (including text-hidden anchors), and existing EDL edges. Reject neighboring-word overlap, crossing an existing cut, an empty range, or an unsafe corrected-group cut.
- Very short recognition spans (40 ms or less) or uncertain timing trigger a local audio-activity estimate. Search near the occurrence within those neighbor/edit limits; estimate the audible burst rather than removing the entire inter-word gap. This is a conservative acoustic heuristic, not phonetic alignment. Ambiguous audio leaves manual adjustment available.
- **Estimate audio** requests an estimate for other occurrences; **Original timing** restores zero offsets relative to recognition. Manual changes take precedence over delayed estimates. Recognition anchors remain unchanged. Estimation, adjustment, and preview do not commit a project edit.
- Preview and acceptance use the same validated cut proposal. Remove the chosen interval rather than muting it; duration must decrease. If adjusted boundaries retain filler edges, preserve their audio/video while removing all candidate text. Carry exact boundaries and retained-edge provenance through save/snapshots/export, without adding ordinary cut padding again.

**Acceptance:** Compare Before, Preview, and Result for a normal filler and a
very short recognized token. Verify the audible filler is removed from the chosen
interval, duration shortens, and the continuous join matches export without
inserted silence. Verify text-only removal retains the sound, decisions affect
only one occurrence, undo recovers it, and Keep persists while Skip resets.
Exercise hidden fillers, grouped corrections, neighbor limits, and stale playback.

See [filler-review requirements](requirements/05-filler-review.md),
[implementation plan and automated evidence](plans/05-filler-review.md),
[hands-on checkpoint](filler-review-checkpoint.md), and
[native acceptance checklist](manual-filler-review.md). User hands-on feedback has
refined this workflow; outstanding native listening/export checks remain recorded
in the checklist rather than implied complete here.

### 6.2 Speaker diarization

Use `pyannote-audio` via a Python sidecar, or `whisper-diarization` which combines Whisper + pyannote. Annotate each word with `speaker`. Color-code paragraphs by speaker. Allow renaming speakers.

### 6.3 Local LLM editing (the headline feature)

**MLX sidecar.** Bundle a Python sidecar using PyInstaller that loads an MLX model (start with `mlx-community/Llama-3.2-3B-Instruct-4bit` — small, fast, runs on 8GB Macs).

Commands the LLM can produce (structured output via JSON schema):
- `cut_to_duration(targetSeconds)` — pick which segments to keep to hit a target.
- `remove_tangents()` — identify off-topic asides.
- `find_quote(description)` — locate a specific moment by meaning.
- `summarize_chapters()` — generate chapter markers.

The LLM never edits directly. It returns a list of `wordId` ranges to delete, which the user reviews and accepts. **Human in the loop, always.**

### 6.4 Caption / subtitle export

The **Captions** button beside **Export .mp4** exports SRT or VTT separately
through a native save dialog. Captions are generated from the post-edit EDL,
mapping source timestamps to output time with `computeTimeline()` and grouping
words into readable cues. The main-window capability grants
`fs:allow-write-text-file`; the dialog grants access to the selected destination.
See [the caption export requirements](requirements/01-caption-export.md).

### 6.5 Multi-clip projects

Allow multiple source videos in one project. Reorder via drag in a clip-bin. Each clip has its own transcript. The output timeline concatenates segments across clips.

### 6.6 Reorder by drag

Let users grab a paragraph and drop it elsewhere in the transcript. This rearranges segments in the EDL. Trivial once the segment model is solid — UX is the hard part.

### 6.7 Smart-cut export

As described in Phase 6 — copy most of the stream, only re-encode the few seconds around each cut. Use `ffmpeg`'s `-c copy` with careful keyframe detection (`ffprobe -select_streams v -show_frames`).

---

## 7. Risks and how to handle them

| Risk | Likelihood | Mitigation |
|---|---|---|
| Whisper accuracy too low on accented speech | Medium | Allow direct text correction; warn before re-transcription replaces corrections and offer Snapshot first for recovery. |
| Word timestamps drift on long files | Medium | Re-anchor to forced-alignment in v2 (use `whisperX`-style approach with `wav2vec2` for alignment). |
| Export quality degrades vs original | Low | Default to high bitrate (8 Mbps for 1080p); show bitrate in export dialog. |
| Tauri sidecar process management gets gnarly | Medium | Use Tauri 2's `Command` API; ensure children die when app quits (`kill_on_drop`). |
| Bundle size explodes with models | High | Don't bundle models. Download on demand. Show sizes upfront. |
| Code signing / notarization breaks builds | Certain | Set up signing in CI early (Phase 0), not late. |
| User has Intel Mac | Low | Show a clear "Apple Silicon required" message on launch. Universal binary is possible but not worth the perf hit. |

---

## 8. Testing strategy

- **Unit tests (Vitest):** EDL operations (split, merge, delete, undo). Pure functions, 100% coverage target.
- **Unit tests (Rust):** FFprobe parser, EDL serialization, Whisper JSON parser.
- **Transcript corrections:** Verify text-only editing leaves source ranges/duration unchanged; whole-group cuts, nonempty paragraphs, literal phrase replacement, restoration, save races, and re-transcription failure/staleness. Round-trip overlays/originals through native project save and snapshots; captions must use corrected display text on the edited timeline.
- **Filler review:** Verify shared matching, hidden/repeated occurrences, decision reconciliation, atomic undo, exact proposals/neighbor guards, editable estimates, and stale playback cancellation. Use headless FFmpeg content and duration checks to distinguish Before from Preview and detect silence introduced at joins, including cuts shorter than a frame.
- **Integration tests:** A 30-second test video committed to the repo (creative-commons sample). Tests run the full pipeline: import → transcribe → edit → export → verify output duration.
- **E2E (manual checklist for now):** Open app, import, transcribe, correct text, explicitly cut speech, and export. Document in `docs/manual-test.md`.
- **Native acceptance:** Use [transcript correction checks](manual-transcript-corrections.md) and [filler review checks](manual-filler-review.md) for caret/IME behavior, layout, real-speech listening, and Preview/Result/export comparisons. Automated tests do not establish perceptual speech alignment; record performed checks separately from pending ones.
- **Performance tests:** Track transcribe-time-per-minute-of-audio and export-time-per-minute across CI runs (M-series GitHub runner once available, else local).

---

## 9. Open questions to resolve before Phase 1

1. **License.** AGPL-3.0 (copyleft, protects against closed-source forks) or MIT (maximum adoption)? Recommendation: **AGPL-3.0** for the app, MIT for any reusable libraries we split out.
2. **Telemetry.** None in v1. Decide later whether to add opt-in crash reports.
3. **Name.** "YusafCut" works but check trademark conflicts in the macOS App Store and video software space before launch.
4. **Distribution.** Direct download from GitHub Releases is fine for v1. Mac App Store distribution is more work (sandboxing constraints around sidecars).
5. **Funding model.** Pure FOSS? GitHub Sponsors? "Pro" features (cloud sync, team features) as a separate paid tier later? Decide before community traction makes the choice for you.

---

## 10. First commands for Claude Code

When you start, run these in order:

```bash
# 1. Scaffold
pnpm create tauri-app@latest yusafcut --template react-ts
cd yusafcut

# 2. Core dependencies
pnpm add zustand zundo @tiptap/react @tiptap/pm @tiptap/starter-kit \
  wavesurfer.js @radix-ui/react-slot class-variance-authority clsx tailwind-merge

# 3. Dev dependencies
pnpm add -D tailwindcss @tailwindcss/typography postcss autoprefixer \
  vitest @testing-library/react @testing-library/jest-dom @types/node

# 4. Tailwind init
pnpm tailwindcss init -p

# 5. shadcn/ui
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button dialog progress slider toast

# 6. Tauri sidecar binaries directory
mkdir -p src-tauri/binaries

# 7. Confirm it builds
pnpm tauri dev
```

Then start on **Phase 0** above.

---

## 11. How to use this document with Claude Code

- **Paste sections 1–3 first** as the project context.
- **Then paste Phase 0** and let Claude Code complete it before moving on.
- **Review each phase's "Acceptance" criterion** before starting the next.
- When stuck, paste section 7 (Risks) — many problems are anticipated there.
- This document is the spec, not the implementation. Push back on Claude Code if it suggests deviations from the architecture without justification.

---

**End of spec.** Ship it.
