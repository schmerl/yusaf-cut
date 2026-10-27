# Manual retake acceptance test

Use a **copy** of a project or a short disposable recording with a transcript.
This walkthrough checks native playback and export behavior that automated tests
cannot establish. Do not use the original recording as an editable test artifact.

## Prepare

1. Run `npm start` from this feature branch, or open its built `.app`.
2. Import a short recording with an obvious repeated phrase, a spoken correction
   (for example, “Use POST—sorry, PUT”), and, if available, three attempts at
   one sentence. Transcribe it. Keep a copy of the source file outside the
   project, and record its SHA-256 with `shasum -a 256 /path/to/source.mp4`.
3. Save the project under a new `.scribe` name. Note its output duration.

## Review without editing

1. Select **Toolbox → Retakes**. Under **Analysis runtime**, choose **Local
   Ollama**, select an installed model, and select **Find retakes**. The **Refresh
   models** button updates the list if Ollama was started after opening the
   dialog. Alternatively, choose **Bundled MLX runtime** and download its
   approximately 4.6 GB model. Cancel a detection run once, then rerun it.
2. Check that the passage and take choices are the words you heard. False
   positives, missed retakes, and incorrect suggested takes should be noted.
3. Select **Play original**. Hear the complete passage and surrounding speech.
   Choose a different take and select **Preview cut**. Hear both joins and check
   that unrelated words remain. The preview is labeled “Proposed cut — not
   accepted.”
4. Close the dialog, reopen it, and verify the edit and dirty state have not
   changed. Run detection again and **Dismiss** one candidate; dismissal should
   only advance this review run.

## Accept and persist

1. For a three-take group, choose the first or middle take and preview it.
   Check the retained continuation and that no discarded pause lingers. Select
   **Accept cut** once. The next valid candidate should remain reviewable.
2. Use **Undo** once to restore all speech removed for that group; use **Redo**
   once to reapply it. Rerun detection after undo or any unrelated edit, since
   prior review results are invalidated.
3. Save, close, and reopen the test project. Confirm the accepted cut, output
   duration, and transcript remain the same.
4. Export MP4, SRT, and VTT from the reopened project. Listen across every
   proposed join in the MP4; compare its duration and caption text/timing with
   the edited timeline. Verify the source hash still matches.

## Report

Record the Mac model and memory, app commit, model download/result, candidate
examples, any missed or incorrect suggestions, audible join quality, project
reopen outcome, export outcome, and whether the source hash stayed unchanged.
Detection quality on real recordings is not established by the automated tests.
