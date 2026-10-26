# Implementation plan: feature 3 — manual transcript corrections

Status: Implementation handoff. This plan does not implement the feature.

Source of truth: [accepted requirements](../requirements/03-transcript-corrections.md).
If this plan conflicts with those requirements, follow the requirements and
update the plan. The task is feature 3, not script assistance or retake detection.

## Outcome and sequencing

Deliver an editable-by-default transcript with text-only editing, persistent
originals, phrase correction, explicit speech cuts, contextual find/replace,
and protected re-transcription. Keep source media and the audio timeline
unchanged during text corrections.

Implement the phases below sequentially. Each phase should be a reviewable
commit or small set of commits with its own checks. Internal foundations may
land before the UI; do not ship editable-by-default behavior until its text,
cutting, persistence, and keyboard safety gates pass together. Partial phases
are milestones, not permission to omit later accepted requirements.

No sub-agent delegation is required by this plan.

## Current code to inspect before editing

| Area | Files | Existing behavior or risk |
|---|---|---|
| EDL and types | `src/lib/edl.ts`, `src-tauri/src/edl.rs` | Words carry text and source timing; segment ranges define playback |
| Store/history | `src/stores/projectStore.ts` | Word deletion cuts media; zundo uses a delayed `handleSet`; partialization tracks project only |
| Editor | `src/components/TranscriptEditor/TranscriptEditor.tsx`, `WordNode.ts`, `PauseNode.ts` | Read-only editor; content regenerated through `setContent`; paragraphs derive from punctuation/gaps; selection intersects DOM word nodes |
| Shortcuts | `src/hooks/useKeyboardShortcuts.ts` | Delete and Cmd-Delete cut; several transport/undo paths must be audited for editable targets |
| Find/replace | `src/components/TranscriptEditor/FindReplacePanel.tsx` | Single-record matching, DOM highlights, Replace all only |
| Persistence | `src/hooks/useAutoSave.ts`, `src/lib/openProject.ts`, Rust `project.rs`, `snapshots.rs` | Autosave can finish after newer edits; Rust must preserve every new field |
| Playback | `VideoPreview.tsx`, `useVideoFrameClock.ts`, `playerStore.ts` | Uses word/segment IDs and output/source conversion |
| Captions | `src/lib/captions.ts` | Flattens `segment.words`; must project corrected text without losing timing |
| Recognition/cache | `Toolbar.tsx`, `src/lib/transcriptCache.ts` | Re-transcription stages a project, clears caches, resets baseline; loaded project transcripts populate a cache keyed by media hash |
| Existing tests | `tests/edl.test.ts`, `captions.test.ts`, `openProject.test.tsx` | Preserve existing cut/open/export behavior while extending coverage |

These observations describe the planning checkout. Re-read the actual files
at implementation time; do not assume another feature has already introduced
correction metadata or fixed these risks.

## Architecture to establish

### Separate audio anchors from editable text

Keep source-word audio anchors and segment source ranges authoritative.
Represent corrected text separately with occurrence-scoped associations to
those anchors. Do not implement corrections by deleting timed words or by
inventing new per-word timestamps.

Recommended additive design, to finalize in phase 0:

- Immutable recognition anchors retain original text, source times, confidence,
  and speaker metadata. Their survival is governed by the EDL.
- Persisted transcript blocks provide stable paragraph identity, occurrence
  identity, and ordered editable text runs mapped to surviving audio anchors.
- An untouched run maps to one original word. A corrected phrase can map to
  multiple original words and display one or many words as one timing group.
- A text-only deletion retains its original/audio association even when its
  displayed run is empty. A full paragraph selection can still cut its audio.
- Identify an occurrence using stable occurrence/block/run IDs, not just a
  media hash or source-word ID. Copying/reusing media must allow independent
  corrections in different places in the output.
- Project display, search, caption text, playback highlighting, and selection
  use a shared transcript projection. Export audio/video continues to use EDL
  ranges, not text content.

