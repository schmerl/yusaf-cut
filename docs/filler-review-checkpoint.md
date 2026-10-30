# Filler review: ready to try in the app

The review workflow is now implemented and ready for hands-on native review.
No live app testing has been performed by the implementation agent.

Start the desktop app from this checkout:

```sh
npm run tauri dev
```

For a packaged build, use `npm run tauri build` instead. The existing setup steps
are in [HOW_TO_RUN.md](../HOW_TO_RUN.md).

Open a recording with a transcript, then click **Review fillers** in the
transcript toolbar (also available from Toolbox and Search). `[AH]`, `[UM]`,
`[UH]`, and the other default vocal fillers should already be highlighted.

The most useful first pass is:

1. Listen with **Play before**, then **Preview cut**. Try the start/end ±10 ms
   buttons, surrounding context, and Loop. Nothing should change in the project
   until you accept a decision.
2. Choose **Cut filler speech**, stay on that item, and compare **Play result**
   with the before/preview recordings. Undo the decision and confirm restoration.
3. On another item, choose **Remove text only**. The text should disappear while
   the sound and duration stay unchanged. Revisit it through **Audio retained**.
4. Try **Keep**, **Skip**, explicit Next/Previous, and the Kept filter. Save and
   reopen to check that Keep persists while session skips reset.
5. Export a short passage and compare its join with Preview cut and Play result.
   This listening comparison is the main remaining native validation gate.

See [the full hands-on checklist](manual-filler-review.md) for edge cases and
what feedback to record. Automated checks are handled by the implementation
agent; you do not need to run test suites for this review.

Implementation and automated evidence are recorded in
[the plan](plans/05-filler-review.md#hands-on-checkpoint-2026-10-29).

Automated validation passed after the playback follow-up: 233 frontend tests,
61 Rust tests, TypeScript,
ESLint, production build, and a headless FFmpeg check of retained audio samples.
Native listening and layout acceptance remain for this hands-on review.

## Playback follow-up

Restart `npm run tauri dev` after this update; it adds native audition commands.
**Play before**, **Preview cut**, and **Play result** now prepare a short rendered
clip and then play it continuously. You may see “Preparing continuous playback”
before playback begins. Internal joins no longer seek the original source.

Playback buttons are above **Adjust cut boundaries**, which starts collapsed.
A visible before/after duration readout shows the exact reduction in seconds;
player/status duration displays also include milliseconds.

For the next pass, compare a short filler cut with its committed result, then
export the same passage. There should be a shorter timeline and no inserted
silence at the join. Stop or navigate during preparation and confirm the old
clip cannot start later. Native listening remains for you to verify.

## Before/Preview isolation follow-up

A reproduced race allowed a delayed native `play` event to restart the original
source underneath a rendered audition. The source player now remains paused and
hidden while review playback owns the panel. Each audition has its own media
element and frame-clock identity, so a late Before play promise cannot pause or
otherwise affect Preview cut.

An audio-content regression exercises the actual native render plan against a
compressed source with a distinctive synthetic filler tone. Before retains that
tone (4.300 s); Preview excludes it (4.000 s). This verifies the removed source
content, as well as the duration. Native listening still belongs to human review.
Boundary controls and the undo-then-adjust workflow are unchanged.

## Very short recognition spans

A native screenshot showed only **20 ms** selected at zero offsets. Zero offsets
use the recognition timestamps exactly, so a longer audible filler can remain
almost entirely present even when the selected 20 ms is correctly removed.

Recognized spans of 40 ms or less trigger audio estimation (not a minimum
permitted cut). Original timing, neighboring-word limits, and estimation details
are available through the round information icon beside the compact cut readout. To expand the interval, use a
negative Start offset and/or a positive End offset, then compare Before and
Preview. The engine continues to reject neighboring-word/cut-boundary overlaps.
Recognition anchors and default offsets are unchanged; the app does not guess a
larger cut automatically. Verify the actual sound before committing.

## Audio-informed boundary estimates

Restart the native app (`npm run tauri dev`) for the new local estimation command.
On a very short/uncertain occurrence, review now estimates its audio boundaries
automatically. Wait for estimation to finish, then compare **Play before**
and **Preview cut**. The proposed duration should reflect the estimated burst,
rather than remaining at a 20 ms attention span.

The search is bounded by the previous word's end, the next word's start, and
existing edits. The estimator keeps the surrounding pause unless it falls inside
the selected audio burst; it does not select the whole neighboring-word gap.
Estimation details, including neighbor limits, are available behind the information icon.

Under **Adjust cut boundaries**, **Estimate audio** is available for other
occurrences, and **Original timing** restores the raw zero offsets. Manual
edits cancel pending estimates. Preview/commit use the same validated EDL. Before
and Preview now use the same surrounding material even when adjusted boundaries
extend beyond the original recognized token. Your project is unchanged until you
accept a decision.

If no clear burst can be identified, the panel says so and leaves manual
adjustment available. This is an acoustic estimate to audition, not a guaranteed
phonetic boundary or a semantic recommendation to delete the word.

## Compact review layout

The main readout shows only the removed duration. The round **ⓘ** beside it opens
recognition timing, neighboring-word limits and estimation details; Escape closes
it. The short-recognition warning is no longer displayed. Expanded boundary
controls keep just the estimation/reset actions, Start/End offsets with nudges,
and the proposed source range. Audio estimation and cut protections are unchanged.
