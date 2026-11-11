# Implementation plan: feature 2 — script-assisted transcript corrections

Status: Implementation in progress on 2026-10-30 on
`feature/script-assisted-transcript-corrections`. Human listening labels are
validated. Parser/persistence/provenance and pure matching foundations plus a
bounded-audio review prototype are implemented. Native walkthrough is the current
checkpoint. Automatic eligibility/application and held-out acceptance remain
incomplete; no automatic wording correction is enabled.
Source of truth: [requirements and acceptance criteria](../requirements/02-script-assisted-transcript-corrections.md).
The requirements include two user-supplied local project/script evaluation pairs.

Current handoff: [review script and checkpoint](../script-corrections-checkpoint.md).
Acoustic findings, predeclared release criterion and integration inventory:
[Phase 0 design note](02-script-acoustic-design.md). The checkpoint records
delivered tooling, checks, unperformed acceptance and exact next work. No
automatic wording correction is enabled.

## Approved workflow revision after native review

The next checkpoint is `4.8.0-dev.3`: combined recording/optional-script opening,
native application menus, and inline script/filler decisions with compact category
and previous/next navigation. Text suggestions bypass Whisper; explicit audio
checking remains available. Selected runs scope navigation, existing decisions and
independent evidence persist, and Undo-restored occurrences require no refresh.
Cut synchronization preserves transcript scroll. Detailed source/evidence/settings
are on demand. See the current checkpoint for the replacement human script. Full
automatic application/evaluation work remains outstanding after workflow acceptance.

Reported native issues are addressed in `4.8.0-dev.5`: filler-only script
substitutions are suppressed, exact-value numeric notation is proposed, uncertain
cards explain the absence of a replacement, popovers accept custom wording, and
off-script cuts use precise anchor bounds plus optional silence buffers. Following
text remains present across segment splits. See the focused walkthrough before
continuing automatic eligibility/evaluation work.

Current checkpoint `4.8.0-dev.6` adds the combined advancing review chain,
persistent script/filler decision log with guarded revisit/revert, and complete
original-word restart markers. The current human script covers these changes;
automatic acoustic eligibility/application and held-out acceptance remain unfinished.

Current regression checkpoint `4.8.0-dev.7` preserves exact surviving pending
suggestions across filler/off-script cuts and filler text edits, and automatically
estimates timing when entering an eligible filler. Request/project/session/manual
edit guards prevent stale estimate application. See the three-minute focused
walkthrough; automatic wording application remains disabled and unfinished.

## Outcome and delivery order

Import a Markdown teleprompter script, reconcile the whole edited transcript or
a selected passage using local audio evidence, automatically apply supported
wording/notation corrections, and persist visible review records. Provide bulk
punctuation/capitalization correction and explicit cutting of off-script speech.
Preserve manual edits, original recognition, timeline integrity, and source media.

Implement sequentially in reviewable phases. Evaluate acoustic feasibility early,
before committing to an automatic-correction engine or presenting confidence in
the UI. Foundations and review-only prototypes may be intermediate milestones;
the feature is not complete without evaluated automatic corrections and native
acceptance. No sub-agent delegation is required by this plan.

## Inspected foundations and gaps

| Area | Existing code | Reuse or required extension |
|---|---|---|
| Current text and immutable originals | `src/lib/transcript.ts`, `src-tauri/src/transcript.rs` | Output-order blocks/runs with UTF-16 offsets, anchor IDs, timing groups; add edit provenance without creating another writable transcript |
| Pure text edits and cuts | `src/lib/transcriptEdits.ts` | `replaceTranscriptBatch`, `cutTranscriptRanges`, `cutOutputSpeech`; batch is revision-guarded and rejects overlaps; respect paragraph/group limits |
| Project model and EDL | `src/lib/edl.ts`, `src-tauri/src/edl.rs` | Add optional versioned script/review metadata; preserve occurrence lineage, precise segments, and retained filler-edge audio |
| History and saving | `src/stores/projectStore.ts`, `src/lib/projectSaves.ts`, `src/hooks/useAutoSave.ts` | Commit derived text and review records together through project history; protect save races |
| Async recognition workflow | `src/lib/transcriptionWorkflow.ts`, `src/lib/ipc.ts` | Reuse session/project capture pattern; reconciliation must not use baseline replacement or reset undo |
| Native recognition | `src-tauri/src/commands/transcribe.rs`, `src-tauri/src/transcribe.rs` | Existing whisper.cpp/CrisperWhisper providers; no calibrated comparison of competing wording is exposed by the inspected public options |
| Audio review and previews | `src/lib/fillerActions.ts`, `src/stores/fillerAuditionStore.ts`, `src/components/VideoPreview/FillerAudition.tsx` | Generalize bounded original/preview/result playback where appropriate; do not route off-script spans through filler-token policy |
| Review UI and decorations | `src/components/TranscriptEditor/TranscriptEditor.tsx`, `FillerReviewPanel.tsx`, `FindReplacePanel.tsx` | Add reconciliation panel/decorations alongside search/filler marks, retaining caret/IME and shortcut safety |
| Persistence | Native `project.rs`, `snapshots.rs` and command wrappers | TS/Rust schema parity, validation, save/reopen/snapshot round trips |
| Captions/cache | `src/lib/captions.ts`, `src/lib/transcriptCache.ts` | Continue projected captions and raw-only recognition cache; script-conditioned evidence requires separate identity/storage |

