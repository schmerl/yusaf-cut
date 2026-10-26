# Feature 3: Manual transcript corrections

Status: Phases 1–5 implemented, with automated editor and model checks passing.
The user completed the Phase 4 native checkpoint in 4.5.1 on 2026-10-26.
The user confirmed all Phase 5 native checks passed in 4.6.0. The requested
partial-match highlighting follow-up is implemented in 4.6.1 and awaits native
verification. The protected re-transcription
workflow (Phase 6) remains pending.

Agent handoff: [phased implementation plan](../plans/03-transcript-corrections.md).

## Goal

Make the transcript editable by default so the user can correct words,
capitalization, and punctuation without changing the audio/video that plays.
Text corrections must preserve source ranges, existing cuts, playback order,
and output duration. Cutting speech is a separate, explicit operation.

## Confirmed decisions

| Area | Requirement |
|---|---|
| Editing | Type directly in the transcript; no correction dialog or mode switch required |
| Phrase replacement | Allow different word counts, including “item potency” → “idempotency” and “aren’t” → “are not” |
| Delete/Backspace | Edit text only; never cut audio/video |
| Cutting | Provide an explicit Cut speech action and a separate shortcut |
| Text-only deletion | Individual words may disappear from text/captions while their source audio remains audible |
| Nonempty rule | A paragraph that retains speech must retain some transcript text |
| Corrected timing | A corrected phrase may share one timing/highlighting/seek span initially |
| Cutting corrected phrases | Require selection of the entire corrected timing group |
| Click behavior | Click places the caret; Cmd-click seeks the video |
| Find/replace | Words and phrases; Replace current, Replace all, case sensitivity, and whole-word matching |
| Re-transcription | Warn and offer a snapshot before replacing manually corrected text |
| Original text | Retain original recognized text; allow viewing/restoring a corrected passage after save/reopen |

## Motivating examples

- Correct “item potency” to “idempotency” while retaining the audio of the
  original two recognized words as one corrected timing group.
- Change “rest” to “REST” for the architectural style.
- Change one occurrence of “post” to “POST” without changing another occurrence
  where “post” is an ordinary verb.
- Add or remove punctuation without affecting playback or cut boundaries.
- Change “the old server” to “the server” using ordinary text deletion. The
  original audio remains audible; this is a transcript correction, not a cut.
- Expand one recognized token to several displayed words without changing
  the selected audio span or claiming new, exact word-level alignment.

## Existing behavior and required change

The current panel is read-only. Word selection plus Delete cuts speech, and
ordinary word clicks seek playback. Existing find/replace changes text within
individual word records; it cannot match a phrase spanning several words.

The new default interaction is ordinary text editing. Existing transcript-based
cutting remains available through explicit Cut speech actions. The distinction
must be reflected in controls, shortcuts, help text, and tests—not just in the
editor's editable setting.

## Inline editing workflow

1. Open an existing transcribed project or finish transcribing media.
2. Click in the transcript to place the caret, or select text normally.
3. Type, paste plain text, change case/punctuation, replace a selection, or
   delete text. The displayed transcript updates without seeking the video or
   altering the edit timeline.
4. Preserve the underlying audio/timing anchors, even when text is deleted.
   Editing text must not discard an audio span or turn a text deletion into a cut.
5. Apply a correction to the selected occurrence. Other occurrences remain
   unchanged unless the user explicitly performs a broader replacement.
6. Include corrections in normal autosave, project save, snapshots, and SRT/VTT
   export. Normal save/reopen must not require re-transcription or lose edits.

### Ordinary editing keys

- Delete/Backspace remove text; Cmd-X cuts text to the clipboard, not speech.
- Space inserts a space while editing. J/K/L and other letter keys type text
  rather than activating transport or timeline shortcuts.
- Cmd-Z and Shift-Cmd-Z undo/redo the appropriate editing action. A text-field
  shortcut must not unexpectedly mutate another part of the project.
- Pasted content is transcript text. Rich-text formatting, executable markup,
  and arbitrary pasted editor-node attributes are not part of this feature.

## Nonempty paragraphs

A paragraph with surviving speech must contain some non-whitespace transcript
text. Removing one word is allowed when the paragraph retains text.

- Replacing a selected paragraph with nonempty text is allowed as one edit.
- Temporary emptiness during an in-progress replacement or input-method
  composition may be supported, but an all-empty paragraph must not be committed,
  autosaved, or exported as a completed correction.
