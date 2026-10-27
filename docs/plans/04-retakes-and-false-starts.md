# Implementation plan: feature 4 — retakes and false starts

Status: Implementation underway in a gh-stack rooted at
`feature/transcript-correction-completion` (`2be7298`). Source of truth:
[accepted requirements](../requirements/04-retakes-and-false-starts.md).

## Implementation checkpoints

- Phase 0: synthetic semantic feasibility established with MLX 0.32.4,
  mlx-lm 0.32.2, and pinned Apache-2.0 Qwen3-8B-4bit weights. The manifest
  records the revision and SHA-256 of every downloaded file. Model files remain
  ignored workspace artifacts; they are not committed or sent to a service.
- Design adjustment from measured failures: direct model span extraction was
  unreliable in both 4B and 8B fast modes. Code forms bounded hypotheses from
  neighboring sentences, explicit restart markers, and short interrupted
  repetitions within a sentence. The model may select one of up to three fixed
  span options or return keep/uncertain. It cannot invent spans. Exact adjacent
  stutters use the independent deterministic detector. Interrupted candidates
  require the presenter to choose the take to keep.
- Regression examples: “requests and requests [UH] responses” and “JSON is a
  JSON is common” reach review with safe cut choices. “Post a post” and “seat
  field seat num or seat” are filtered as grammatical repetition and a list.
  Cut tests verify that the retained wording remains intact.
- The 8B semantic contract passes the initial synthetic correction, abandoned
  start, low-overlap rewording, incomplete-final-take, emphasis, elaboration,
  terminology, and list checks. This is development evidence, not measured
  accuracy on representative lectures. Those recordings have been requested.
- MLX was selected for the initial implementation because its development and
  packaging infrastructure already exists here. No native-runtime speed
  comparison was performed. The 4B direct-extraction approach failed; unbounded
  8B reasoning was stopped for latency. Record final runtime and memory evidence
  in the acceptance audit. Target 16 GB or greater Apple Silicon for this model;
  do not promise the earlier 3B model's 8 GB footprint.
- The review workflow now also supports user-selected installed Ollama models
  through the local Ollama API. This avoids the pinned MLX download when it is
  unavailable. The same bounded hypotheses and strict result validation apply;
  semantic quality for each Ollama model remains unmeasured on real lectures.
- Baseline: all 171 frontend tests and all 46 native library tests pass.
- Stack layers: `feature/retakes-00-feasibility`, then phases 01 (detector),
  02 (cut transactions), 03 (native workflow), 04 (audition), 05 (review UI), and
  06 (acceptance/documentation). Each later branch is added with `gh stack add`.

## Outcome and approach

Deliver an explicitly invoked, local detector that proposes nearby retake groups.
The presenter can listen to the original, select any attempt, preview the joins,
then accept one undoable edit or dismiss the group. Detection and audition never
change the saved project, its dirty state, or source media.

Use deterministic matching for obvious restarts together with a local semantic
model for rewordings, corrections, and distinguishing restarts from elaboration.
Keep detection separate from a deterministic cut planner. A model identifies
existing transcript spans; it never supplies executable cuts, new timestamps,
replacement words, or project mutations.

The semantic approach must pass an early evaluation gate before investing in the
full review UI. Exact matching alone is an internal milestone, not feature
completion. Script assistance is useful but is not a prerequisite.

## What the current code provides

