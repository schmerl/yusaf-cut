# Script corrections: native review checkpoint

Status: implementation in progress on `feature/script-assisted-transcript-corrections`,
version `4.8.0-dev.2`. The twelve listening labels validate; that review is complete.
**The full feature is not complete: automatic wording application is disabled.**

This checkpoint combines import, matching, local audio analysis, review, persistence
and off-script cutting. It is the next useful app walkthrough, not a stop at each phase.

## What is ready

- Import/replace a stored UTF-8 Markdown copy and SHA-256 revision through **Script**.
  Spoken preview excludes headings, cues, comments, images and code blocks; retains
  labels, inline code, escapes and Unicode. Ambiguous markup has location warnings.
- Whole/selected reconciliation uses bounded local unprompted Whisper analysis.
  Context cannot cross existing cuts. Recognition anchors/caches are never rewritten.
  Results are staged until success and project/session/script validation. Cancel and
  intervening edits discard staged results; late progress/results are ignored.
- Pending wording/notation, uncertain alignment and off-script candidates have distinct
  review states. Local name corrections preserve adjacent fillers/asides. Exact spoken
  method/path/digit matches can propose written notation. Repeated takes stay uncertain.
- Accept/Dismiss, bulk punctuation/capitalization, bounded original listening, off-script
  Preview cut/Cut speech/Keep, history and distinct editor markers. Preview and commit
  use one immutable proposal with actual source bounds. Stale previews require refresh.
- Manual typing, paste, replacement, restoration, filler hiding and explicit review
  decisions retain protection. Untouched normalized overlays remain eligible. Simple
  formatting preserves existing timing groups; technical/ambiguous formatting stays
  pending for individual review.
- Native save/load/snapshots preserve scripts, provenance, review outcomes and bounded
  acoustic evidence. Edits reconcile stale mappings in the same transaction. Replacement
  keeps accepted/applied text and old evidence, archives pending/off-script results,
  starts no new analysis, and is undoable. Successful re-transcription invalidates
  affected active results; failure preserves them.

Keep/Revert controls for applied automatic records are implemented and tested with a
synthetic shared fixture. This build cannot generate those records through reconciliation;
it always reports **0 automatic corrections**. No additional acoustic model was downloaded.
Ambiguous homophones such as item potency/idempotency are ordinary review cases, not a
prerequisite for installing another model.

## Human review script — do this now

Allow about 15–20 minutes. Use only the disposable copies below. They have new project
IDs and reference the original recordings without modifying them. Autosave writes the
copy, not the original project. Files in `/private/tmp` can be cleared by the OS.

1. Quit any running YusafCut, then open the review build explicitly:

   ```sh
   open /Users/schmerl/programs/yusaf-cut/src-tauri/target/debug/bundle/macos/YusafCut.app
   ```

   Confirm **Script** is present above the transcript. This build has not been installed
   over the regular app. Alternatively run `npm run tauri:dev` from this branch.

2. Use the app's Open action for:

   ```text
   /private/tmp/yusafcut-script-study/review-project-1.scribe/project.json
   ```

   Its title begins **Listening study copy**. Note the initial duration. Do not save
   over the original `.scribe` project.

3. Open **Script → Import Markdown** and choose
   `/private/tmp/yusafcut-script-study/script-parser-smoke.md`. Expand **Spoken script
   preview**. Expect speech after `<press>`, literal GET/path notation, visible link
   label, escaped/literal angle brackets, café/emoji, and speech after the comment.
   Title/Setext heading, cue, image alt/destination and code block must not contribute
   spoken text. Expect a line warning for the unclosed cue, with following speech
   retained. Transcript and duration must remain unchanged.

4. **Replace script** with `script-headings-only.md` from the same folder. Expect a
   No spoken text error while the previous stored script remains. Cancel a chooser
   once; cancellation must create no edit. Then replace with `script-openapi.md`.

5. Search for `valid Jason`. Drag-select its complete spoken paragraph, including
   punctuation. Choose **Selected passage**, leave **large-v3-turbo** selected, and
   click **Reconcile script**. Expect progress and a pending Jason → JSON suggestion.
   Other formatting items are possible. Nothing should be corrected automatically.
   Listen and inspect the script/audio evidence. Listening/navigation must not resolve
   an item or change the project.

6. **Accept suggestion** for JSON. Only that occurrence's text changes; duration stays
   fixed. One **Undo** restores Jason and its pending marker together; **Redo** restores
   accepted text. Re-select the paragraph and rerun: unchanged resolved items must not
   duplicate or reopen. Save/reopen the disposable project; confirm stored preview,
   corrected text and History outcome persist.

7. Manually change that paragraph's final period to `!`. Select the paragraph and
   reconcile. Its punctuation suggestion must require individual acceptance.
   **Apply punctuation/capitalization** must preserve the manually typed `!`.
   Leave this item pending for the replacement check below if convenient.

