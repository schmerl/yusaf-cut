# Feature 2: Script-assisted transcript corrections

Status: Requirements consolidated from the user interview on 2026-10-30.
Ready for phased implementation and acoustic feasibility evaluation; this
feature is not implemented. Interview decisions are distinguished from the
operational defaults below.

Agent handoff: [implementation plan](../plans/02-script-assisted-transcript-corrections.md).

## Goal

Reconcile a recorded presentation's transcript with its teleprompter script,
using the script and recorded audio to correct recognition mistakes,
capitalization, and punctuation more easily. Build on the existing
[manual transcript correction feature](03-transcript-corrections.md).

## Confirmed decisions

| Area | Requirement |
|---|---|
| Script format | Markdown |
| Markdown headings | Always treat headings as unspoken navigation/context; never insert heading text into transcript corrections or captions |
| Technical notation | Format matched spoken technical notation as written in the script, such as `GET /payments/P456` rather than its spelled-out pronunciation |
| Script storage | Store a copy of the imported Markdown in the project so reopening does not depend on the original file; provide an explicit action to replace it with an updated script |
| Script replacement | Keep applied corrections and their review history; clear pending suggestions so they can be regenerated against the new script |
| Unspoken material | Scripts sometimes include unspoken material, usually enclosed in `<...>`; exclude those annotations from spoken-text matching and correction suggestions |
| Recording style | Nearly verbatim delivery |
| Reconciliation scope | Run on either the whole current edited transcript or a selected passage |
| Evidence | Use the audio as well as the script to help determine which wording was spoken |
| Uncertainty | Flag ambiguous differences for user review |
| Simple corrections | Punctuation and capitalization corrections can be bulk applied |
| Automatic wording corrections | Automatically apply corrections when audio strongly supports the scripted wording |
| Existing manual corrections | Preserve manually corrected passages; further changes there are suggestions requiring explicit acceptance, never automatic replacements |
| Visibility | Indicate that an automatic correction was made so the user can review it afterward |
| Review persistence | Automatic-correction markers and review status survive save/reopen until the user reviews or dismisses them |
| Cancellation and failure | Analyze the requested scope before committing automatic corrections together; cancellation or failure leaves the transcript unchanged |
| Undo grouping | One Undo reverses a successful run's automatic corrections; later review actions are separately undoable |
| Off-script speech | Highlight surviving speech absent from the script and not resolved by reconciliation, as supporting evidence for possible stumbles or retakes |
| Off-script cutting | Offer an explicit Cut speech action for highlighted off-script passages |

## Workflow and operational defaults

The following defaults complete the confirmed decisions without prescribing a
particular model or promising an unmeasured accuracy level.

Recommended workflow: import script → reconcile → review corrections and
possible retakes/off-script speech → review fillers → export. This is guidance,
not a prerequisite: reconciliation must also work after filler cuts or manual
text hiding, and must never undo those decisions.

1. Import a UTF-8 Markdown file into the current transcribed project. Store its
   content and a stable revision/hash, not just a path. Importing/replacing the
   script is a project change; reading it or navigating review is not.
2. Choose the whole edited transcript or a nonempty selected passage. Locate
   that passage within the full stored script without requiring a separate
   script selection. Show the scope before analysis starts.
3. Start reconciliation explicitly. Show progress and Cancel. Capture project
   identity/session, project revision, script revision, and occurrence mappings.
4. Match passages and inspect the relevant source audio locally. Stage all
   results for the scope; analysis never mutates recognition anchors or EDL.
5. After success and current-state validation, commit eligible automatic wording
   and technical-notation corrections plus their review records together. Show
   counts for applied corrections, pending suggestions, and off-script passages.
   A successful run with no eligible corrections is a normal outcome.
6. Review applied changes, unresolved suggestions, and off-script passages in
   output order. Offer an explicit bulk punctuation/capitalization action that
   excludes protected manual passages and unresolved wording changes.
7. Save/reopen and snapshots preserve the stored script, correction evidence,
   pending review, and review outcomes. Captions contain only current text.

### Markdown interpretation

- All headings (ATX and Setext) are unspoken navigation/context, including the
  document title. Their text can help locate sections but never supplies a
  replacement or a missing spoken passage.
- Lists, blockquotes, emphasis, and ordinary paragraphs contribute their text.
  Links contribute visible labels; link destinations and image syntax/alt text
  are not spoken. Inline code contributes its literal text so identifiers and
  paths remain available. Fenced and indented code blocks are unspoken by
  default. These are operational defaults; they can be extended explicitly.
