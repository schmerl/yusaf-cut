# Manual checkpoint: transcript corrections, Phases 2–4

Use the rebuilt **4.5.1** app for the playback retest at
`src-tauri/target/release/bundle/macos/YusafCut.app`.
Save any work and quit the previous app before opening this one; the installed
copy does not update automatically. Keep valuable projects backed up: older
versions can drop correction metadata, and Phase 5/6 controls are not ready yet.

## Disposable fixture

Run `python3 scripts/create-correction-smoke-fixture.py` from the repository.
It requires an existing FFmpeg on PATH and creates only generated files under
`src-tauri/target/manual-corrections/`. It does not touch personal recordings.

Open **File → Open Project** and select:

`src-tauri/target/manual-corrections/Correction-smoke.scribe`

Expected initial state:

- Output duration: **6 seconds**, two occurrences of the same 3-second video.
- First paragraph: **idempotency are not the serveur.**
- Second paragraph: **item potency aren’t the old server.**
- The first phrase is one corrected timing group mapping to “item potency”.
- The first paragraph hides “old” as text only; its audio anchor is still retained.
- The clip contains color bars and a synthetic test tone, not spoken words.
  It tests duration, occurrence isolation, text and selection—not speech accuracy.

## Checks to perform

The user verified the editing/save/export/snapshot checks below in 4.5.0.
The two `[-]` entries retain the user's timing findings and remain open for a
native retest in 4.5.1. Their original notes are preserved below.

- [X] Type immediately without entering a mode. Correct `serveur` to `server`;
      the timeline stays at 6 seconds and the second occurrence stays unchanged.
- [-] Click to place the caret. Cmd-click a phrase to seek. Check playing and
      paused states separately: seeking should preserve that state.
      Notes: In the text, both versions of the sentence map to the same times. So "aren't" is at the 1 second mark and so is "are not". Not sure if this is a bug or a weakness in the text.
- [X] Type spaces and J/K/L/I/O/B/X; they should enter text rather than operate
      playback or timeline controls. Cmd-X removes selected text only.
- [X] Delete a word inside a paragraph; audio/video duration stays unchanged.
      Undo/redo restores the text and keeps the caret usable.
- [X] Select all text in one paragraph and delete it; the edit is rejected with
      an explanation and no loss of its previous text.
- [X] Paste formatted/external text; it becomes plain transcript text.
- [X] Use an IME/input method if available. Composition should stay stable,
      survive normal caret input, and never autosave an invalid empty paragraph.
- [X] Enter between timing groups splits the paragraph. Backspace at the start
      of the next paragraph joins it as text. A split inside one timing group
      is rejected. Joins across different segments/cuts are rejected.
- [X] Select only part of `idempotency`, then press **Cut speech**: no audio is
      removed; the full timing-group requirement is explained.
- [X] Select the whole `idempotency` group and invoke **Cut speech** or Cmd-Shift-X.
      Duration shortens, the second occurrence survives, and Undo restores the
      entire cut in one step. Delete/Backspace alone must never do this.
- [X] Save, close, and reopen the fixture. Confirm text/cuts survived. Do another
      text edit while a save is pending; it must remain unsaved until its own write.
- [-] Play through both occurrences: highlighting follows output order and
      corrected phrases highlight as a unit. Paragraph timestamps seek to the
      correct occurrence, not the first occurrence of shared source words.
      Notes: Apart from the duliccated timings as mentioned above.
- [X] Export SRT and VTT. Corrected text appears once in the first occurrence,
      raw text in the second, with no caption word for the hidden first `old`.
- [X] Open Snapshots and create/restore a point; corrections should survive the
      native round trip.

For real speech/video synchronization, repeat on a **copy** of a transcribed
lecture project and compare playback and exported captions near the beginning,
several existing cuts, and the end. Text corrections must not change source
ranges/duration; pre-existing export cut-padding drift should be recorded
separately. Do not run Re-transcribe on a valuable corrected project: this build
blocks it until the Phase 6 snapshot-backed replacement workflow is implemented.

## Timing-note diagnosis and retest

The fixture intentionally uses the same source range twice, but each occurrence
has a distinct position in the edited output:

| Phrase | Source time | Expected output seek time |
|---|---:|---:|
| First paragraph: `are not` | 1.1 seconds | 1.1 seconds |
| Second paragraph: `aren’t` | 1.1 seconds | 4.1 seconds |
| First paragraph timestamp | 0 seconds | 0 seconds |
| Second paragraph timestamp | 0 seconds | 3 seconds |

The user's observation exposed a VideoPreview bug: its clock chose the first
matching media/source range, resetting a seek in the second occurrence back to
the first occurrence. Version 4.5.1 tracks the selected segment occurrence and
advances through the output order rather than choosing by source time alone.

- [ ] In 4.5.1, Cmd-click the second paragraph's `aren’t` while paused; the
      output clock should stay near 4.1 seconds, not return to 1.1 seconds.
- [ ] Repeat while playing; playback/highlighting should remain in the second
      occurrence. Cmd-click `are not` to return to the first occurrence.
- [ ] Play from just before three seconds through the repeated clip. The output
      playhead should continue through three seconds, highlight paragraph two,
      and stop at six seconds rather than restart or loop paragraph one.
- [ ] Confirm paragraph timestamps seek to output 0 and 3 seconds respectively.

These are follow-up checks, not a claim that the native timing retest has passed.

## Verification already performed

Automated model, editor, caption, save-race, and native serialization tests run
separately. jsdom tests exercise real ProseMirror transactions but do not prove
native WebKit composition, clipboard, caret, or perceptual audio synchronization.
Mark pending boxes complete only after those native actions have actually been
performed. The native walkthrough is the requested user checkpoint before Phase 5.
