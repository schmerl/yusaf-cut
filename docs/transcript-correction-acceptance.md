# Transcript corrections acceptance audit — 4.7.0

Requirements: [feature 3](requirements/03-transcript-corrections.md).
Implementation: [phased plan](plans/03-transcript-corrections.md).

## Automated release checks

- 171 frontend tests pass in 16 files (`npm test`).
- `npm run check` passes (TypeScript and ESLint).
- 46 native library tests pass (`cargo test --lib --locked --offline`), including
  native project/snapshot correction-metadata round trips.
- Native release app build: `npm run tauri:build -- --bundles app -- --offline --locked`.
  Output: `src-tauri/target/release/bundle/macos/YusafCut.app`.
- Build warnings concern the existing `.app` bundle identifier suffix and large
  frontend chunk. No Python/MLX dependency installation or model download is
  required for these checks.

## Acceptance evidence

The table covers the acceptance criteria and additional integrity gates. Tests
use real ProseMirror transactions and controlled async native mocks; they do not
establish perceptual synchronization or real recognition accuracy. The user
confirmed the Phase 4 native checklist in 4.5.1 and Phase 5 checklist in 4.6.0.
The final walkthrough has a separate record below.

| Accepted behavior | Automated evidence | Native evidence |
|---|---|---|
| Editable immediately on open | `transcriptEditor.test.tsx`, `openProject.test.tsx` | User Phase 4 pass |
| Capitalization/punctuation preserve source ranges, duration and cuts | `transcriptEdits.test.ts`, `transcriptSearch.test.ts`, `edl.test.ts` | User Phase 4 pass |
| Phrase merge/expansion with shared timing and unchanged surrounding words | `transcript.test.ts`, `transcriptEdits.test.ts`, `captions.test.ts` | User Phase 4 pass |
| Text-only deletion retains audio and hides caption text | `transcriptEdits.test.ts`, `captions.test.ts` | User Phases 4–5 pass |
| Empty spoken paragraph rejected for typing, paste/cut and batch replacement | `transcriptEditor.test.tsx`, `transcriptEdits.test.ts`, `transcriptSearchUI.test.tsx` | User Phases 4–5 pass |
| Typing, plain paste, selection, IME, caret, undo/redo and safe shortcuts | `transcriptEditor.test.tsx`, `transcriptAutosave.test.tsx` | User Phase 4 pass |
| Click positions caret; Cmd-click preserves playing/paused state | `transcriptEditor.test.tsx`, `videoOccurrence.test.tsx` | User 4.5.1 timing retest pass |
| Explicit ordinary/group/paragraph cuts are occurrence-scoped and undo atomically | `transcriptEdits.test.ts`, `transcriptEditor.test.tsx` | User Phase 4 pass |
| Partial timing-group speech cuts reject rather than expand | `transcriptEdits.test.ts`, `transcriptEditor.test.tsx` | User Phases 4–5 pass |
| Phrase find across records/groups, current/next/previous, options, literal punctuation | `transcriptSearch.test.ts`, `transcriptSearchUI.test.tsx` | User Phase 5 pass |
| Contextual POST correction without replacing ordinary post | `transcriptSearchUI.test.tsx` | User Phase 5 pass |
| Invalid/stale Replace all is atomic; one undo step; replacement text literal | `transcriptEdits.test.ts`, `transcriptSearch.test.ts`, `transcriptSearchUI.test.tsx` | User Phase 5 pass |
| Partial substring highlighting with light containing-token context; exact substring replacement | `transcriptSearchUI.test.tsx`, `transcriptSearch.test.ts` | Follow-up verification below |
| Save/reopen retains originals, hidden text and correction groups | `transcript.test.ts`, `openProject.test.tsx`; Rust `transcript::tests::native_save_load_and_snapshot_preserve_overlay` | User Phases 4–5 pass |
| Snapshots retain both corrections and originals | Same native round-trip test; Rust snapshot tests | User Phases 4–5 pass |
| Passage/paragraph restore after other cuts preserves unrelated corrections and audio cuts | `transcriptEdits.test.ts`, `transcriptSearch.test.ts`, `transcriptSearchUI.test.tsx` | User Phase 5 pass |
| Legacy load and correction need no manual migration | `transcript.test.ts`, `openProject.test.tsx`, Rust additive metadata tests | Native 4.7.0 legacy fixture pass |
| Re-transcription warning offers Cancel, Proceed and Snapshot first | `retranscriptionUI.test.tsx` | Final verification below |
| Unsaved Save cancellation, save/snapshot failure stop recognition and preserve corrections | `retranscriptionUI.test.tsx`, `transcriptionWorkflow.test.ts` | Final verification below; failures remain controlled automated cases |
| Recognition failure (including second clip) leaves all corrections, caches and history intact | `transcriptionWorkflow.test.ts`, `retranscriptionUI.test.tsx` | Controlled automated failure cases |
| Edits/project switch during confirmation, Save, snapshot or recognition reject stale work | `transcriptionWorkflow.test.ts`, `retranscriptionUI.test.tsx`, `projectSaves.test.ts` | Controlled automated race cases |
| Successful recognition resets originals only for requested surviving material, retaining existing cuts and unrelated overlays | `transcriptionWorkflow.test.ts` | Final verification below |
| Only raw successful recognition reaches cache; force bypasses without deleting old cache on failure | `transcriptCache.test.ts`, `transcriptionWorkflow.test.ts` | Cache behavior established by automated tests |
| Session history resets after recognition, persistent snapshot recovers corrections | `transcriptionWorkflow.test.ts`, Rust snapshot round trip | Final verification below |
| Caption text and output-order timing follow corrections and explicit cuts | `captions.test.ts`, `transcriptEdits.test.ts`, `videoOccurrence.test.tsx` | User Phases 4–5 pass; final export verification below |
| New edits/save races remain dirty and project switches ignore old saves | `projectSaves.test.ts`, `transcriptAutosave.test.tsx` | User Phase 4 pending-save check pass |
| Source media unchanged | Immutable source/range assertions in edit and workflow tests; native source-hash check below | Real lecture perceptual synchronization remains a separate check |