- Reject or revert an action that would leave the whole spoken paragraph empty,
  retain its previous valid text, and explain that Cut speech removes the audio.
- Apply this rule consistently to typing, paste, Cmd-X, and find/replace.
- Paragraph reflow, punctuation changes, or removal of a paragraph separator
  must not silently lose audio mappings or bypass validation by dropping the
  empty spoken passage.
- Explicitly cutting all speech in a paragraph removes that paragraph normally;
  the nonempty rule does not prevent a deliberate audio/video cut.

## Timing and playback

- Source word timestamps and the selected phrase's source ranges remain the
  authority for playback. Corrections do not retime surrounding words.
- A correction that changes word count may be represented as one timed phrase.
  Highlight the corrected phrase together and seek to its start.
- Do not fabricate precise timestamps for newly displayed words. Per-word
  forced alignment inside corrected phrases is outside the first version.
- Cmd-click seeks the corresponding word/phrase. The implementation default
  is to seek without changing whether playback is currently playing or paused.
- Clicking to position a caret, selecting text, or typing must not implicitly
  seek or start playback.
- Text inserted into an existing passage attaches to its existing timing model;
  it does not create extra audio or extend duration.
- Preserve discontinuities at existing cuts. A corrected group must never turn
  separated source spans into one continuous span that reintroduces cut speech.

## Explicit Cut speech workflow

1. Select the words or complete corrected timing groups whose speech should be
   removed.
2. Invoke **Cut speech** using its visible control or dedicated shortcut.
3. Apply the cut through the existing edit-decision model and update preview,
   transcript, duration, and subsequent exports.

Ordinary, ungrouped recognized words remain individually cuttable. A selection
that includes only part of a corrected timing group must not cut that group
silently: explain that the full corrected phrase must be selected. Do not
silently enlarge a partial text selection and remove additional audio.

A paragraph-level cut includes its surviving audio anchors, including words
that were previously removed from displayed text by text-only editing.

Proposed shortcut default: **Cmd-Shift-X** for Cut speech, shown in the UI and
shortcut help. Keep ordinary text-editing shortcuts intact. The exact binding
is an implementation default rather than an additional user-confirmed choice.

Pause-removal controls and existing delete-match/filler-removal actions also
need clear audio-cut semantics. A plain text-editing gesture must not trigger
one of those operations accidentally.

## Find and replace

- Search words and phrases in the current edited transcript, including phrases
  spanning multiple recognized word records and corrected timing groups.
- Provide next/previous match navigation, current-match highlighting,
  **Replace current**, and **Replace all**.
- Provide case-sensitive and whole-word options; matching is literal, not regex.
- Partial matching is the default in the search panel. Highlight the exact
  substring strongly and its containing token lightly (for example, `po` finds
  `POST`, with `PO` stronger than `ST`). Whole word requires full boundaries;
  replacement always changes only the exact match, not the lighter context.
- Case-insensitive searching can find “post” and “POST”; Replace current lets
  the user make the contextual choice. Replace all requires an explicit action.
- Preserve unmatched punctuation and surrounding text. Apply the replacement
  literally, including the capitalization and punctuation the user entered.
- Replacements preserve audio spans and obey corrected-group/nonempty rules.
- Replace all is one undoable operation and reports its replacement count.
  If any replacement would violate paragraph validation, do not silently apply
  a partial batch; explain the problem without changing the project.

Implementation default: initial matching is within a paragraph. Matching across
paragraph boundaries,
source-clip boundaries, or removed speech is not required. An unsupported
replacement spanning a cut must preserve the project and explain the limitation.

## Original recognized text and restoration

- Retain the original recognized text and its timing associations separately
  from the current corrected text. Save both with the project and snapshots.
- Make original text available for a selected corrected passage and provide
  **Restore original text** after save/reopen, not only through session undo.
- Text-only deleted words must remain recoverable through this original-text
  representation.
- Restoration changes transcript text only. It must not restore audio/video
  that has subsequently been cut, move cut boundaries, or undo unrelated edits.
- Restoring a passage is undoable. Other corrected passages remain unchanged.
- For an older project without correction metadata, treat its loaded transcript
  as the available original baseline; do not claim to recover earlier edits or
  recognition output that the project never retained.
- Do not present recognition confidence as confidence in user-authored text.

## Re-transcription

Before re-transcribing material with manual corrections:

1. Explain that new recognition output will replace corrected text for the
   affected material. Offer Cancel, Proceed, and a way to create a snapshot first.
