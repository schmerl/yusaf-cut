# Feature 2: Use a teleprompter script to improve a transcript

Status: Feature request draft. The role of the script and candidate workflows
are recorded here; model support, review design, and evaluation remain open for
the next conversation.

## Goal

Use the script from a recording session as a source of terminology and writing
conventions when correcting the recognized transcript. Spoken words may differ
from the script, so the script must not silently replace the account of what
was actually said.

## Reported need

The user has teleprompter scripts that can help resolve technical terms,
misrecognitions, casing, and capitalization. For example, a script may clarify
whether the speaker meant “REST”, “OpenAPI”, or a particular field name. It may
also contain sentences the speaker changed, skipped, or repeated while
recording. The useful part is guidance about likely wording, not an assumed
word-for-word match.

## Requested outcomes

1. Allow a user to supply a script associated with a recording or project.
   The supported import formats and whether the script is retained in the
   project are open decisions.
2. Identify plausible transcript corrections supported by both the audio or
   recognized words and the script. Prioritize terminology, spelling,
   capitalization, and casing; consider punctuation and short misrecognitions.
3. Show proposed corrections with transcript context and the relevant script
   passage. The user can accept, edit, or dismiss individual suggestions.
4. Keep the original recognized text and source-time anchors available, using
   the existing manual correction model. A text correction must not change
   audio/video, cut speech, or claim exact new word timings.
5. Preserve real departures from the script, including fillers, repetitions,
   retakes, and ad-libbed speech, unless the user explicitly edits or cuts them.
6. Make accepted changes undoable and persistent through save/reopen and
   caption export. Re-running assistance must not overwrite earlier manual
   corrections without explicit review.

## Approaches to investigate

These are alternatives for evaluation, not implementation decisions:

- **Recognition-time hints:** Check whether the bundled CrisperWhisper model
  and its current `transcribe` API support prompts, vocabulary hints, or other
  safe biasing. Measure whether hints improve terms without making the model
  invent scripted words or suppress actual fillers and deviations.
- **Post-transcription suggestions:** Align script passages loosely to timed
  transcript passages, then propose text-only corrections for review. This can
  preserve the verbatim recognition result as evidence.
- **A combined workflow:** Use a short glossary or selected script context at
  recognition time, then review remaining corrections afterward.

The current bundled bridge passes audio, language, verbatim mode, and word
timestamps to CrisperWhisper; it has no script or hint input. Model capability
and the best place for script assistance need verification rather than an
assumption based on other Whisper implementations.

## Guardrails and evaluation

- Never import the script as the finished transcript or auto-accept every
  aligned phrase. A script mismatch may represent genuine ad-libbed speech.
- Preserve fillers and repeats that the recognizer captured, even if absent
  from the script. Script assistance must not recreate the over-cleaned
  transcript problem that motivated verbatim transcription.
- Use occurrence-scoped, reviewable suggestions. Repeated technical terms may
  need different treatment in different sentences.
- Evaluate on excerpts with correctly scripted terms, changed wording,
  skipped lines, added speech, fillers, repeated starts, and ambiguous terms.
  Measure useful corrections and harmful substitutions separately.

## Questions for the next conversation

- Which script formats are available (plain text, Markdown, PDF, Word, or
  something else), and are they usually one script per recording?
- Should the script be stored inside the project, linked to a local file, or
  used only during an assistance run?
- Is the first priority a terminology glossary, broader sentence correction,
  or both? Which example misrecognitions should be evaluation fixtures?
- Should suggestions appear inline as the user edits, or in a sequential
  review queue? Is accepting many occurrences of one term desirable?
- How much audio evidence should a suggested replacement require, and what
  should happen when the script and spoken words clearly disagree?
- Should script assistance run during transcription, afterward, or be
  selectable between those modes after an experiment?

## Initial acceptance examples

- A technical name misrecognized in one occurrence can be suggested with the
  relevant script wording, accepted as a text-only edit, and undone.
- A correctly recognized filler or spoken repetition absent from the script
  remains in the transcript unless the user separately edits it.
- A skipped script line is not inserted as if it had been spoken.
- Accepted casing and terminology changes survive project save/reopen and
  appear in caption export without changing the edit timeline.

No implementation order relative to filler review is decided here.
