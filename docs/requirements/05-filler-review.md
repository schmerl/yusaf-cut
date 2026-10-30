# Feature 5: Review filler words one at a time

Status: Review workflow implemented on 2026-10-29, ready for human native
acceptance. Automated validation is recorded in the plan; live playback and
export listening checks remain pending. Start with the
[hands-on checkpoint](../filler-review-checkpoint.md).

Agent handoff: [detailed implementation plan](../plans/05-filler-review.md).

## Confirmed decisions (2026-10-29)

- Highlight vocal fillers by default, including CrisperWhisper bracketed forms
  such as `[AH]`, `[UM]`, and `[UH]`. Preserve the recognized spelling on display;
  normalize only for matching. Ordinary words and phrases require explicit opt-in.
- Provide a selectable built-in list plus custom literal words/phrases. Store
  detection choices in the project. Candidates are for human review, without an
  automatic claim that an ordinary word is functioning as a filler.
- Include audible fillers previously hidden by text-only editing. Mark them
  **Text removed, audio retained**; exclude resolved text-only decisions from the
  default unresolved queue and expose an **Audio retained** filter.
- Open a review panel alongside the transcript through **Review fillers**.
  Replace the existing bulk filler buttons in the first version.
- Persist **Keep** in the project and provide a way to revisit kept occurrences.
  **Skip** defers an occurrence for the current review session only.
- Do not advance after Keep, Remove text only, or Cut filler speech. Keep the
  current item available for listening and undo; navigation is explicit. Skip
  moves to another occurrence as its deferral action.
- Playback is explicit. Provide before, proposed-cut preview, committed-result
  playback, and Stop, with adjustable surrounding context and optional looping.
  Default context is two seconds on each side; looping defaults off. Context and
  loop settings are session state and reset when the app reopens.
- Adjust cut start and end independently with millisecond offsets and 10 ms
  nudge buttons. Default offsets are zero relative to the recognized boundaries.
  Adjustments may retain filler edges or remove extra surrounding gaps, but must
  not cut neighboring word spans or cross existing edit boundaries.
- Cut filler speech removes the entire candidate's transcript text/caption text,
  even when adjusted boundaries retain some of its audio edges. Playback follows
  the chosen boundaries; the preview must make those retained edges apparent.
- Disable text-only removal if it would leave a spoken paragraph without text.
  Explain the restriction. Do not loosen the existing nonempty-paragraph rule.
- If a correction groups the filler with neighboring words, allow listening and
  Keep/Skip, but disable its isolated speech cut. Do not silently expand the cut.

Defaults for token inventory, overlap handling, occurrence identity, and replay
history are specified as implementation decisions in the plan, with validation
gates before the review UI is built.

## Native review refinement — audio-informed boundaries (2026-10-29)

For implausibly short or uncertain recognition spans, the app should calculate an
initial editable audio estimate rather than ask the user to guess offsets. The
previous token's end and next token's start (including text-hidden anchors),
constrained by current EDL boundaries, define the search limits. Audio activity
near the recognized occurrence informs the proposed onset/end; the entire pause
between neighboring words is not automatically removed.

This supersedes the raw zero-offset-only default for those occurrences. Original
recognition anchors remain unchanged. Opening review, estimation and preview do
not dirty the project; only explicit acceptance commits a cut. Manual overrides
win over delayed estimates, and ambiguous audio falls back to an explanation and
manual adjustment. Normal occurrences retain recognized timing unless the user
chooses **Estimate from audio**. **Use recognized timing** restores zero offsets.

## Goal

Make audible fillers easy to find and review without assuming every filler should
be cut from the recording. The user should be able to choose independently
whether a filler appears in the transcript and whether its audio remains.

## Reported problem

- CrisperWhisper can return fillers such as `[AH]`, but they are not reliably
  highlighted in the text editor by default.
- Existing **Remove fillers** and **Cut filler speech** controls act on selected
  token types in bulk. The user wants to listen to each occurrence and preview
  its proposed change before accepting it.
- The current bulk action cuts matching speech. The user also needs to remove a
  filler from transcript text and captions while keeping the recorded sound.

The code currently has different filler lists for word highlighting, the
toolbox action, and the transcript search panel. The feature should define one
consistent recognition policy, including bracketed model tokens, without
silently treating every use of an ordinary word such as “like” as a filler.

## Requested behavior

1. Highlight recognized filler occurrences in the editable transcript when a
   transcript is opened or created. Bracketed tokens such as `[AH]` and `[UH]`
   should be considered, as should case and surrounding punctuation.
2. Provide an explicitly invoked review flow that moves through surviving
   filler occurrences in playback order, one occurrence at a time. Show nearby
   transcript context and the current item's position in the review queue.
3. Let the user audition the original passage and preview the proposed result
   before committing an audio cut. Preview must leave the project unchanged.
4. For each occurrence, offer at least these outcomes:
   - **Keep** the filler and its audio.
   - **Remove text only** from the transcript and captions, retaining the audio.
   - **Cut filler speech** from the edited playback and transcript.
5. Make each accepted change individually undoable. A decision on one
   occurrence must not automatically apply to every identical token.
6. Preserve source media. Accepted audio cuts use the edit timeline; text-only
   removal uses the existing transcript correction model and does not change
   playback duration.
7. Keep the review queue valid after edits, undo/redo, re-transcription, and
   project reload. Never apply a stale selection to a different source span.

## Design constraints

- Highlighting and opening the review flow do not change audio, transcript
  content, or the project's dirty state.
- A highlighted item is a candidate, not a recommendation to delete it.
- Explain the effect of each action on audio, transcript text, and captions in
  the UI. In particular, text-only removal must not be described as a cut.
- Audio-cut previews should include enough context to judge whether the join
  clips neighboring speech. The committed cut must match the preview.
- Respect the existing rule that a surviving spoken paragraph cannot have an
  empty transcript. If a text-only removal would violate it, explain why the
  action is unavailable or offer a safe alternative.
- Continue to support manual transcript editing and explicit speech cuts
  outside this workflow.

## Implementation defaults

See the plan for the exact initial token inventory, literal phrase matching,
candidate reconciliation after corrections/cuts, and guarded playback lifecycle.
These are engineering defaults rather than additional user-confirmed choices.

## Initial acceptance examples

- `[AH]` and `[UH]` produced by CrisperWhisper are highlighted when the
  transcript first appears, and their occurrences appear separately in review.
- Choosing **Remove text only** for one `[AH]` removes that occurrence from
  transcript display and captions while playback and duration remain unchanged.
- Choosing **Cut filler speech** previews and then removes only that occurrence
  from edited playback; undo restores it.
- Keeping or skipping one occurrence does not change a later occurrence of
  the same token.
- An ordinary content use of “like” is not offered for an unsafe automatic cut.

Implement this feature before script assistance, using the existing manual
correction foundation. Script assistance is not a dependency.
