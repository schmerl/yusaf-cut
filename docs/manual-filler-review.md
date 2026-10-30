# Hands-on filler review

Status: implementation ready for human native review, 2026-10-29. The agent has
not launched, operated, or listened to the live app. Automated checks do not
establish native playback fidelity.

## Start and choose a recording

Run `npm run tauri dev` from the checkout, or build with `npm run tauri build`
and open the resulting app. See [setup instructions](../HOW_TO_RUN.md) if needed.

Use a recording with several audible “um”/“uh”/“ah” occurrences and some ordinary
uses of “like.” An existing CrisperWhisper transcript with `[AH]`, `[UM]`, and
`[UH]` is particularly useful. Keep a copy of the project if you want to compare
its original state later. Normal Undo and snapshots remain available.

## First pass: listen, preview, decide

- [ ] On opening the transcript, bracketed vocal fillers are highlighted with
  their recognized spelling. Ordinary “like” is unhighlighted by default.
- [ ] Click **Review fillers** in the transcript toolbar. Nearby text, candidate
  spelling, source/output time, and queue position are shown alongside the
  transcript. Opening it does not start playback or mark a saved project dirty.
- [ ] **Play before** plays the current passage with the filler present. **Stop**
  stops it. Context starts at two seconds on each side and Loop starts off.
- [ ] On an occurrence with a very short recognition span, wait for the audio
  estimate. Its proposed duration/offsets update without dirtying the project or
  starting playback. Listen to Before and Preview, particularly the neighboring
  word. The round information icon beside the cut duration exposes timing and
  estimation details on demand.
- [ ] In **Adjust cut boundaries**, request **Estimate audio** on another
  occurrence and try **Original timing**. Manual typing/nudges and Stop
  cancel pending estimates; a late result cannot replace your edits.
- [ ] If estimation cannot find an unambiguous burst, it explains the fallback
  and allows manual adjustment. Nothing is silently committed.
- [ ] Change before/after context independently. Enable Loop and confirm that it
  repeats only the chosen passage; disable it and confirm playback stops at the
  passage end. Navigation does not start playback.
- [ ] **Preview cut** prepares a rendered passage, then plays the proposed join
  continuously and displays “project unchanged.” No seek delay is inserted at
  the internal join. Before/result playback also use rendered passages.
  The transcript, project duration, saved state, and history do not change.
- [ ] Expand **Adjust cut boundaries** (initially closed), below the playback
  buttons. Try all four 10 ms nudge buttons. Positive start offsets retain the leading
  edge; negative end offsets retain the trailing edge. Positive end offsets
  remove more trailing gap. Absolute cut boundaries and duration are displayed.
- [ ] With a shortened cut, the panel discloses that some filler edges remain.
  Listen to those edges during preview, including possible breaths or clicks.
- [ ] Type a boundary that overlaps the preceding/following word or crosses an
  existing edit. Preview/cut becomes unavailable with a reason; it does not
  silently clamp or widen the request.
- [ ] Choose **Cut filler speech**. It removes this occurrence's entire text,
  including captions, and only the proposed audio interval. The card stays open,
  and no playback begins automatically.
- [ ] Compare **Play before**, **Preview cut**, and **Play result** on the pinned
  result card. The preview and committed join should sound the same. Confirm
  neighboring consonants and words remain intact.
- [ ] **Undo this decision** restores audio, transcript and review status
  together. Normal Cmd+Z / Shift+Cmd+Z should also undo/redo the decision.
- [ ] Use **Next** or **Next unreviewed** explicitly to continue.

## Separate text from sound

- [ ] Choose **Remove text only** on another occurrence. It disappears from the
  editor and SRT/VTT captions while audio and total duration stay unchanged.
- [ ] The card stays visible with **Text removed, audio retained**. Its text
  cannot be removed twice. It can still be listened to and, when eligible, cut.
- [ ] **Audio retained** finds these occurrences, including fillers previously
  hidden through ordinary text editing and residual edges from shortened cuts.