- `<...>` is the script's unspoken-cue convention, not executable HTML. Exclude
  the cue only: `<press> Let's look at QUERY` retains `Let's look at QUERY`.
  HTML comments are unspoken. Do not execute markup, fetch links, or load images.
- Parse escapes/code before cues: literal angle-bracket notation intended to be
  spoken can be written in inline code or with escaped brackets. Exclude
  angle-bracket autolinks as unspoken under this convention. Keep source offsets
  so the review can show the actual Markdown excerpt.
- An unmatched/unclosed cue or other ambiguous construct is reported with its
  location and excluded from automatic use until resolved. Do not silently
  discard the remainder of the script. An empty/unreadable/nonspoken-only script
  gives an actionable import error without replacing the previous script.
- Unmarked prose is presumed spoken; unknown stage directions cannot be inferred
  reliably. Preserve Unicode, technical symbols, and replacement capitalization.

### Script matching and evidence

- Persist the imported Markdown copy with the project and snapshots. Moving or
  editing the original file does not silently change the stored script. Script
  replacement is explicit. Replacing it keeps applied corrections and their
  review history, and clears pending suggestions for regeneration against the
  new script (confirmed). Retain the script evidence associated with prior
  corrections rather than presenting the replacement script as their source.
- Read Markdown as structured script text. Formatting syntax must not leak into
  corrected transcript text or captions. Treat `<...>` annotations as unspoken
  material, and all Markdown headings as unspoken navigation/context (confirmed).
  Heading text may support navigation and matching context but is never spoken
  replacement text. Apply the Markdown interpretation rules above.
- Render matched spoken technical notation using the script's written form
  (confirmed), for example `get slash payments slash P four five six` becomes
  `GET /payments/P456`. Require evidence that the spoken content corresponds to
  that notation; do not substitute a different identifier, method, or value
  merely to match the script. Preserve the existing timing associations and
  manual-edit protections.
- Match script passages to the current surviving transcript in output order.
  Allow occasional deviations and restarts without forcing every script word
  into the recording.
- Treat the script as guidance for recognition, rather than proof that a word
  was spoken. Do not insert skipped script passages or rewrite intentional
  spoken variations solely to match the script.
- Inspect the corresponding recorded audio for disputed wording. Script-biased
  recognition output alone must not be presented as independent confirmation.
- If matching or audio evidence remains uncertain, retain the current text and
  show a review item instead of applying a wording correction.
- Keep analysis local, consistent with the application's existing workflow.
  Model choice, evidence thresholds, and evaluation belong to implementation
  design; no accuracy level is established by this draft.

### Applying and reviewing corrections

- An explicitly started reconciliation may automatically apply wording
  corrections supported strongly enough by audio, including equivalent spoken
  technical notation. Define and evaluate the decision rule before enabling
  automatic application; a scalar recognition confidence is insufficient.
- Preserve existing manual corrections, including during bulk application of
  punctuation and capitalization changes. Further changes to those passages
  require individual explicit acceptance (confirmed).
- Offer an explicit bulk action for punctuation and capitalization suggestions.
  Do not include unresolved wording differences in that action.
- Mark automatically corrected passages in the transcript and provide a review
  list in playback order, distinguishing applied corrections from pending
  suggestions.
- For an applied correction, show the previous transcript, resulting text,
  matching script passage, a brief reason, and playback of the relevant audio.
- Applied corrections offer **Keep** and **Revert**; pending suggestions offer
  **Accept** and **Dismiss**. Off-script passages offer **Listen**, **Preview
  cut**, **Cut speech**, and **Keep**. Resolving an item clears its active marker
  while retaining history. Navigation/listening alone never resolves an item.
- Reverting an individual automatic correction
  restores the text immediately before that correction, which may differ from
  the original recognition baseline if manual edits already existed.
- Keep review markings out of caption text. Automatic-correction markers and
  review status survive save/reopen until the user reviews or dismisses them
  (confirmed). Applied changes and pending suggestions have distinct labels and
  decorations, also distinguishable from off-script and filler highlights.

### Off-script speech and retake review

- Highlight surviving speech that could not be matched to the script and was
  not resolved by reconciliation (confirmed). Distinguish uncertain alignment
  from evidence of off-script speech; a failed match alone does not establish
  a stumble or an unwanted take.
- Offer an explicit **Cut speech** action for an off-script passage (confirmed).
  Label it as an audio/video cut, separately from accepting a text correction.
