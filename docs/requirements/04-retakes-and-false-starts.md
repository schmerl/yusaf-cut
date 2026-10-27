# Feature 4: Repeated phrases, retakes, and false starts

Status: Implemented on the retakes feature stack. Automated checks pass for the
detector, cut transactions, review workflow, and native protocol. Native listening,
export, and accuracy on representative recordings remain manual acceptance work.

## Goal

Help a presenter remove unwanted nearby attempts at the same thought from a
recorded lecture. This includes literal repetition, stutters, abandoned starts,
rewordings, and spoken corrections. Detect likely candidates conservatively,
then let the presenter listen and decide which attempt to keep.

## Confirmed decisions

| Area | Requirement |
|---|---|
| Search scope | Nearby repetitions and retakes, within roughly 30 seconds, including short pauses |
| Sensitivity | Conservative: missing subtle retakes is preferable to flagging intentional elaboration |
| Detection types | Single-word stutters, phrase restarts, abandoned sentences, reworded attempts, and spoken corrections |
| Grouping | Present related attempts together as one review item |
| Suggested take | Suggest the last complete take, while allowing the user to keep any take |
| Review | Review each candidate with audio playback before accepting a cut |
| Playback | Provide both the original passage and a preview of the proposed edited result |
| Cut scope | Remove discarded attempts and intervening pauses |
| Automatic changes | Detection alone never cuts audio/video |

## Examples

These illustrate candidate types, not a rule that every superficially similar
passage must be removed.

| Passage | Candidate interpretation |
|---|---|
| “The—the server returns a response.” | A word stutter; suggest keeping the completed continuation |
| “The server—the server returns a response.” | A phrase restart |
| “A request should include… Let me start again. A request includes a method and a target.” | An abandoned sentence followed by a completed retake |
| “Use POST—sorry, PUT.” | A spoken correction; suggest the corrected continuation |
| “The operation can be repeated. You can retry the operation without changing the outcome.” | A possible reworded take, only when surrounding context supports a restart rather than deliberate explanation |
| “It is very, very important.” | Potential deliberate emphasis; do not flag by repetition alone |
| “REST” mentioned throughout a lecture | Recurring terminology, outside the purpose of this feature |

Rewordings and corrections are part of the requested scope. A detector that
only matches identical word strings does not satisfy the feature.

## Detection behavior

1. Analyze the current surviving transcript in playback order. Already removed
   speech must not generate new candidates.
2. Find plausible restarts within the nearby search window, including short
   intervening pauses. Normal repeated terminology and intentional elaboration
   should not be flagged solely because they use similar words.
3. Group related attempts into one candidate rather than presenting overlapping
   pairwise duplicates. A group may contain more than two attempts.
4. Suggest the last complete take when there is enough evidence to identify it.
   Do not present a fragment as complete merely because it is last. When the
   preferred take is unclear, leave the decision to the user or omit the
   low-confidence candidate.
5. Briefly explain each candidate in ordinary terms, such as “word stutter”,
   “phrase restart”, or “possible reworded retake”.
6. Run detection without mutating transcript text, timeline segments, source
   media, or the project's dirty state. Detections remain proposals until a
   candidate is accepted.

### Operational defaults for implementation

These make the requested behavior concrete; they are product defaults rather
than claims made by the user about the detector's internals.

- Use a 30-second comparison window between the starts of successive attempts.
  A completed take may finish outside that window. A chain of nearby attempts
  can be grouped when successive starts satisfy the window.
- For the first version, compare attempts within the same source recording.
  Do not infer retakes across different imported recordings.
- Analyze locally, consistent with the application's local-first workflow.
  The choice of local algorithms or models belongs to implementation design.
- Detection is explicitly invoked. Automatic background detection and adjustable
  sensitivity/window controls are outside the initial scope.

## Review workflow

1. The user starts detection on a project with a transcript.
2. The app shows progress and allows cancellation without changing the edit.
3. The result list shows candidate groups in current playback order. Each group
   includes the competing transcript passages and enough surrounding context to
   judge whether they represent unwanted attempts.
4. The suggested take is clearly identified. The user can choose any take in
   the group, including an earlier one, or dismiss the whole candidate.
5. **Play original** auditions the full group with surrounding context.
6. **Preview cut** auditions the proposed result, including the joins to the
   surrounding speech. Preview does not commit edits or alter source files.
7. Changing the selected take updates the proposed cuts and their preview.
8. **Accept cut** applies that candidate's proposed removals. The user then
   proceeds to the next unresolved candidate.
