# Hybrid retake detection experiment

Status: Deferred experiment. The previous retake detector is not being shipped.
This plan does not change transcription or enable automatic cuts.

## Question

Can a fast, readable Whisper transcript locate enough suspicious audio regions to
run a verbatim recognizer only there, while retaining the retake recall and safe
cut boundaries of a full verbatim transcript?

Whisper may omit fillers and restarts. Its word timestamps describe the words it
kept; they cannot establish the content or exact boundaries of speech it omitted.
The experiment must treat gaps as leads, never as automatic cuts.

## Proposed pipeline

1. Produce the ordinary timed Whisper transcript and a speech-activity map for
   the surviving source audio. Keep both as read-only analysis inputs.
2. Find speech regions poorly covered by timed words. Add nearby repeated words,
   pauses, corrections, and uncertain timing as secondary signals. Retain enough
   context on both sides for the next pass.
3. Transcribe only ranked regions with a verbatim model. Convert its words to
   source-time anchors, deduplicate overlapping regions, and reconcile them
   with the Whisper transcript without silently rewriting user corrections.
4. Test conservative retake hypotheses and semantic review on the enriched
   local words. Reject candidates whose attempts or cut bounds cannot be tied
   to audible source spans.
5. Show the original and proposed edit for listening. Detection never cuts
   automatically; acceptance remains one undoable edit.

The abandoned transcript-only detector started from words already in the project
transcript. It could not propose a cut around omitted speech. A prototype needs a separate
read-only analysis track for provisional words and occurrence-scoped source
spans before considering any project-format change.

## Evaluation

- Label short excerpts with actual attempt boundaries and a keep/omit decision:
  omitted fillers, “requests and requests [UH] responses,” “JSON is a JSON is
  common,” an abandoned sentence, a reworded attempt, and a spoken correction.
- Include negatives: “post a post,” the “seat field / seat num / seat” list,
  emphasis, and repeated technical terms. Include a retake Whisper fully
  normalizes away and one whose timestamps span the omitted audio.
- Compare full verbatim transcription, Whisper-only leads, and the hybrid
  pipeline. Measure candidate recall, false reviews per recording hour,
  correct attempt boundaries, word-timing error, total runtime, and peak memory.
- Run the cut planner only on candidates with verified source anchors. Listen
  to proposed joins and verify save/reopen, undo, captions, and export.

## Decision gate

Advance only if the hybrid catches the known omitted restarts, keeps the
negative examples out of review, and substantially reduces verbatim inference
time on representative recordings. If speech-coverage gaps have poor recall,
test acoustic repeat detection or another cheap proposal signal before adding
complexity to the editor. Preserve full verbatim transcription as an option.