## Final native verification

Native 4.7.0 checks used generated projects under
`src-tauri/target/manual-corrections/final-4.7/`, with the already-installed
large-v3 local model. No model was downloaded and no personal recording was used.

- `Legacy-corrections.scribe` loaded without overlays. Editing `item potency` to
  `東京 POST` preserved six-second output duration and the second occurrence.
- Dark-theme inspection confirmed strong `PO` highlighting and lighter `ST`
  context for `po`. Exact replacement produced `REST`, Undo recovered `POST`,
  and Whole word excluded the partial match.
- Native Cancel preserved corrections. For a separately imported unsaved source,
  correcting cached raw `phone rings` to `POST rings`, choosing Snapshot first,
  then cancelling Save preserved the correction and displayed a cancellation
  explanation without recognition starting.
- Snapshot first wrote the current project and a `Before re-transcription` point
  before recognition. Reading the native gzip snapshot confirmed `東京 POST`.
- Actual recognition completed for both repeated occurrences, leaving six-second
  duration and clearing Undo. The synthetic tone was recognized as `phone rings`;
  this exercises replacement, not speech accuracy. Native snapshot recovery
  restored the Unicode correction. Saved SRT and VTT both contain the recovered
  corrected paragraph and the second raw occurrence.
- Original paragraph restoration and its undo worked. Explicit group cutting,
  one-step Undo and Redo changed/recovered only the chosen occurrence.
- `Multi-corrections.scribe` exercised three segments and two media IDs, including
  reused media, a pre-existing sourceIn 1.02 cut, and `naïve café 東京.`. Recognition
  succeeded across both clips and rebuilt all three occurrences. Comparing the
  saved project against its pre-transcription native snapshot confirmed identical
  segment IDs/media IDs/source ranges and exactly 7.98-second output duration.
  Native SRT export reflects the new baseline. The second media file is a
  disposable copy of the same generated tone video.
- Both generated video files retain SHA-256
  `ee336d4fa59f6759c6dcc56b71d5aad80ee1fd3b1109e069b07d944b69f908b9`.

The app was left saved on the generated multi-clip project, then closed for the
final rebuild. No further live app/browser testing is authorized. Unit,
integration and command-line checks remain authorized. The final source also
corrects singular/plural copy and ignores an invisible leading separator left
by a speech cut when counting corrected occurrences (covered by a regression).

Outstanding native-only checks are explicit in
[the manual checklist](manual-transcript-corrections.md): light-theme inspection,
some additional dialog/recovery sequences, a fresh full walkthrough, and copied
real-lecture perceptual synchronization. Native successes above do not certify
unperformed checks. Failure/race paths are established through controlled async
tests rather than destructive native failure injection.

## Remaining limits

- Old binaries may discard additive correction metadata on save. Keep corrected
  projects in the updated app; legacy loaded text is its available baseline.
- New displayed words share existing timing groups; there are no fabricated
  per-word timestamps or synthesized speech. Search matches within paragraphs.
- Partial group restoration expands explicitly to the full group; a speech cut
  requires a complete group. Whole-paragraph restoration includes hidden words.
- Re-transcription commits a fresh baseline and resets session undo. Proceed
  deliberately skips a snapshot; Snapshot first provides persistent recovery.
- Real-lecture beginning/cut/end synchronization and pre-existing export padding
  drift cannot be certified using a synthetic tone or mocked recognition.