- [ ] Restore original text with the ordinary editor restoration control. A
  previously resolved text-only occurrence becomes unreviewed when restored.
- [ ] For an originally recognized filler-only paragraph, text-only removal is
  unavailable. A full speech cut can remove it; a shortened cut that leaves
  audible edges without paragraph text is unavailable.
- [ ] If you replace a filler plus a neighboring word with a corrected phrase
  that still contains “um,” it is marked as sharing a timing group. Listen and
  Keep/Skip work, while its isolated speech cut is disabled. Do not create this
  case merely by changing filler casing: change both words so the correction
  actually groups them.

## Queue, settings, and persistence

- [ ] **Keep** stays on the card and preserves current text/audio. Revisit the
  occurrence in **Kept** and use **Reset to unreviewed** if desired.
- [ ] **Skip** advances and only defers that occurrence for this review session.
  **Review skipped** restores deferred occurrences. **All** exposes their status.
- [ ] After resolving the final queue item, the pinned result is labeled
  separately from the queue; it does not invent a position such as “1 of 0.”
- [ ] Save, close, and reopen the project. Keep and detection choices persist.
  Closing/reopening review resets skips; a fresh session starts with default
  offsets/context/Loop.
- [ ] Under **Detection settings**, opt into “like” and a multiword phrase such
  as “you know.” Add a custom literal phrase on its own line and apply it.
  Matches count occurrences, with a phrase counted once. Nothing claims an
  ordinary word is necessarily functioning as a filler.
- [ ] Check transcript highlighting, timeline marks, and status counts agree;
  hidden text is counted as audio retained and is not reinserted in the editor.
- [ ] Add the same source clip again. A decision/cut on the second placement
  leaves the first placement unchanged.

## Playback lifecycle and export

- [ ] While previewing, try Stop, closing review, navigating, changing an offset,
  Undo/Redo, and ordinary transport/seek controls. Audition stops, pending media
  loads/renders do not restart it, and normal playback does not resume by itself.
- [ ] Edit other transcript text or rename the project after a decision. Previous
  before/after comparisons are cleared with an explanation, and the card's Undo
  control cannot undo that unrelated edit.
- [ ] Try context near the beginning/end, across an existing cut, across repeated
  placements, and across different media files. It stays within available edited
  media and follows output order. Preview does not move the normal playhead or
  highlight a different occurrence as though it were the current one.
- [ ] Re-transcribe or restore a snapshot. Stale cards/previews stop. New
  recognition starts new occurrence identity; snapshots restore captured state.
- [ ] Export SRT/VTT after both a text-only removal and a speech cut. The entire
  chosen candidate text is absent from captions.
- [ ] Export a short passage with a zero-offset cut and another with retained
  edges. Listen to the exported files, compare with Preview cut and Play result,
  and confirm duration/joins, neighboring speech, and retained edges agree.
- [ ] Narrow the window and resize the preview. Transcript context, inputs, and
  review buttons remain reachable. Focused inputs keep their usual typing keys.

Precise review cuts use the full re-encode export path and exact EDL boundaries;
export does not add another pre-roll padding pass. Source media files remain
unchanged. Retained edges can be revisited/listened to but cannot be recut as one
continuous review item across the existing cut; explicit timeline ranges can
edit their remaining audio.

## Feedback to record

For a problem, include the source/output time, candidate spelling, offsets,
context/Loop settings, action sequence, and whether it affects before, preview,
committed playback, export, or several of those. For audible discrepancies,
identify which neighboring sound is clipped/repeated or which join differs.
Mark native items passed only after trying them; none are pre-marked here.


The playback follow-up also fixes FFmpeg audio padding at non-frame-aligned
cuts. A 30 fps regression previously turned a 5 s passage with 80 ms of cuts
into 5.004 s of audio with inserted silence. Automated renders now produce
4.920 s of audio with no inserted silent samples; encoded video duration is
within one frame at both 30 and 29.97 fps. These headless checks do not replace
your native listening review.