- Review controls: listen with surrounding context, preview the cut,
  then Cut speech or Keep. An intentional aside may be kept unchanged.
- Use existing explicit-cut operations and full timing-group selection rules.
  Never silently expand a highlight through a corrected group or existing cut.
  A stale or ambiguous mapping must be resolved before cutting.
- Each explicit cut is separately undoable, updates duration and exports, and
  persists through save/reopen and snapshots. Highlighting or running
  reconciliation does not itself cut speech.
- Make script mismatch available as supporting evidence for optional
  [retake review](04-retakes-and-false-starts.md), such as an unmatched fragment
  followed by a completed scripted sentence. Retake detection must continue to
  work without an imported script.
- Recommended workflow: reconcile, review possible retakes and
  off-script speech, then review fillers. Either order must work on surviving
  speech while preserving existing cuts and manual text-hiding decisions.
- Do not remove fillers or restarts just because they are absent from the
  script. Their removal requires an explicit speech-cut action.

### Editing and project integrity

- Use the existing text-correction operations. Corrections change displayed
  transcript text and captions without changing source ranges, cuts, playback
  order, duration, or source media. User-invoked off-script speech cuts are
  separate timeline operations and intentionally change duration.
- Retain original recognized text and valid timing-group associations. Do not
  fabricate word timestamps or synthesize speech.
- Preserve occurrence isolation for reused media and enforce nonempty spoken
  paragraphs. Never bridge removed speech to match a script passage.
- Reject or recompute stale results when project edits or project switches
  invalidate their passage mappings.
- Stage analysis for the entire requested scope before committing automatic
  corrections together. Cancellation or failure leaves the transcript unchanged
  (confirmed). Do not expose partially applied results from an incomplete run.
- Accepted and automatic changes must participate in undo/redo and normal
  project/snapshot persistence. One Undo reverses a successful run's automatic
  corrections; later review actions are separately undoable (confirmed).
- Reverting a correction must preserve later cuts and unrelated changes; a
  changed passage must be checked before restoring its earlier text.

### Provenance and result lifecycle

- Track authorship sufficiently to protect manual typing, paste, find/replace,
  restoration, and manually hidden text. An existing overlay does not prove an
  edit was automatic. For older projects without provenance, conservatively
  protect differences from their available original baseline, including hidden
  runs and ambiguous groups. Do not protect the entire untouched transcript
  merely because it has a normalized overlay.
- Accepting a suggestion or keeping an automatic correction makes it an explicit
  user decision. Repeated runs must not silently override that decision, revert
  a rejected correction, or duplicate unchanged items.
- Identify results by script revision, occurrence lineage, surviving anchor
  references, relevant current text/context, and analysis-policy version. Raw
  character offsets or source word IDs alone are not durable identifiers.
- Repeated runs against unchanged inputs preserve resolved decisions. Relevant
  passage/script changes or materially changed evidence can invalidate pending
  items; retain the earlier history and disclose why a new item appears.
- Script replacement keeps applied text and history, clears pending suggestions
  and derived off-script results, and requires an explicit new run. Preserve old
  script revisions or self-contained excerpts sufficient to explain old changes.
- Ordinary edits, cuts, undo/redo, media reuse, and paragraph changes reconcile
  the review records in the same transaction. Invalidate actions whose mappings
  become ambiguous; never restore removed speech through a text revert.
- Successful re-transcription invalidates active results for affected material
  while retaining historical records as no longer actionable. Failure/cancellation
  preserves current records. Snapshot recovery restores the captured state.
- Cancellation, analysis failure, missing media, or stale project/script state
  commits no staged corrections or review records. Preserve unrelated user edits
  made while analysis was running. Report the reason and allow an explicit retry.
- Missing local audio-analysis capability explains what is unavailable and offers
  setup/retry or cancellation. Never substitute script-only automatic wording
  changes. Model setup is explicit; no cloud fallback is part of this feature.
- Each bulk punctuation action is one atomic undo step. Review actions and cuts
  are separate history steps. Undo/redo restores associated review metadata as
  well as text/timeline changes. Script replacement is also undoable.

## Scope boundaries

This feature does not synthesize speech, insert skipped script sentences,
retime words, rewrite intentional spoken content to match the script, or
silently remove fillers/restarts. Script-only similarity, forced alignment to
supplied text, and recognizer agreement are not proof that text was spoken.
It does not require a full semantic retake detector to deliver off-script review;
provide optional script evidence for feature 4 without making a script mandatory.
The first version supports one stored script per project and local processing.

## Acceptance criteria

