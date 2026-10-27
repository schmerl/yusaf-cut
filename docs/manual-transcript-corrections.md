# Manual checkpoint: transcript corrections, Phases 2–7

Use the rebuilt **4.7.0** app for the final walkthrough at
`src-tauri/target/release/bundle/macos/YusafCut.app`.
Save any work and quit the previous app before opening this one; the installed
copy does not update automatically. Keep valuable projects backed up: older
versions can drop correction metadata. Use a disposable project for destructive
re-transcription tests.

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
On 2026-10-26, the user confirmed all native timing retests passed in 4.5.1,
completing the Phase 4 manual checkpoint. Original timing notes are preserved
below as historical feedback; the reported bug is fixed and verified.

- [X] Type immediately without entering a mode. Correct `serveur` to `server`;
      the timeline stays at 6 seconds and the second occurrence stays unchanged.
- [X] Click to place the caret. Cmd-click a phrase to seek. Check playing and
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
- [X] Play through both occurrences: highlighting follows output order and
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
separately. Re-transcription replaces existing text; use a disposable copy and
Snapshot first to verify recovery without risking a valuable corrected project.

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

- [X] In 4.5.1, Cmd-click the second paragraph's `aren’t` while paused; the
      output clock should stay near 4.1 seconds, not return to 1.1 seconds.
- [X] Repeat while playing; playback/highlighting should remain in the second
      occurrence. Cmd-click `are not` to return to the first occurrence.
- [X] Play from just before three seconds through the repeated clip. The output
      playhead should continue through three seconds, highlight paragraph two,
      and stop at six seconds rather than restart or loop paragraph one.
- [X] Confirm paragraph timestamps seek to output 0 and 3 seconds respectively.

The user confirmed all four follow-up checks passed in 4.5.1 on 2026-10-26.

## Verification already performed

Automated model, editor, caption, save-race, and native serialization tests run
separately. jsdom tests exercise real ProseMirror transactions but do not prove
native WebKit composition, clipboard, caret, or perceptual audio synchronization.
Mark pending boxes complete only after those native actions have actually been
performed. The requested native checkpoint before Phase 5 is now complete.

## Phase 5 native checkpoint — 4.6.0

The user confirmed all Phase 5 checks below passed in 4.6.0 on 2026-10-26.
This sign-off is separate from the subsequent partial-match highlighting change.

- [X] Search `idempotency are not`: one phrase match spans corrected groups;
      next/previous navigation highlights the current passage and shows context.
- [X] Change a paragraph to `post POST post.`. Search `post`, navigate to the
      technical occurrence, and Replace current with `POST`; other matches stay
      unchanged. Try case and whole-word options; counts/highlights update on
      edits and undo. Search punctuation literally, including `.` or `[`.
- [X] Replace all is one undo step. Replacement `$&` is literal text. Attempt
      replacement of an entire spoken paragraph with empty text; the whole batch
      is rejected with feedback and the project stays unchanged.
- [X] Select part of `idempotency`, then View original selection. The preview
      shows `item potency` and explains whole-group restoration. Restore original
      text; other corrections, timeline duration, and the second occurrence stay
      unchanged. Undo/redo restores the operation in one step.
- [X] Place the caret in paragraph one and View paragraph original. Restore
      original text to recover hidden `old`; duration stays at six seconds.
- [X] Save/reopen a corrected project and repeat original inspection/restoration.
      Explicitly cut other speech, then restore a surviving passage: removed
      speech stays cut and unrelated corrections survive. Check SRT/VTT text.
- [X] Inspect an original passage, then edit or switch projects. The preview
      becomes stale and cannot restore until inspected again.
- [X] Cut matching speech and Cut filler speech clearly change audio/video;
      partial corrected-group matches are rejected rather than silently expanded.

Phase 5 adds no re-transcription workflow; that remains Phase 6.

## Partial-match follow-up — 4.6.1

The user requested strong highlighting for the exact substring and lighter
shading for its containing token. Partial matching is now the search-panel
default; enable **Whole word** to require full token boundaries. Replacement
still changes only the matched substring; the lighter context is not replaced.

- [X] In the native dark theme, search `po` in `POST`: `PO` has the stronger
      current-match highlight, while `ST` has light token shading. Whole word
      produces no match.
- [X] Replace `po` with `RE`: the result is `REST`, preserving `ST`. Undo restores
      `POST`. Verified in the 4.7.0 native app on the disposable legacy fixture.
- [ ] Inspect the light-theme appearance and token context while navigating
      next/previous matches. Navigation itself is covered by automated UI tests.

## Final native checkpoint — 4.7.0 (Phases 6–7)

Native checks below were performed in 4.7.0 on generated tone-video projects
under `src-tauri/target/manual-corrections/final-4.7/`. No personal recording was
used. Further live app interaction stopped at the user's request; ordinary unit,
integration and command-line checks remain authorized.

- [X] Legacy project loads without correction metadata. A phrase correction to
      `東京 POST` preserves six-second duration and the other occurrence.
- [X] The replacement warning offers Cancel, Proceed and Snapshot first. Cancel
      preserves the corrected project and duration.
- [X] On an unsaved corrected project (`POST rings`), Snapshot first opens native
      Save. Cancel Save leaves the correction unsaved and unchanged; the warning
      states recognition has not started.
- [X] Snapshot first saves current corrections and creates `Before re-transcription`
      before recognition. Its native compressed snapshot contains `東京 POST`.
      Save/snapshot failures are covered by controlled automated tests, without
      deliberately damaging projects or filling the disk.
- [X] Successful recognition replaces the baseline for both repeated occurrences,
      retains six-second duration, and clears session Undo. Restoring the snapshot
      recovers `東京 POST`; native SRT and VTT exports contain the recovered text.
- [X] View/restore paragraph originals changes text only. Explicit Cut speech
      removes the corrected group from one occurrence; one Undo restores it and
      Redo reapplies the cut.
- [X] Multi-clip/reused-media recognition succeeds for three segments/two media
      IDs with a pre-existing cut and non-ASCII correction (`naïve café 東京.`).
      All source ranges remain identical, including sourceIn 1.02; output duration
      remains exactly 7.98 seconds. Native SRT export reflects the new baseline.
- [X] Both generated source hashes remain unchanged:
      `ee336d4fa59f6759c6dcc56b71d5aad80ee1fd3b1109e069b07d944b69f908b9`.
- [ ] Additional native-only coverage: Proceed without snapshot, unsaved Save
      completion followed by snapshot, multi-clip snapshot recovery/VTT afterward,
      and a fresh full end-to-end walkthrough. Their underlying workflows are
      covered by automated tests and the native checks above, but these exact
      sequences were not completed before live testing stopped.
- [ ] Compare real speech/video synchronization near the beginning, existing cuts
      and end on a copied lecture. Record pre-existing export cut-padding drift
      separately. Synthetic tones cannot establish perceptual speech alignment.

See [the acceptance audit](transcript-correction-acceptance.md) for automated
coverage, native evidence and limitations.