The current `TranscriptRun` does not identify authorship. Comparing text with
originals can conservatively identify legacy corrections but cannot identify who
authored every historical edit. Existing normalized overlays also occur on
untouched projects. Do not equate overlay presence with a manual correction, or
recognizer confidence with acoustic proof of scripted wording.

Re-read implementations and repository guidance before editing: this table is a
planning inspection, not a promise that every existing helper fits unchanged.

## Phase 0 — baseline, fixtures, and acoustic feasibility

1. Check instructions, branch/worktree status, installed dependencies and local
   recognition capabilities. Preserve unrelated changes. Create an implementation
   branch using the repository's conventions; no automatic PR, merge, or install.
2. Run relevant existing frontend checks and native library tests once; record
   failures separately from new work. Do not reinstall models/tooling just to
   establish a baseline.
3. Inventory all text writers, restored-text paths, EDL transforms, recognition
   completion, save/snapshot serializers, and clipboard/editor transactions that
   must update provenance and review records.
4. Inspect supplied media read-only. Create disposable copies/artifacts under a
   local ignored test-output directory for analysis and mutation tests. Record
   source hashes and preserve the originals. Do not commit private recordings,
   scripts, transcript excerpts, or absolute-path-dependent tests as fixtures.
5. Label listening excerpts for correct/incorrect recognized wording, intentional
   spoken substitutions, technical identifiers/numbers, equivalent notation,
   restarts, fillers, and intentional additions. Split development/calibration
   and held-out excerpts before tuning. Add synthetic parser/cut/race fixtures.
6. Prototype local audio comparison on bounded source excerpts. Consider the
   current wording, script wording, and an other/uncertain outcome. Compare an
   independent unprompted recognition baseline with any script-conditioned
   approach; test script-induced errors explicitly. Forced alignment only tests
   timing compatibility with supplied words, not whether they were spoken.
7. Write an evaluation/design note: available engine interfaces, candidate
   scoring, disagreement/abstention rules, runtime/memory, required setup, and
   calibration limitations. Set an explicit precision/false-change release
   criterion before held-out measurement, with the requirements' mandatory
   no-overwrite challenge cases. Do not invent a confidence percentage.

Gate: a concrete local evidence approach can distinguish supported changes from
intentional deviations on labeled examples, or the blocking acoustic limitation
is documented and the approach is revised. No automatic application ships before
this gate and the later held-out evaluation pass. Passing text mocks alone is
insufficient. Covers the design portion of SC-04/05/16.

## Phase 1 — persisted script, parser, provenance, and review schema

1. Add pure Markdown parsing with source offsets and section context. Implement
   the requirements' heading/cue/comment/code/link/list/escape rules. Prefer an
   appropriate parser over globally stripping Markdown/HTML with regexes. Report
   ambiguous cues without silently swallowing remaining script text.
2. Add optional versioned script/reconciliation metadata in TS and Rust. Capture
   exact imported Markdown, revision/hash, historical evidence references, policy
   version, and review records. Validate references, statuses, ranges, finite
   times, size limits, and unsupported future versions consistently.
3. Define stable record identity using occurrence lineage, ordered anchor IDs,
   text/context fingerprints, script revision, and analysis policy. Distinguish
   suggested, applied-unreviewed, kept/accepted, reverted/dismissed, off-script,
   and stale/historical states. Avoid an overloaded boolean reviewed flag.
4. Define edit provenance for direct typing, paste, find/replace, original
   restoration, filler text hiding, script application, and user review decisions.
   Protect legacy deviations conservatively; keep untouched spans eligible.
   Document joins/splits, merged groups, hidden runs, and reused occurrences.
5. Record a minimal serialized example for script import, an automatic correction,
   a protected manual edit, an unresolved suggestion, an off-script passage,
   script replacement, and later cutting/reverting. Include pre-change text and
   associations needed to restore a correction without restoring other history.
6. Implement native save/load/snapshot round trips and legacy loading. Old app
   binaries may discard additive fields on save; follow existing compatibility
   conventions and do not claim backward write compatibility.