| ID | Behavior and required evidence |
|---|---|
| SC-01 | Import Markdown; headings/cues/comments/code blocks do not become transcript text. Lists, link labels, inline technical code, escapes, Unicode, and `<press>` followed by speech follow the documented rules. Invalid import preserves the previous script/project. |
| SC-02 | Save/reopen and native snapshot round trips preserve script revisions, pending items, applied before/after evidence, and review outcomes without needing the original Markdown path. Legacy projects load without migration by the user. |
| SC-03 | Whole-transcript and selected-passage runs locate the relevant script section; only the requested speech is changed. Selection inside a timing group cannot silently expand the correction outside scope; flag unsupported mappings. Repeated script phrases and takes produce uncertainty rather than a forced unique match. |
| SC-04 | Audio-supported correction fixtures include `item potency` → `idempotency`, `Jason` → `JSON`, and proper-name formatting. Eligible changes apply automatically, are visibly marked, have before/after/script/audio review, and survive reopen. Uncertain or contradictory audio produces pending suggestions with unchanged text. |
| SC-05 | Equivalent spoken notation becomes `GET /payments/P456` with its existing timing group. A different spoken method, identifier, or number is never silently replaced to agree with the script. |
| SC-06 | Bulk punctuation/capitalization changes only that category, excludes protected edits, reports count, is atomic on validation failure, and is reversed by one Undo. Ambiguous sentence boundaries stay pending. |
| SC-07 | Pre-existing manual wording, punctuation, hidden text, and legacy corrections remain unchanged automatically, even when audio favors the script. Further changes require individual acceptance. |
| SC-08 | Skipped script sentences are not inserted; fillers, restarts, intentional asides, and spoken substitutions are not deleted by reconciliation. Distinguish uncertain matching from off-script candidates. |
| SC-09 | Keep/Revert and Accept/Dismiss update the correct item's marker/status and retain history. Listening/navigation makes no decision or project edit. Reruns do not duplicate or reopen unchanged resolved items. Revert restores the pre-correction text without reverting unrelated edits or cuts. |
| SC-10 | Replacing the script preserves applied text and its original evidence/history, clears pending suggestions/derived off-script items, and does not start another run automatically. Undo restores the earlier script and associated state. |
| SC-11 | Off-script review offers original listening, preview, Cut speech, and Keep. Only Cut speech changes the EDL. Preview and committed cut agree; partial timing groups and stale mappings reject without silently broadening the cut. One Undo restores the cut and review state. |
| SC-12 | Text-only edits preserve exact EDL ranges, output order/duration, source hashes, and video/audio export plan. Corrected captions use the shared output-time projection without fabricated timestamps or review markup. Reused media occurrences remain independent. |
| SC-13 | Cancellation, second-clip failure, missing media/capability, project switch, script replacement, or intervening edit commits none of the staged results. Current user edits, originals, caches, and history survive. Late progress/results cannot update a new session. |
| SC-14 | A successful run's automatic corrections and review metadata form one undoable commit. Subsequent acceptance, revert, bulk action, or cut remains separately undoable. Dirty/save-race behavior remains correct. |
| SC-15 | Reconciliation works before and after filler text hiding/cuts, segment splitting, and reused/multiple clips; respects existing filler decisions and never brings back removed speech. Re-transcription and snapshot recovery follow the result lifecycle above. |
| SC-16 | Labeled real-audio evaluation reports automatic-correction precision/false changes, missed corrections, uncertainty, matching/off-script errors, runtime, and hardware/model details. Mocked tests or textual examples alone cannot pass the acoustic gate. |

## Validation and acoustic release gate

Test parsing, matching, identity, transactional application, and UI independently
with synthetic fixtures. Include ambiguous audio, silence, intentional deviations,
repeated phrases, preserved manual edits, technical values that differ from the
script, cuts, and retained wordless filler-edge audio. Use real editor transactions
and controlled async mocks for race/failure cases; native round trips must cover
both TypeScript and Rust representations.

Use the two user-supplied pairs below on disposable project copies. Listen to
and label representative excerpts before calling a difference a recognition error
or stumble. Separate development/calibration excerpts from evaluation excerpts;
report sample sizes and actual mistakes rather than claiming general accuracy.
Include cases where the script is wrong for the recording, not only cases where
it supplies the desired answer. No user media or script is added to the repository
or sent to a remote service as part of this workflow.