Exact type names and storage shape are implementation choices. Record them
in a short design note with sample serialized projects before building the UI.
Avoid keeping two independently mutable copies of the corrected transcript.
A source transcript and a derived editable projection are distinct purposes;
multiple writable representations of the same correction are not.

### Paragraph and cut boundaries

Initialize legacy paragraph boundaries from existing punctuation/gap rules in
output order. Persist block identity once corrections exist; do not recompute
all blocks on each punctuation keystroke or sort words globally by source time.

Use the following initial policy and document it in the design note:

- Enter splits a paragraph only when both resulting spoken blocks can retain
  nonempty text and valid mappings. Backspace at a paragraph boundary may join
  compatible blocks while preserving every anchor.
- Reject edits across source discontinuities when mapping is ambiguous. Never
  fill the gap between separated source ranges.
- A whole paragraph replacement is allowed within a valid continuous source
  span. Cross-cut replacement is rejected with an explanation rather than
  silently broadening an audio range.
- Treat corrected timing groups as indivisible for speech cuts; text editing
  inside them is still allowed.

## Phase 0 — baseline, design, and representative fixtures

Tasks:

1. Check repository instructions and the branch graph. Start an implementation
   branch containing the accepted requirements and both existing fixes. Do not
   reset or overwrite unrelated local work, or merge/publish a PR automatically.
2. Run existing relevant tests once and record the baseline. Check native tools
   and helper availability without reinstalling dependencies unnecessarily.
3. Inventory all consumers of `segment.words`, word IDs, text caches, and
   transcript selections. Identify which need anchors and which need display text.
4. Write the data/transaction design note described above. Decide how segments
   split by later cuts retain occurrence identity, how original restoration
   intersects surviving ranges, and how unsupported future metadata is handled.
5. Create small synthetic fixtures: an untouched legacy project; “item potency”;
   “aren’t”; “the old server”; contextual “post”; two occurrences of one source;
   multiple paragraphs; existing cuts; multiple clips; and non-ASCII text.

Exit gate: a concrete serialized example demonstrates phrase merge/split,
text-only deletion, independent repeated-media occurrences, and restoration
after a later cut. No source span or duration changes in those examples.

## Phase 1 — correction model and persistence compatibility

Tasks:

1. Add optional correction/block/original metadata in TypeScript and Rust with
   explicit serde names/defaults and validation for IDs, references, and ranges.
2. Normalize legacy projects once in memory: loaded text is their available
   original baseline. Do not claim to recover historical edits.
3. Implement a pure output-order projection producing blocks/runs, display
   offsets, source associations, timing groups, and original-text lookup.
4. Preserve metadata through native save/load and compressed snapshots. Update
   Rust test constructors affected by type additions.
5. Define file-version handling explicitly. Prefer additive fields readable by
   the new app; document that older binaries may drop fields on save rather
   than claiming backward write compatibility. Reject unsupported future formats
   safely if a version bump is needed.
6. Keep correction metadata out of the media-hash recognition cache. Cache raw
   recognition only; opening a corrected project must not contaminate another
   project or occurrence through `cacheProjectTranscripts`.

Tests/gate:

- TS projection and Rust serialization round trips preserve originals, empty
  display runs, timing groups, and occurrence IDs.
- Legacy projects load; malformed mappings fail without mutating a project.
- Snapshot round trip restores all metadata.
- Two occurrences of the same media keep independent display text.
- Normalization does not churn IDs or dirty state on every render/reopen.

## Phase 2 — pure edit operations, explicit cuts, and history

Tasks:

1. Implement pure replace-text, restore-original, and batch-replace operations
   accepting logical block offsets and an expected revision/selection mapping.
   Return a new valid project and mapped selection or a structured validation
   error. Never mutate the input on rejection.
2. Preserve anchors for removed text. Attach inserted text to the selected or
   adjacent timing group using documented start/end boundary rules. Edits to a
   group expand/merge its mapping as needed without fabricating word timings.
3. Validate nonempty spoken paragraphs atomically, including Unicode whitespace,
   full selection replacement, paragraph joins/splits, and whole-batch edits.