Gate: parser and TS/Rust/native snapshot tests pass, including malformed metadata,
Unicode/UTF-16 offsets and `<press>` followed by spoken prose. No implicit dirty
state on load or a second writable copy of corrected display text. SC-01/02/07.

## Phase 2 — script matching, scope, and pure candidate model

1. Project current surviving transcript text in output order, retaining source
   anchors, occurrence lineage, hidden-text protection, and existing cuts. Select
   a whole transcript or exact passage against a captured project/script revision.
2. Match against full-script sections while using headings only as context.
   Handle near-verbatim differences, repeated passages, restarts, skipped lines,
   reordered/reused clips, punctuation, and equivalent notation. A selected span
   may need context for matching but cannot change speech outside the selection.
3. Represent matched, uncertain, and unmatched/off-script results separately.
   Do not turn every failed alignment into a confirmed off-script passage.
   Never force inserted script sentences, discard fillers, or choose one repeated
   take solely because it is the best textual match.
4. Generate exact proposed edits and current-text preconditions. Separate lexical
   changes, equivalent technical notation, and punctuation/capitalization. Cases
   that alter an identifier/value or blur category boundaries remain pending.
5. Map edits into supported block-local transactions. Split only where semantic
   and timing mappings remain valid; flag cross-cut/ambiguous mappings rather
   than broadening a group, joining a gap, or silently partially correcting it.
6. Deterministically deduplicate and reconcile results with prior decisions.
   Reruns against unchanged inputs do not duplicate cards or reopen dismissals.

Gate: synthetic matching/identity fixtures pass for selections, repeated source
occurrences, cuts, protected hidden text, intentional additions, and altered
technical values. No project mutation during analysis. SC-03/05/07/08/09/15.

## Phase 3 — bounded audio analysis and cancellable workflow

1. Implement the evaluated acoustic provider behind typed IPC. Extract bounded
   read-only source audio with context, respecting discontinuities. Keep sample
   offsets distinct from source seconds and output seconds; never concatenate
   cut gaps and pretend the result was continuous recorded speech.
2. Return structured evidence, alternatives, uncertainty, engine/model/policy
   identity, and diagnostic references. Models' self-reported confidence or
   agreement with prompted script text must not alone enable automatic edits.
3. Capture project session/revision and script revision. Stage all requested
   results, checking identity after async boundaries and before commit. Cancel
   background subprocesses where possible; ignore all late results and progress.
4. Missing media or unavailable required audio capability stops the run with no
   staged changes. Explain explicit model setup/retry where appropriate. Never
   silently fall back to script-only automatic correction or translation.
5. Keep derived analysis separate from raw recognition caches. Key any optional
   analysis cache by source identity/bounds, alternatives/context, script revision,
   engine/model and policy. Do not rewrite project recognition anchors or raw
   transcript caches with conditioned text.

Gate: controlled async tests cover cancellation, second-clip failure, edits,
script replacement, load/snapshot switch, missing capability and late completion.
Run real audio checks on disposable excerpts to confirm IPC is using the actual
provider rather than mocked evidence. SC-04/13/16.

## Phase 4 — atomic application, history, and lifecycle integration

1. Use existing text-edit validation to apply the eligible nonoverlapping edits
   and provenance/review records as one validated project transaction. Exclude
   manual edits and any group touching protected or out-of-scope text. Recheck
   before-text, expected revision, anchors, and script identity at commit.
2. Treat invalid batches atomically. Keep unresolved suggestions pending and
   explain why a run had no automatic changes. Do not reset the session baseline
   or undo stack as ordinary re-transcription does.
3. Add separate atomic actions for acceptance, Keep, Revert, Dismiss, and bulk
   punctuation/capitalization. Revert only the recorded pre-correction text where
   mappings remain valid; don't use Restore original as an equivalent shortcut.
4. Reconcile records on every text/EDL transform, split/join/reuse, filler action,
   original restoration, recognition baseline change, and snapshot restore.
   Retain historical evidence but disable stale actions; preserve unrelated edits.
5. Add explicit undoable script replacement: preserve applied text/history, clear
   pending suggestions and derived off-script results, retain old evidence, and
   require a new run. Idempotent no-op runs/actions must not churn history.
6. Verify metadata/text undo together, normal dirty state, autosave revision races,
   save/reopen, snapshots, independent reused occurrences, and captions/export
   invariants. User approval of a change protects it on later runs.

Gate: integration tests prove all-or-nothing run commits, correct per-action undo,
legacy protection, persistent review, and unchanged EDL/export plans for text
corrections. SC-02/06/07/09/10/12/13/14/15.