2. If a snapshot is requested for an unsaved project, offer to save the project
   so a normal project snapshot can be created. Do not silently claim a backup.
3. If snapshot creation fails, report the failure and do not silently continue
   as though the snapshot succeeded.
4. Cancelling preserves current corrections, originals, and timeline state.
5. A failed transcription must leave the existing corrected project intact.
6. On successful replacement, the new recognition output becomes the baseline
   for future corrections to that material. A pre-transcription snapshot retains
   the earlier state if the user chose to create one.

Automatic matching/reapplication of manual corrections to newly recognized
words is outside the initial scope.

## Persistence and state integrity

- Save/reopen and snapshots preserve corrected text, original text, timing-group
  associations, and existing cut decisions without losing fields in the
  frontend-to-Rust round trip.
- Older projects continue to load without correction metadata or migration work
  by the user.
- Undo/redo covers ordinary typing in useful editing groups, phrase replacement,
  Replace all, restoring original text, and Cut speech. A phrase replacement or
  one explicit cut must not require many undos to reverse.
- Editing and autosave must not jump the caret, lose selection, duplicate words,
  or overwrite an active input-method composition.
- Captions use corrected text and the existing edited output timeline, with no
  new text-edit-induced timing drift. They do not substitute original recognized
  text for an accepted correction.
- A correction to one occurrence of reused media does not silently alter another
  occurrence in the edited timeline.
- Source media files remain unchanged throughout.

## Scope boundaries

This feature does not synthesize or change speech, automatically infer correct
terminology, import teleprompter scripts, detect false starts, or infer exact
new word timestamps. It does not provide a rich-text document editor or create
a new timed transcript from scratch without transcribed audio.

Script-assisted correction is feature 2. Repeated-phrase/false-start detection
is feature 4. Those features should reuse the appropriate text-correction or
explicit-cut operations once implemented.

## Acceptance criteria

### Direct editing and invariants

- On opening a transcribed project, the user can type immediately in the panel
  without activating a mode or opening a dialog.
- Correct capitalization and punctuation; verify that source ranges, cut
  boundaries, output duration, and audio/video playback order are unchanged.
- Replace “item potency” with “idempotency” and expand one word into several;
  verify phrase highlighting/seek behavior and unchanged surrounding timing.
- Delete “old” from “the old server”; verify that audio is retained, captions
  omit the text, and the original text can subsequently be restored.
- Try to clear an entire spoken paragraph via Delete, Cmd-X, and Replace all;
  verify validation and that an invalid empty correction is not autosaved.
- Verify typing, paste, spaces, J/K/L, text selection, input-method composition,
  undo, and redo without accidental transport or audio-cut commands.

### Seeking, cutting, and replacement

- Click places the caret without seeking; Cmd-click seeks without toggling the
  current playing/paused state.
- Cut an ordinary word and a whole corrected phrase explicitly; verify the
  intended audio ranges are removed and one undo restores the operation.
- Select only part of a corrected timing group and invoke Cut speech; verify
  that no audio is removed and the full-group requirement is explained.
- Find a multiword phrase across word records. Replace just the current match,
  then test Replace all, case sensitivity, whole-word matching, and punctuation.
- Verify that correcting technical “POST” need not change the ordinary verb
  “post”, and that an invalid Replace all is atomic.

### Persistence and re-transcription

- Save/reopen a project with a phrase correction and a text-only deletion;
  verify corrected display, caption output, grouping, and original-text recovery.
- Snapshot and restore the same project; verify no correction metadata is lost.
- Restore original text after cutting other speech; verify that cuts and
  unrelated corrections remain intact.
- Load an older project and perform a correction without manual migration.
- Re-transcribe corrected material: verify the warning, snapshot option,
  cancellation, snapshot-failure handling, transcription-failure preservation,
  and successful replacement of only the affected transcript.
- Confirm that source media files have not changed.

## Validation approach

Test correction operations and serialization separately from UI interactions.
Use meaningful editor/shortcut tests to distinguish text deletion from explicit
cuts and protect caret/composition behavior. Include a native save/reopen and
snapshot round trip through Rust, plus caption export checks for merged/split
phrases and retained audio spans. Audio-rendering checks must distinguish any
pre-existing export timing issue from drift introduced by text corrections.

## Implementation order

1. Caption export repair (feature 1) — done.
2. Manual transcript corrections (this feature).
3. Script-assisted terminology/capitalization corrections (feature 2).
4. Repeated phrases and false starts (feature 4).