| Area | Reuse and required change |
|---|---|
| `src/lib/transcript.ts` | `projectTranscript` gives corrected text, occurrence/block/run IDs, anchor associations, and source/output bounds without changing the project. Build analysis input from this projection. |
| `src/lib/transcriptEdits.ts` | Existing cuts protect corrected timing groups and reconcile overlays. Add an occurrence-scoped interval transaction for explicit pause removal; text selections alone cannot express all retake cuts. |
| `src/lib/edl.ts` | Segments define surviving playback; `deleteWords` pads retained speech. Reuse these invariants, but validate padding against adjacent discarded speech. |
| `src/stores/projectStore.ts` | `commitTranscript(next, expected)` validates and commits a single project-history step. `projectSession()` also guards project replacement across asynchronous work. |
| `VideoPreview.tsx`, `playerStore.ts`, `useVideoFrameClock.ts` | Playback already tracks repeated occurrences in output order. Extract the timeline playback machinery so a separate audition player can reuse it. There is no temporary-preview timeline API yet. |
| `Toolbox.tsx` | Add the detection entry point; present review in a dedicated dialog/panel rather than extending filler removal. |
| `src-tauri/src/jobs.rs`, `src/lib/ipc.ts`, `jobsStore.ts` | Add a matching retake-analysis job kind, progress, cancellation, and typed request/result contracts. Job persistence stores status, not detection payloads or a resumable review queue. |
| Native project/snapshot/export code and `src/lib/captions.ts` | Accepted edits remain ordinary EDL/overlay changes. No new persisted candidate format or project-version change is expected. Verify video and corrected-caption exports. |

### Local model integration is a decision, not an existing service