Before automatic application ships, document the local acoustic approach,
comparison alternatives (including unchanged wording), abstention rule, and
measured error tradeoff. Establish a concrete release threshold in the evaluation
report before measuring the held-out examples. The mandatory challenge cases
must show no automatic overwrite of deliberate spoken differences, protected
manual edits, or unsupported technical values. Failure blocks automatic wording
release and requires revisiting the approach; review-only behavior is an interim
milestone, not completion of the accepted automatic-correction requirement.

## Representative evaluation material

The user supplied this local project/script pair for specification and
evaluation. Inspect originals read-only; use disposable copies for tests that
apply corrections or cuts. These paths identify local material, not bundled
repository fixtures.

- Project:
  `/Users/schmerl/Library/CloudStorage/Box-Box/Teaching/17625 API Design/2026 Recordings/05.2-flipped-openapi-3.1.2-v1.scribe`
- Script:
  `/Users/schmerl/Library/CloudStorage/Box-Box/Teaching/17625 API Design/CMU-17625-API-DESIGN/build/slides/05.2-flipped-openapi-teleprompter.md`

Read-only inspection found a project directory containing `project.json`, one
media reference, one continuous segment of approximately 23 minutes 34 seconds,
3,082 recognition word records, and a persisted transcript overlay. The
referenced MP4 is available. The script has 23 Markdown headings, including its
title, and no `<...>` annotations or fenced code blocks; synthetic examples
will be needed to cover those conventions.

Candidate evaluation cases observed in text (not yet verified by listening):

| Transcript | Script/context | Evaluation purpose |
|---|---|---|
| `valid Jason` | `valid JSON` | Possible technical-term recognition error; verify against audio before correcting |
| `hail me` / `Hail Me` | `HailMe` | Proper-name spelling and multiword-to-single-name correction |
| `Schemers describe` | `Schemas describe` | Possible recognition error requiring audio evidence |
| `documente- documentation` | `documentation` | Possible abandoned word/restart; preserve until an explicit speech cut |
| `[UH]` within scripted sentences | No corresponding script word | Preserve recorded fillers during reconciliation; use filler review for explicit removal |
| `to understand the API` after `people` | Script ends the sentence at `people` | Possible intentional addition; mismatch alone must not imply an unwanted stumble |

The opening transcript proceeds from `Welcome back` into body text without
reading the title or first section heading. This is consistent with the
confirmed rule that all headings are unspoken navigation/context.
Source timestamps can locate listening
excerpts; the examples above do not establish acoustic accuracy or detector
quality. No reconciliation or audio analysis was run during this inspection.

### Additional evaluation pair: HTTP semantics

The user also supplied:

- Project:
  `/Users/schmerl/Library/CloudStorage/Box-Box/Teaching/17625 API Design/2026 Recordings/05.1-flipped-http-semantics-query.scribe`
- Script:
  `/Users/schmerl/Library/CloudStorage/Box-Box/Teaching/17625 API Design/CMU-17625-API-DESIGN/build/slides/05.1-flipped-http-semantics-teleprompter.md`

Read-only inspection found one continuous segment of approximately 16 minutes
5 seconds, 2,071 recognition word records, an existing transcript overlay, and
an available referenced MP4. The script has 16 headings and no fenced code
blocks. As with the first pair, none of these text observations have yet been
verified against the audio.

- `item potency` versus scripted `idempotency` provides a real example of the
  multiword-to-single-word correction required by the correction model. Other
  occurrences already use `idempotency`; evaluate each occurrence on its own.
- `perhaps as adjacent` versus scripted `perhaps as JSON` is another candidate
  recognition error requiring acoustic verification.
- `basic basic meaning` versus scripted `basic meaning` and `paymo- PAYGO`
  versus `PayGo` are possible repetition/restart examples. Text reconciliation
  must not silently remove the corresponding speech.
- `get slash payments slash P four five six` versus `GET /payments/P456` tests
  the confirmed spoken-to-written technical notation rule. A notation
  difference alone does not establish an off-script passage; verify matching
  spoken content before using the script's written form.
- The script includes `<press> Let's look at QUERY ...`. Exclude only the
  `<press>` cue; retain the following sentence as spoken script. Do not exclude
  the whole line containing the cue.
- Transcript additions about QUERY being new and absent from the previous
  session provide candidates for intentional off-script explanation, not
  evidence by themselves that the passage should be cut.

## Implementation handoff

Follow the [phased implementation plan](../plans/02-script-assisted-transcript-corrections.md).
Implementation choices may refine data shapes and local algorithms while
preserving these requirements. Record acoustic uncertainty and unperformed
native checks explicitly; do not substitute automated mocks for listening evidence.