4. Resolve explicit speech cuts from anchor/occurrence selections. Reject partial
   corrected-group selections. Paragraph selection includes text-hidden anchors.
5. Ensure existing split/delete/filler/pause operations reconcile correction
   metadata rather than dropping or duplicating it. Restoration intersects the
   surviving EDL and cannot restore previously cut speech.
6. Add store actions for valid transactions. Replace or adapt delayed history
   handling so undo boundaries are explicit and deterministic: grouped typing,
   one phrase replacement, one Replace all, one restore, and one explicit cut.
7. Use project history as the authoritative committed history. Do not leave an
   independent editor history that can disagree with zundo after a cut or load.
8. Track saved revisions: an older asynchronous save must not mark newer edits
   clean. A project switch must not let an old save completion mark the new
   project saved. Undo/redo must mark changed project content appropriately.

Tests/gate: all invariant tests cover text-only deletion versus explicit cuts,
merge/split phrases, boundary insertions, repeated source occurrences, restoration
after cuts, all-or-nothing batches, and one-step undo/redo. Store tests cover
save races and grouped typing without depending on wall-clock luck.

## Phase 3 — projection consumers: captions, playback, and selection

Tasks:

1. Route caption text through the shared projection. Skip hidden text, emit a
   corrected phrase once, and retain its actual surviving output-time bounds.
2. Map phrase highlighting/seek to its full anchored span. Avoid selectors or
   maps that assume a source word uniquely identifies an output occurrence.
3. Update timestamp columns and selection helpers to follow output order and
   stable blocks. Preserve unchanged-word timing outside corrected groups.
4. Ensure cuts still update downstream captions/video through the EDL. Text
   changes alone cannot change the FFmpeg audio/video plan.

Tests/gate: corrected SRT/VTT content and timing, reused/reordered media,
text-hidden words, cut-boundary clamping, and highlighting/seek mapping pass.
Compare audio/video export plans before/after text corrections for equality.
Keep pre-existing cut-padding drift separate from this feature's changes.

## Phase 4 — editable transcript and safe keyboard behavior

Tasks:

1. Extend the TipTap schema with stable block/run/timing-group identity.
   Whitelist allowed attributes. Treat clipboard input as plain text; strip
   pasted markup and foreign node identity.
2. Translate editor transactions through phase 2 operations. Keep local draft
   editor state during IME composition and commit only validated transactions.
   Autosave/exports/snapshots read the last valid project, not invalid drafts.
3. Replace the full-document `setContent` loop with revision-aware updates.
   Echoed local commits must not reset the caret. External load/undo/cut changes
   must update the editor and map selection deliberately.
4. Make the panel editable by default. Click positions the caret; Cmd-click
   seeks while preserving playing/paused state.
5. Provide visible Cut speech plus Cmd-Shift-X as the proposed default. Remove
   plain Delete/Backspace audio-cut bindings. Keep Cmd-X as text clipboard cut.
6. Scope shortcuts: typing Space/J/K/L/I/O/B/X never invokes transport/cuts;
   Cmd-S still saves, and undo/redo dispatches once to the right history.
7. Prevent accidental pause-badge deletion while positioning a caret. Keep an
   explicit pause-removal control. Update help/tooltips that currently describe
   Delete as cutting speech.
8. Show invalid-edit feedback without discarding the last valid selection/text.
   Handle blur, composition end, save, and closing/opening a project consistently.

Tests/gate: real editor interaction tests cover typing, selection replacement,
plain paste, Cmd-X, invalid empty paragraphs, Enter/join policy, IME, autosave
while editing, focus changes, seek modifiers, cuts, and undo/redo. Add a WKWebView
manual check for composition/caret behavior that jsdom cannot establish.

## Phase 5 — contextual find/replace and original-text restoration

Tasks:

1. Search projected paragraph text with literal phrase matching and an offset
   map back to runs. Support current/next/previous match, case and whole-word
   options. Define Unicode word-boundary behavior; do not treat regex input
   as executable patterns or replacement substitutions.