9. A group containing three or more attempts can be resolved in one acceptance
   action, keeping the chosen take and removing the others.

The interface must make the difference between original playback, proposed
playback, and an accepted edit clear. It must not silently interpret listening
to a preview as accepting a cut.

## Cut and timeline behavior

- Remove the discarded spoken attempt and the pause leading into the kept
  continuation. Keep the selected take and surrounding unrelated speech.
- If the user keeps an earlier or middle take, compute the corresponding
  removals around that choice; do not always remove the first attempt.
- Preserve natural word boundaries and the existing protection against clipping
  consonants. Preview and committed playback must use the same proposed cuts.
- Apply cuts through the existing edit-decision model. Source audio/video files
  remain unchanged.
- Each accepted candidate is one undoable operation, even when it removes more
  than one interval. Undo restores the entire candidate's cuts; redo reapplies
  them.
- Accepted cuts update preview, project duration, transcript, and subsequent
  video/caption exports through the edited timeline. This feature does not
  generate replacement speech or rewrite surviving words.
- Save/reopen preserves accepted cuts through the normal project format.

## Candidate lifecycle

- Dismissing a candidate makes no edit and should keep it out of the remaining
  queue for that detection run.
- An accepted or dismissed group must not immediately reappear as another
  overlapping pair within the same run.
- If other transcript/timeline edits change a candidate's underlying words or
  source ranges, invalidate it or recalculate it before allowing acceptance.
  Never apply stale numeric positions to unrelated speech.
- Detection results and dismissals do not have to persist after closing the
  project in the first version. Accepted edits do persist.
- An empty result is a normal outcome and should be reported clearly.

## Scope boundaries

The initial feature does not:

- Find repeated ideas throughout an entire lecture or across recordings.
- Automatically cut detected speech or offer an unreviewed “remove all” action.
- Judge whether a technical statement is factually correct.
- Use a teleprompter script as an authoritative account of what was said.
- Correct transcript spelling, punctuation, or capitalization; that is feature 3.
- Require importing a script; script-assisted terminology correction is feature 2.
- Provide a general-purpose manual cut-boundary editor inside the review UI.
- Promise detection of every semantic retake or exact accuracy percentages
  before evaluation on representative lecture excerpts.

## Acceptance criteria

### Candidate detection and conservatism

- Word-stutter, phrase-restart, abandoned-sentence, correction, and reworded-
  attempt fixtures each produce appropriate candidates when restart evidence
  is present.
- Repeated technical terms at distant points do not produce retake candidates.
- Deliberate emphasis and intentional elaboration fixtures are not flagged
  merely because their words overlap.
- Nearby-window boundary cases obey the documented 30-second default.
- Three attempts at one thought produce a grouped review item, not duplicate
  overlapping pairwise suggestions.
- A later incomplete fragment is not automatically preferred to an earlier
  complete take.

### Human review

- The user can hear both the original passage and the proposed result before
  accepting any edit.
- Selecting an earlier or middle take changes the preview and proposed cuts.
- Dismissal, preview, cancellation, and merely running detection leave the
  project and source media unchanged.
- Accepting a candidate removes the discarded attempts and intervening pauses
  while preserving the chosen take and adjacent unrelated speech.

### State and export integrity

- One undo restores all intervals removed by one accepted candidate; redo
  reapplies them.
- Accepted cuts survive project save/reopen and appear in subsequent video and
  caption exports.
- Editing the timeline after detection cannot make an old candidate cut the
  wrong passage.
- All source media files remain unchanged.
- A project with no transcript prompts the user to transcribe before detection;
  a project with no candidates reports that outcome without an error.

## Validation approach

Use deterministic examples to test grouping, review state, proposed cut spans,
undo/redo, and stale-candidate handling. Evaluate detection quality separately
on labeled representative lecture excerpts, including intentional repetitions,
semantic rewordings, technical vocabulary, and transcription mistakes. The
local semantic-detection approach must be evaluated before declaring the
rewording requirement satisfied; simple string matching alone is insufficient.

## Implementation order

Suggested order for the requested features:

1. Caption export repair — implemented.
2. Manual transcript corrections (feature 3) — requirements defined in
   [03-transcript-corrections.md](03-transcript-corrections.md).
3. Script-assisted terminology/capitalization correction (feature 2).
4. Repeated phrases and false starts (this feature).

Manual and script-assisted corrections provide ways to repair recognition
mistakes that could otherwise confuse detection. Script assistance remains a
separate feature; this detector must work without a supplied script. This
ordering is a planning recommendation, not a requirement to couple the
implementations.
