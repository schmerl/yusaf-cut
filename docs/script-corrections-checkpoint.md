# Script corrections: inline workflow checkpoint

Branch: `feature/script-assisted-transcript-corrections`. Build: `4.8.0-dev.3`.
The earlier walkthrough found slow audio analysis, excessive panels, missing native
Undo/Redo, lost transcript position after cutting, and an Undo → Keep error. This
checkpoint addresses that workflow. **The complete automatic correction feature
is still unfinished; automatic wording changes remain disabled.**

## What changed

- **Open** offers an existing project, or a recording with an optional Markdown
  script. The script is checked before importing media and stored with the project.
  **File → Add / Replace Script** provides later changes and stored preview/history.
- Native macOS **File, Edit, Review and Window** menus connect to application
  commands. Edit → Undo/Redo controls project history, including text and cuts.
  Ordinary input fields keep their own text undo. Visible Undo/Redo also remain.
- **Find differences / Check selection** show text-based review suggestions without
  launching Whisper. These are proposals, not claims that the audio confirms the
  script. A measured development paragraph of 103 characters matched in 27 ms
  locally; that measures matching only, not the complete UI or every passage.
- Click a marked phrase to open Play and Accept/Dismiss or Preview cut/Cut/Keep.
  Fillers and off-script speech use the same small popover. Previous/Next and the
  category selector replace the persistent review panels. A selected run limits
  the navigation queue to that passage; earlier pending items remain saved.
- Cutting preserves transcript scroll position. Undo restores an actionable item
  without a Refresh review step. Changed projects discard prior cut previews;
  actions revalidate the current occurrence before committing.
- **Options** contains simple formatting for the current review queue, explicit **Check audio (slower)**, and
  detailed filler settings. Audio checking remains local, bounded and cancellable;
  no additional model is downloaded. Existing independent audio evidence is retained
  when rerunning text-only comparison. Advanced filler controls remain in a dialog.

## Human review script — do this now

Allow about 10 minutes. The earlier parser/listening-label reviews do not need
repeating. Fresh disposable projects were prepared below; your earlier review copies
and original projects were preserved. They reference the original recordings.
Autosave affects the disposable project, so use the specified paths.

1. Quit the old build and launch this exact app:

   ```sh
   open /Users/schmerl/programs/yusaf-cut/src-tauri/target/debug/bundle/macos/YusafCut.app
   ```

   It has not been installed over your regular app. Confirm native **Review** and
   **Edit → Undo / Redo** menus, and a compact transcript toolbar after opening speech.

2. Click **Open → Open saved project…**. In the chooser press **⌘⇧G** and enter:

   ```text
   /private/tmp/yusafcut-script-study/workflow-review-1.scribe
   ```

   Open that folder. Use **File → Add / Replace Script… → Import Markdown** to import
   `/private/tmp/yusafcut-script-study/script-openapi.md`. Close the script dialog.
   There should be no persistent script panel occupying the transcript.

3. Use **Edit → Find / Replace** (⌘F), search for `valid Jason`, then close search.
   Select that complete spoken paragraph and click **Check selection** (or
   Review → Find Differences in Selection). Time how long it takes to show a dashed
   marker. There should be no Whisper job or audio wait. Click the JSON candidate:
   expect a small replacement popover. **Play** listens without deciding; **Accept**
   changes only the text. Duration must stay fixed.

4. Use native **Edit → Undo**, then **Redo**. Try the visible buttons too. Both
   should reverse/reapply the correction and marker together. Save and reopen the
   disposable project; the correction and stored script should persist.

5. Change the corrected paragraph's final period to `!`, select it and **Check
   selection**. Leave its formatting suggestion unresolved. **Options → Apply simple
   formatting** must preserve your manually typed `!`. Now find `hail me` around
   source 01:24, select its full sentence/paragraphs and **Check selection** again.
   Previous/Next should review this passage, without showing the earlier `needs!`
   item. That item remains saved at its own marked location.

6. Click the local HailMe suggestion: its Before text must not swallow the adjacent
   `in this [UH] class` aside. Accept the name separately. Click the violet off-script
   aside, **Play**, then **Preview cut**. Preview changes nothing. **Cut speech**
   should match the preview and shorten the timeline. The transcript must stay near
   this passage. Use native or visible **Undo**, then **Keep speech** immediately in
   the popover: no project-changed/refresh error should appear.

7. Choose **Review → Review Fillers**. Navigate or click an amber filler directly.
   Its popover offers Play, Preview cut, Cut speech and Keep speech. Preview and cut
   one filler, listen to the join, then Undo → Keep speech. Check transcript position
   and duration. **Adjust cut** exposes timing offsets and audio estimation on demand;
   unusually short timing anchors require an audio estimate before the inline cut.
   Text-only hiding and detection preferences remain under the optional controls.

8. Test the opening flow without modifying the original project. Use **Open**,
   **Choose video or audio…**, select either original study recording, and add the
   corresponding `script-openapi.md` or `script-http.md` using **Add script (optional)…**.
   Click **Start editing**. Expect a new unsaved project with its stored script;
   transcription may still be needed if no cached transcript exists. Canceling setup
   should leave the current project unchanged. Do not save over an original project.

9. Optional: in the disposable copy, use **Options → Check audio (slower)** for one
   selected paragraph. This explicitly runs the existing local recognizer and may
   take substantially longer. **Cancel** must preserve existing text and decisions.
   Details must distinguish text-only comparison from independent recognition.
   This is not required to accept suggestions or apply simple formatting.

Report step numbers, rough suggestion latency, any jumps in transcript position,
preview/committed join quality, and whether the popovers feel easy to use. Native
menu focus/shortcuts and audible joins need human verification; unit tests alone do
not establish those behaviors on macOS.

## Evidence and outstanding work

See the [acceptance audit](script-corrections-acceptance.md) and
[acoustic design note](plans/02-script-acoustic-design.md). Automated checks cover
text-only suggestions without recognizer calls, retained audio evidence, optional
script opening, native menu command/history wiring, inline review/captions,
preview/commit identity, scroll preservation, Undo → Keep, and stale audio estimates.
Validation: typechecking/lint, 303 frontend tests and 66 Rust tests pass, and the
debug macOS app builds. Native UI automation was not approved for YusafCut, so its
running menus, focus behavior and audible joins were not inspected automatically.
Original study project hashes still match; private recordings/scripts/labels remain
outside Git. New workflow copies do not overwrite your earlier review copies.

The twelve listening labels are complete; only the six development labels were
inspected. No new acoustic model was downloaded. Automatic eligibility/application,
held-out evaluation, native release acceptance and final SC-01–SC-16 verification
remain unfinished. This review workflow must not be called the completed automatic
feature. Older binaries may reject or discard the new metadata; use this branch and
disposable copies.

## Final human review — still required after the full feature is complete

The final script will cover evaluated automatic corrections and Keep/Revert,
selected/whole atomic Undo, manual protection and bulk formatting, persistence and
script replacement/history, native menu/keyboard focus, off-script/filler audible
joins, reused clips and existing cuts, caption/export invariants, cancellation and
session races. The current walkthrough is an intermediate workflow checkpoint.