2. Implement Replace current and Replace all through phase 2 transactions.
   Compute nonoverlapping matches against one revision; apply batches in stable
   offset order and reject stale or invalid batches atomically.
3. Show counts/highlights derived from the model, not stale DOM queries.
4. Add selected-passage original-text inspection and Restore original text.
   Allow paragraph-level recovery of hidden text and preserve unrelated edits.
5. Clearly label existing Delete matches/filler actions as audio cuts, keeping
   them separate from text replacement.

Tests/gate: “post”/“POST”, phrases across records/groups, punctuation, literal
special characters, Unicode, hidden text, old selections, nonempty validation,
atomic Replace all, and persistent restoration all pass through the same engine.

## Phase 6 — safe re-transcription, cache, and snapshot workflow

Tasks:

1. Detect corrections for affected media occurrences. Present Cancel, Proceed,
   and Snapshot first choices before destructive transcript replacement.
2. For unsaved projects, route Snapshot first through Save, then snapshot the
   current corrected in-memory state, not an older on-disk version.
3. On save/snapshot failure or cancellation, preserve corrections and do not
   silently proceed. Surface the actual failure.
4. Stage recognition results separately. Commit new originals/display metadata
   only after successful completion for the requested material. Keep old
   corrections intact on failure, including failure partway through multiple clips.
5. Use a captured revision and project identity. Prevent or reject overwriting
   edits made while transcription was running. Do not overwrite another opened
   project when the task completes.
6. Cache only raw successful recognition; preserve/rebuild correction mappings
   for unaffected clips and reset the baseline for affected material on success.
7. Define undo/history treatment consistently with the existing baseline-load
   behavior and snapshot recovery; do not imply session undo replaces snapshots.

Tests/gate: every dialog branch, unsaved save cancellation, snapshot failure,
recognition failure on the second clip, stale revision/project switch, success,
and unchanged unrelated corrections are verified with controlled async mocks.

## Phase 7 — integration, documentation, and release verification

Tasks:

1. Run the completed feature against every acceptance criterion in the
   requirements and record pass/fail/evidence. Fix integration failures; do not
   mark manual native checks passed based only on mocked tests.
2. Run frontend tests, typecheck, lint, relevant Rust tests, and a native release
   build. Diagnose existing failures separately. Do not install or run unused
   Python/MLX tooling for this feature.
3. Native walkthrough: legacy load → type/merge/delete → save/reopen → restore
   original → explicit cut → undo/redo → snapshot → re-transcribe warning →
   SRT/VTT export. Include a multi-clip/reused-media project and non-ASCII input.
4. Verify source media hashes are unchanged and output duration stays constant
   for text-only edits. Validate video/captions after explicit cuts separately.
5. Update README, architecture, spec, manual checklist, and changelog. Follow
   repository versioning conventions and keep npm/Cargo/config lockfile versions
   consistent. Document new shortcut semantics and old-binary save limitations.
6. Commit/push reviewable work according to repository instructions. Provide
   the built app path, checks performed, remaining limitations, and any genuinely
   unverified native behavior. Do not create/merge a PR or replace a running
   user's installed app unless authorized.

Exit gate: all accepted behaviors are implemented and verified, with no hidden
fallback to word-count-preserving corrections, no silent audio cuts, and no
loss of originals on save/snapshot/re-transcription failure.

## Agent checkpoints and handoff discipline

At each phase completion, record in this plan (or a linked progress note):

- Commit and completed deliverables.
- Tests run and meaningful results.
- Any changed design decisions and why they preserve the requirements.
- Known failures, next phase, and exact remaining work.

Stop feature work to resolve a failed foundational gate before layering new UI
on it. If a requirement is impossible with the chosen mapping, revisit the
mapping; do not quietly weaken phrase replacement, persistent restoration,
nonempty validation, or individual-occurrence isolation.

No model download, cloud service, script import, or retake detector is a
prerequisite. Later features should consume the correction and explicit-cut
APIs without forcing this implementation to predict their detection logic.
