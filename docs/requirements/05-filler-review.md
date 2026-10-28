# Feature 5: Review filler words one at a time

Status: Feature request draft. The desired review actions are recorded here;
interaction details and detection policy remain open for the next conversation.

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

## Questions for the next conversation

- Which tokens should be highlighted automatically? Should ordinary words
  such as “like”, “so”, “right”, and “okay” require context or explicit opt-in?
- Should bracketed model tokens (`[AH]`, `[UH]`, `[UM]`, and others) be displayed
  as-is, normalized for display, or configurable?
- What should **Keep** do to the current review queue: dismiss only for this
  run, or persist a reviewed state after save/reopen?
- Should the review flow include a “skip for now” action distinct from Keep?
- Should the user be able to adjust proposed audio-cut boundaries before
  accepting, especially near a neighboring word or breath?
- Should the existing bulk filler controls remain, move behind an advanced
  action, or be replaced by the review flow?

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

No implementation order relative to script assistance is decided here.