Commit `27f9636` removed the MLX process manager, commands, UI, feature flag, and
bundled sidecar entry in v3.4.0 to remove the Python/PyInstaller/MLX dependency
along with AI chapters and b-roll. See [the changelog](../../CHANGELOG.md#340---2026-05-21).
The Python code remains under `sidecars/mlx-llm/`; the earlier native integration
is available at `074d1d3`. Some roadmap, architecture, and build-script references
still describe the older integration and are not evidence that it currently runs.

Start the semantic feasibility spike by inspecting that retained MLX code and
evaluating a small local instruction model through its JSON-line protocol.
Restoring MLX is a valid option; removal was not a recorded quality verdict.
Compare its packaging and runtime cost with a native `llama.cpp` sidecar before
choosing the shipping runtime. The latter supports [Metal builds](https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md)
and [grammar-constrained output](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md);
these capabilities make it an evaluation alternative, not proof of detection quality.

Record the selected runtime/model revision, license, download size, peak memory,
cold/warm latency, supported Mac baseline, output validation, cancellation, and
release-signing requirements. Pin the selected artifacts and verify downloads.
Reuse the model-download UX, with explicit model setup and a clear unavailable
state. Missing models or inference failures must not masquerade as zero candidates.
Do not install tooling or download models just to implement this planning document.

## Analysis and candidate contracts

### Snapshot and timing

- Capture project identity, session generation, and the immutable project
  reference before analysis. Carry a run ID through every async result.
- Flatten surviving projected runs in output order. Use corrected display text
  for matching, retain original text for inspection, and preserve hidden runs as
  audible anchors. Empty display text is not a silence or permission to cut audio.
- Analyze each uninterrupted sequence of the same media in playback order.
  Adjacent segments from that media may participate across existing cuts, but
  retain the gaps and occurrence identities. Never reconstruct removed words or
  compare across another recording inserted between them.
- Measure the 30-second default between successive attempt starts on the current
  output timeline, inclusive at 30 seconds. A take may end later. For chains,
  every successive start must satisfy the window. Keep source bounds alongside
  output bounds; source times alone cannot identify reused media occurrences.
- Read-only normalization stays local to analysis. Do not attach overlays or
  update timestamps in the live store just to run detection.

Suggested transient types in `src/lib/retakes.ts`:

```ts
type RetakeKind =
  | "word-stutter" | "phrase-restart" | "abandoned-start"
  | "spoken-correction" | "reworded-retake";

interface RetakeAnchorRef {
  segmentId: string;
  occurrenceId: string;
  runId: string;
  anchorIds: string[];
  // Resolve within the captured occurrence; never globally by word ID.
}

interface RetakeAttempt {
  id: string;
  spans: RetakeAnchorRef[];
  completeness: "complete" | "fragment" | "uncertain";
}

interface RetakeCandidate {
  id: string;
  kind: RetakeKind;
  attempts: RetakeAttempt[];
  suggestedAttemptId?: string;
  explanation: string;
  // Also carry shared context, restart/correction markers, and the
  // occurrence-scoped envelope whose proposed removals must stay inside it.
}
```

The run owns the snapshot/revision and candidate states: unresolved, accepted,
dismissed, or invalidated. Candidate identity derives from ordered occurrence
anchors, not list indices or text alone. Source and output bounds are resolved
and validated against the snapshot; cached numeric positions are never authority.

### Detection pipeline

1. Form overlapping context windows with stable run/anchor labels. Do not rely
   exclusively on punctuation or paragraphs: recognition often hides the restart
   at exactly those boundaries. Include the continuation of long final takes.
2. Generate lexical hypotheses from repeated tokens/prefixes and explicit restart
   or correction markers. Single-word overlap, emphasis, or common technical
   vocabulary alone is insufficient evidence.
3. Analyze all eligible nearby context windows semantically, including windows
   with no lexical match. Otherwise rewordings with different vocabulary would
   never reach the model. Batch work and deduplicate overlap by anchor identity.
4. Ask the model for labeled existing spans, restart evidence, attempt
   completeness, shared context, and abstention when uncertain. Distinguish
   clarification/elaboration, quotations, lists, emphasis, and another speaker's
   response from an abandoned attempt. Use known speaker changes as negative
   evidence without requiring diarisation.
5. Validate model output strictly: known ordered spans, same recording sequence,
   valid timing groups/window, finite limits, and no invented words or times.
   Treat transcript text as data, including instruction-like speech. Invalid
   results fail safely and cannot reach the cut transaction.
6. Combine compatible evidence into groups. Merge only attempts at the same
   thought with compatible boundaries; transitive proximity alone must not merge
   unrelated retakes into one large deletion. Resolve incompatible overlapping
   hypotheses conservatively or omit them. Produce disjoint review envelopes.
7. Suggest the last attempt assessed as complete. A final fragment cannot displace
   an earlier complete take. Leave the suggestion unset or omit weak candidates
   when completeness or boundaries remain uncertain.

Keep threshold decisions reproducible and versioned internally. Do not display
model self-reported confidence as calibrated probability. Use ordinary fixed
labels for explanations and short evidence from the actual passage.

## Deterministic cut planning

Add `src/lib/retakeCuts.ts` with a pure API along these lines:

```ts
planRetakeCut(project, candidate, keptAttemptId) => {
  removals, nextProject, occurrenceRemap, originalAudition, editedAudition
}
```

The plan records validated occurrence/source intervals, the resulting project,
and source-anchored audition bounds. Both preview and acceptance use this exact
plan. Acceptance rechecks the current project/session before committing it.

Policy:

- Keep the selected attempt in its original output location; do not move or
  rewrite speech. Preserve shared introductions, completed continuations, and
  unrelated surrounding words.
- Distinguish competing spans from shared speech. For “Use POST—sorry, PUT”,
  keep “Use” with either choice; remove the discarded term and correction marker
  appropriately. For “The—the server returns a response”, keeping the earlier
  “The” must still preserve the unique “server returns a response” continuation.
  If this mapping is ambiguous, omit the candidate rather than broadening a cut.
- Remove discarded attempts, associated restart markers, and intervening pauses.
  Define gap ownership explicitly for last, first, and middle selections: retain
  one join between surviving speech spans, not a dangling pause from a removed
  attempt. Preserve context outside the candidate envelope.
- Compute all removals from one pre-edit snapshot. Intersect each interval with
  surviving segments only; never fill an already removed source gap. Support
  silence-only portions and multiple discarded attempts in the same transaction.
- Honor `settings.paddingMs` around retained speech, clamp to segment bounds,
  and ensure padding does not replay discarded word anchors. Overlapping word
  timestamps or indivisible corrected groups may make a clean cut impossible.
  Reject the proposal with an explanation instead of clipping retained speech or
  silently expanding through unrelated audio. No manual boundary editor in v1.
- Include hidden audible anchors in safety validation. Reuse
  `reconcileTranscript` and full-project validation for every retained segment;
  partial corrected-group cuts and invalid empty spoken blocks remain rejected.
- Commit the entire `nextProject` once through `commitTranscript`, with no typing
  key, so two or more removed intervals are one undo/redo action.

Add a general occurrence-scoped interval helper to the existing edit layer if
needed; do not call global word-ID or source-range deletion actions. Their
matching can affect another occurrence and word deletion alone does not express
all silence trimming. Preserve unaffected project fields and current chapter/
music semantics; broader chapter or music retiming is a separate concern.

## Audition and review state

Use a dedicated review dialog with candidate count, context, attempt choices,
suggested-take label, explanation, Play original, Preview cut, Accept cut, and
Dismiss. Offer a clear no-transcript prompt and an ordinary empty-result state.
Do not preselect an uncertain preferred take; require a choice before preview
or acceptance in that case.

Extract a shared occurrence-aware timeline playback controller from
`VideoPreview.tsx`, keeping its repeated-media regression tests. Give the review
dialog a separate player instance/state, supplied with either the snapshot or
the proposed project's timeline. Pause the main player during audition; review
playback must not publish preview times to the committed transcript/waveform.
Use the same controller for both players so seeking and segment transitions do
not acquire independent implementations.

Default audition context: up to two seconds before and after the candidate,
clamped to surviving playback. Map context by occurrence/source anchors into
the edited project, not by reusing pre-cut output seconds. Include every proposed
join; stop at the context endpoint. Changing the selected take stops the old
audition and replaces the plan. Clearly label Original versus Proposed cut.
Transport shortcuts while the dialog is active target audition; editing shortcuts
cannot accidentally cut the main project. Closing, switching projects, or
invalidation stops audition and removes all temporary playback state.

Listening is available before any edit and never implies acceptance. Do not add
a forced-listening unlock unless separately requested. Accept remains an explicit
action; preview, dismissal, and cancellation produce no undo entries or autosaves.

### Queue validity after changes

- Cancellation discards pending analysis and late results. Native cancellation
  must also stop inference/work, not merely hide frontend progress.
- Any external project replacement/edit, including undo/redo, conservatively
  invalidates the run and stops its preview. Ask the user to rerun detection;
  do not silently apply or refresh an old selection. Save completion alone does
  not change the immutable project reference and should not invalidate it.
- Own acceptance is a controlled exception: the interval transformation returns
  an explicit old-occurrence/anchor to new-segment mapping. Rebase remaining
  nonoverlapping candidates through that map, revalidate unchanged text, anchors,
  context, order, and window, and recompute output positions/plans. Invalidate
  any candidate whose assumptions no longer hold. Never search globally for a
  matching source word after a split.
- Track accepted/dismissed candidate envelopes for the run. Deduplication and
  queue updates cannot reintroduce them as overlapping pairs. A fresh explicit
  detection run may show dismissed material again; queue state is not persisted.
- Undo restores the accepted project's complete edit through normal history and
  invalidates the old run. Redo reapplies the edit, not an old detector response.

## Implementation phases and gates

| Phase | Deliverable | Exit gate |
|---|---|---|
| 0. Fixtures and semantic feasibility | Inspect retained MLX integration; compare runtime options; label representative lecture excerpts; prototype semantic span extraction and record model/runtime decision. | Rewording/correction cases work beyond literal overlap, emphasis/elaboration negatives are evaluated, and memory/latency/packaging are acceptable on the chosen Mac baseline. Record failures honestly before UI work. |
| 1. Analysis model and pure detector | Add snapshot projection, labeled windows, lexical evidence, semantic adapter contract, strict result validation, grouping, and stable candidate identities. | Deterministic fixtures cover every detection class, window boundaries, chains, incompleteness, hidden/corrected runs, reused media, existing cuts, and multi-recording boundaries. |
| 2. Cut transactions | Add interval removal, shared-context policies, padding validation, exact plans, occurrence remaps, and one store acceptance action. | Last/first/middle choices including three attempts preserve unrelated/shared speech; all cuts are atomic; stale/invalid proposals leave state untouched; one undo/redo restores/reapplies all intervals. |
| 3. Native detection workflow | Integrate selected runtime/model setup, typed IPC, analysis job kind, batching, progress, cancellation, and project/run guards. | Offline inference after setup; missing/corrupt model, malformed output, process failure, cancellation, and late completion handled without project mutation. Release packaging works without assuming a developer's Python environment. |
| 4. Temporary audition | Extract timeline controller; connect separate original/proposed audition state and bounded context. | Actual player integration tests cover joins, occurrence identity, seek/end behavior, take changes, dialog close, and invalidation; preview timeline equals the accepted cut plan. |
| 5. Review UI and queue | Add Toolbox entry, grouped review dialog, any-take selection, dismissal, acceptance, queue rebasing, empty/error states, and keyboard behavior. | End-to-end UI sequence resolves a group and continues to valid remaining candidates; all nonaccepting actions leave project/history/dirty state unchanged. |
| 6. Acceptance and release | Evaluate held-out lecture excerpts, native audition, persistence, video/caption exports, source hashes, documentation, and release checks. | Every requirements acceptance criterion has evidence; unverified native/model behavior stays explicitly marked. |

Each phase should be a reviewable commit or small set of commits. Phase 0 is the
main uncertainty; phases 1–3 form the analysis/editing foundation. Phase 4 is a
playback change requiring the same care as the earlier repeated-occurrence fix.
Overall size: L/XL, rather than a small extension of filler-word removal.

## Validation and handoff

Keep deterministic correctness separate from detector quality:

- Proposed frontend suites: `retakes.test.ts`, `retakeCuts.test.ts`,
  `retakeWorkflow.test.ts`, `retakeReview.test.tsx`, and audition integration
  coverage alongside `videoOccurrence.test.tsx`. Include canceled/stale async
  responses, project close/reopen, repeated IDs, corrected groups, Unicode,
  padding conflicts, silent intervals, and a second candidate after acceptance.
- Native protocol/process tests use controlled outputs, including unknown span
  IDs, oversized/malformed responses, timeout, cancellation, and restart. Actual
  model evaluation is a separate explicit run, not a mocked unit-test claim.
- Split lecture examples by recording into development and held-out sets. Report
  candidate precision/recall by type, false positives per lecture minute, group
  boundaries, preferred-take errors, unsafe/uncuttable suggestions, latency, and
  memory. Include low-overlap rewordings and recognition errors. Decide numerical
  quality/performance gates from the phase-0 baseline before tuning on the
  held-out set; no invented accuracy promise in advance.
- Native manual checks: detect → listen original → preview last/first/middle →
  dismiss → accept → undo/redo → save/reopen → export video and SRT/VTT. Verify
  joins by ear, output duration and corrected caption content/timing, and hashes
  of all source files. Test three attempts and reused media. Mock playback alone
  cannot establish audible cut quality.
- Run frontend tests, typecheck/lint, relevant Rust tests, selected runtime tests,
  and a native release build when implementing. This documentation-only change
  does not require building or running the application.

At phase completion, record commits, test/evaluation evidence, model/runtime and
threshold revisions, changed decisions, and exact outstanding work here or in a
linked acceptance audit. Update the requirements' planning status once this plan
is agreed. At release, update user instructions and remove contradictory MLX
build/architecture claims in the paths actually affected by the chosen runtime.