## Phase 5 — reconciliation review UI and off-script cuts

1. Provide Markdown import/replacement and whole/selected scope controls, progress,
   cancellation, actionable errors and empty results. Display the active script
   and scope in ordinary user language; keep engine internals in diagnostics.
2. Show distinct applied/pending/off-script decorations and review filters in
   output order. Cards show before/after, script context, brief evidence reason,
   source/output position and original listening. Markers are not caption text.
3. Implement Keep/Revert, Accept/Dismiss, and explicit bulk punctuation action.
   Resolving clears active markers and retains history; navigation/listening does
   not resolve. Preserve keyboard access, caret/IME behavior and safe shortcuts.
4. For off-script review, offer bounded original playback, immutable cut preview,
   Cut speech and Keep. Reuse/generalize existing audition machinery where it
   fits. Compute one proposal consumed by both preview and commit. Reject partial
   corrected groups or stale mappings without silently cutting extra speech.
5. Preserve natural joins through existing cut policies and disclose actual cut
   bounds. Each accepted cut has one undo step, survives save/reopen, and updates
   duration/captions/export. Keep intentional additions intact.
6. Expose a small typed script-evidence interface for future retake detection;
   do not build a new semantic retake detector as a prerequisite. Test running
   reconciliation both before and after filler review decisions.

Gate: real-editor interaction tests pass for review, decorations, audio controls,
bulk actions, scope, undo, stale cards, captions, and coexistence with filler and
search UI. SC-03/06/08/09/11/12/15.

## Phase 6 — acoustic evaluation, native acceptance, and release

1. Evaluate frozen rules on held-out labeled excerpts from both supplied pairs
   and adversarial/synthetic controls. Report precision, false automatic changes,
   missed corrections, abstention, matching/off-script mistakes, sample size,
   runtime, memory, hardware and model versions. Include failed examples.
2. Enforce the predeclared acoustic threshold and mandatory challenge cases.
   If they fail, revise the evidence approach and evaluate on fresh held-out
   material. Do not declare review-only fallback a completed automatic feature.
3. Run frontend tests, typecheck/lint, relevant Rust tests and native release
   build using repository conventions. Run provider-specific tests only for
   the provider actually used; don't install unrelated Python/model stacks.
4. Native checklist on disposable copies: import → selected run → auto change →
   listen/Keep/Revert → pending Accept/Dismiss → bulk punctuation → save/reopen →
   replace script → off-script preview/cut/undo → snapshot/recover → SRT/VTT.
   Include Unicode, headings/cues, reused/multiple clips and pre-existing cuts.
5. Test actual cancellation/capability errors safely; use controlled automated
   failures for destructive or unreliable native race scenarios and label that
   evidence honestly. Compare source hashes and exact duration/ranges/export
   plans before/after text-only corrections; listen around explicit cut joins.
6. Create an acceptance audit mapping SC-01 through SC-16 to evidence. Record
   any unperformed native checks. Update README/spec/changelog/manual checklist
   and keep release versions/lockfiles consistent under repository conventions.
7. Provide reviewable commits, checks, acoustic findings, app build path and
   remaining limits. Do not install over a running app, publish, or merge a PR
   as part of this plan without the applicable authorization.

Exit: all accepted behaviors have implementation and evidence, including actual
audio-supported automatic correction, durable review, protected manual edits,
and explicit off-script cuts. Text-only editing never changes audio/video.

## Acceptance coverage

| Criteria | Primary phases |
|---|---|
| SC-01, SC-02 | Phase 1 parser/schema/native round trips; Phase 6 native verification |
| SC-03, SC-05, SC-08 | Phase 2 matching/scope; Phases 3 and 6 audio evidence; Phase 5 UI |
| SC-04, SC-16 | Phase 0 feasibility; Phase 3 real provider; Phase 6 held-out acoustic gate |
| SC-06, SC-07, SC-14 | Phases 1 and 4 provenance/atomic history; Phase 5 review controls |
| SC-09, SC-10 | Phases 2 and 4 identity/lifecycle; Phase 5 review UI |
| SC-11 | Phase 5 off-script playback/preview/cut; Phase 6 native joins |
| SC-12, SC-15 | Phases 2 and 4 projection/EDL integration; Phases 5 and 6 export and native checks |
| SC-13 | Phase 3 cancellation/failure/session guards; Phase 4 atomic commit |

## Handoff discipline

At each phase, record commits, delivered behavior, checks/evidence, unresolved
failures and the exact next work in this plan or a linked checkpoint. Update the
requirements if an explicitly approved product decision changes; implementation
convenience is not a reason to weaken acoustic evidence, manual protection, or
timeline invariants. Keep private evaluation artifacts outside tracked fixtures.