8. Search for `hail me` around source 01:24, select its full spoken sentence/paragraphs
   and reconcile. Expect a local hail me → HailMe proposal that does not consume the
   adjacent `in this [UH] class` aside. Find that aside with the **Off-script** filter.
   Inspect actual cut bounds, **Listen**, then **Preview cut**. Preview changes nothing.
   **Cut speech (audio/video)** should shorten duration and match the preview. Listen
   to the join. **Undo immediately**: speech, duration and review state return together.
   Then **Keep speech** to retain the intentional aside. Accept the name separately;
   inspect the Before text when navigating past other pending items.

9. **Replace script → script-openapi-updated.md** from the study folder. It differs
   only by an unspoken comment. Accepted text must remain; pending/off-script results
   move to History with a replacement reason. No analysis starts. Earlier cards retain
   their original script evidence. One **Undo** restores the prior script/pending state
   without undoing unrelated corrections. Save/reopen again if convenient.

10. Start **Whole edited transcript** reconciliation, then **Cancel analysis** while
    progress is visible. Existing text, decisions and cuts must remain; no partial new
    results should appear. Also try an uninstalled model (e.g. tiny if absent): expect
    setup/retry guidance without a download or project change. Restore large-v3-turbo.

11. Open `/private/tmp/yusafcut-script-study/review-project-2.scribe/project.json` and
    import `script-http.md` from the study folder. Select the full passage containing
    `get slash payments slash P four five six` around source 03:00 and reconcile.
    Inspect/accept the GET /payments/P456 proposal. Method, identifier and digits must
    agree with the audio. Duration stays fixed. Selecting only part of the corrected
    timing group and using the editor's **Cut speech** must reject without broadening
    the cut to the whole phrase.

12. Optionally reconcile the sentence starting `Put and delete can change state`
    around source 07:05, then bulk-apply its capitalization. One Undo restores the
    complete bulk action. Save/reopen; export SRT/VTT if convenient. Captions must
    contain only current text, without review labels. Review fillers before/after
    reconciliation on a disposable copy; hidden text and existing cuts must persist.

Report step numbers, actual behavior and error text, and whether preview/committed
cut joins sounded clean. If an expected item is absent, include scope and result counts.
Uncertainty is useful feedback; automatic wording correction is unavailable at this
checkpoint. Do not repeat the original listening-label form.

Optional independence check: after saving, temporarily rename only the study folder's
`script-openapi.md`, reopen the disposable project and inspect the stored preview. It
must still work. Restore the temporary filename; do not rename the original script.

## Evidence and remaining work

See the [acceptance audit](script-corrections-acceptance.md) and
[acoustic design note](plans/02-script-acoustic-design.md).

Tests cover parser/schema, pure matching, history/actions, real editor controls,
caption invariants, and controlled async failures. Native save/load/snapshot tests
preserve scripts/provenance/evidence and reject malformed/future metadata without
replacing a valid saved project. `tests/fixtures/script-assistance.json` is the shared
synthetic TS/Rust example, not evidence of real automatic corrections.

Checkpoint validation: typechecking and lint pass, with 293 frontend tests and 65
Rust tests passing. The debug macOS app is built for the walkthrough; native human
review remains pending.

Only six development labels have been inspected. Held-out labels/decoding remain
reserved for a frozen policy. Direct contrastive scoring was prototyped against the
existing model; it is not the in-app provider or a calibrated automatic rule. Original
source hashes still match the prepared study. Private scripts, labels, audio, model
outputs and diagnostics remain outside Git.

Outstanding: native human walkthrough/audible joins, evaluated automatic eligibility
and atomic application, held-out acoustic metrics, native release build, and final
SC-01–SC-16 acceptance. Fix walkthrough issues, then complete that work. A review-only
prototype must not be called the completed automatic feature.

Older app binaries may reject or discard the new metadata. Use this branch's build
and disposable copies. Project outer version stays 1; metadata is independently
versioned. There is no backward-write guarantee.

## Final review script — coverage target, not passing evidence

The final walkthrough will be updated for the completed build and include:

1. Valid/invalid Markdown import, whole/selected runs, protected/hidden text, and one
   successful run's atomic Undo.
2. Real evaluated automatic corrections with markers, before/after/script/audio,
   Listen/Keep/Revert and separately undoable review actions.
3. Pending Accept/Dismiss, bulk formatting, and reruns preserving explicit decisions
   across reused occurrences.
4. Save/reopen, script replacement/Undo, snapshots/recovery, and historical evidence
   associated with the original script revision.
5. Off-script listening/preview/explicit cut/Keep; actual bounds, audible joins,
   duration, captions, exports and per-cut Undo.
6. Safe cancellation/capability checks plus controlled edit/session/second-clip races.
7. Before/after filler review, existing cuts and multiple/reused clips; source hashes,
   exact text-only EDL/export invariants, and SRT/VTT inspection.
