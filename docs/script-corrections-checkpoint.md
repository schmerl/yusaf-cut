# Script corrections: acoustic review checkpoint

Status: Phase 0 in progress. This is an intermediate checkpoint, not a completed
feature or a release. Branch: `feature/script-assisted-transcript-corrections`.

The next required input is human listening labels. The implementation plan
requires labeled real audio before choosing and enabling automatic wording
corrections. No new reconciliation command, import UI, automatic application,
project metadata, or off-script cuts have shipped at this checkpoint.

## What is ready

- `scripts/script-correction-study.py`: read-only source inspection, streaming
  SHA-256 inventories, bounded mono 16 kHz extraction, blind listening forms,
  label validation, and local Whisper comparison. Explicit source bounds cannot
  bridge existing cuts or silently select a different reused occurrence.
- Each comparison runs an **unprompted** decode, a **script-prompted** decode,
  and a **deliberately incorrect prompt** control. Outputs are diagnostics, never
  changes to a project. Raw recognition caches are not read or rewritten.
- Six development and six held-out clips from the two supplied pairs have been
  prepared locally. Held-out decoding is locked during development. Labels stay
  private; the label validator reports completeness without printing their text.
- Disposable native project copies have new project IDs and retain read-only
  references to the original media. They contain copied project JSON, not source
  snapshots or caches. All input files were hashed before and after preparation.
- Existing baseline: typecheck/lint, 233 frontend tests and 61 Rust tests pass.
  New evaluation-tool tests cover occurrence isolation, cut boundaries, invalid
  inputs, changed-source guards, failed preparation, held-out locking, safe HTML,
  and preserving inputs. See the linked design note for acoustic results.

Private artifacts are under `/private/tmp/yusafcut-script-study`. This directory
is temporary and may be cleared by the operating system. Keep the exported labels
with it until this checkpoint is resolved. Nothing from the private study belongs
in Git. The reusable tool accepts arbitrary config paths; no private input paths
or recordings are embedded in its code or tests.

## Human review script — do this now

Allow about 5–10 minutes with headphones.

1. Open the listening page locally:

   ```sh
   open /private/tmp/yusafcut-script-study/listen.html
   ```

2. For each of the twelve cards, **listen before expanding the comparison**.
   Write the words you actually hear. Include repetitions, fillers, unfinished
   words, and spoken letters/numbers. Technical spellings you know are welcome;
   use the notes to distinguish what you heard from your interpretation.
3. Choose **clear**, **uncertain**, or **inaudible**. Then expand the comparison
   and choose whether the scripted wording matches the audio. Uncertainty is a
   useful result; do not choose a script word just because it is displayed.
4. Add notes where an aside or substitution was intentional, or an identifier
   was spoken differently. Do not simplify repeated or abandoned words away.
5. Click **Download listening labels** at the bottom. Answers are held only in
   the open page until downloaded; do not refresh or close before exporting.
   Save the downloaded `listening-labels.json` into the study folder.
6. Validate that the export is complete:

   ```sh
   python3 scripts/script-correction-study.py validate-labels \
     --study /private/tmp/yusafcut-script-study \
     --labels /private/tmp/yusafcut-script-study/listening-labels.json
   ```

7. Tell Codex that the labels are ready and their local path. Do not paste
   held-out transcriptions into chat; they will be reserved for evaluation after
   the policy is frozen. If playback/export fails, report the browser and error.

### Optional native-editor check

This checks listening bounds against the actual editor. It does **not** test a
new reconciliation UI, which has not been implemented yet.

1. Start the current app with `npm run tauri:dev`.
2. Open `/private/tmp/yusafcut-script-study/review-project-1.scribe`, using the
   app's Open action. Its title starts with **Listening study copy**. This is
   the OpenAPI project. Do not open or save over the original project.
3. Search for `valid Jason`. Listen around 00:44–00:53; compare the same audio
   with the `openapi-json` listening card. Confirm that the clip contains the
   disputed phrase with context, without cutting a syllable at its edges.
4. Open `/private/tmp/yusafcut-script-study/review-project-2.scribe`. Search for
   `item potency`; listen around 00:34–00:47. Search for `get slash payments`;
   listen around 02:57–03:10. Record any boundary or playback discrepancy.
5. Close the copies. No editing, re-transcription, or saving is needed for this
   check. Report any discrepancy along with the card ID and what happened.

## Checks and reproducibility

```sh
python3 -m unittest discover -s tests -p test_script_correction_study.py -v
npm run check
npm test -- --reporter=dot
cargo test --lib --offline --manifest-path src-tauri/Cargo.toml
```

The private `study-config.json` used for this machine is under
`/private/tmp/yusafcut-script-study-config`. To recreate artifacts, choose a
**new** output directory and run:

```sh
python3 scripts/script-correction-study.py prepare \
  --config /private/tmp/yusafcut-script-study-config/study-config.json \
  --output /private/tmp/yusafcut-script-study-2 \
  --ffmpeg src-tauri/target/debug/ffmpeg
```

A config has `version: 1` and a `cases` array. Every case supplies a unique
lowercase `id`, project bundle/file path (`project`), UTF-8 `script` path, exact
`segmentId`, finite `sourceIn`/`sourceOut` seconds (at most 30 seconds),
`split` (`development` or `held-out`), `scriptExcerpt`, `adversarialPrompt`, and
`purpose`. Excerpts/prompts are proposed comparisons, never listening labels.
The script source is hashed and validated as UTF-8; full Markdown parsing is
future Phase 1 work. The study does not claim to test that parser.

Use `decode --help` for the local engine/model command. Each run writes a new
diagnostic folder with engine/model hashes, elapsed time, and raw decoder JSON.
The output is never used as independent ground truth. Ctrl-C or failure records
the run as failed and does not commit a project change. Models are not installed
or downloaded by this tool. No cloud provider is involved.

## Work after this review

1. Validate labels; use only development labels for acoustic design/calibration.
2. Test/revise a concrete acoustic comparison approach. Prompted agreement and
   forced alignment are insufficient. Keep automatic application disabled until
   the predeclared acoustic gates pass.
3. Implement persisted Markdown/provenance/review foundations, pure matching,
   bounded local IPC and atomic run/review transactions, then editor review and
   explicit off-script cutting. Preserve the existing transcript as the only
   writable display-text representation.
4. Freeze the rule, evaluate held-out audio and mandatory adversarial cases,
   perform native acceptance, and complete the SC-01–SC-16 evidence audit.

The next app checkpoint should combine import, reconciliation and review into
one useful walkthrough. Do not stop merely because another implementation phase
ended. Final review will receive an updated script based on actual UI labels.

## Final native review script — planned, not runnable yet

This is the coverage target for the final walkthrough, not evidence of passing.

1. Use disposable copies of both supplied projects. Note duration, existing cuts
   and a manually corrected/hidden passage; create a named snapshot.
2. Import the corresponding script. Also test a synthetic script with ATX and
   Setext headings, `<press>` followed by speech, Unicode, inline notation,
   escaped brackets, links/images, and code blocks. Invalid import must preserve
   the prior script and project.
3. Select a passage containing a recognition error and reconcile. Confirm scope,
   progress, an audio-supported automatic correction and its active marker.
   Listen, Keep, Undo/Redo, and Revert a separate correction. Check before/after
   evidence and preservation of manual edits, fillers and existing cuts.
4. Review pending items with Accept/Dismiss; bulk-apply punctuation. Each action
   must be undoable at its documented grouping. Rerun unchanged inputs and verify
   resolved decisions are not duplicated or reopened.
5. Save/reopen, recover the snapshot, and replace the script. Check durable
   evidence, review history, pending invalidation, explicit rerun, and Undo.
6. Listen to an off-script passage, preview the cut, then Cut speech. Confirm
   actual cut bounds, duration, playback joins, captions, save/reopen and Undo.
   Keep an intentional aside. Partial corrected timing groups must reject.
7. Cancel a run and test missing capability. Controlled automated tests cover
   concurrent edits/project switches and second-clip failure without risking
   originals. No staged changes should commit on failure or cancellation.
8. Repeat after filler hiding/cuts and with reused/multiple clips. Export SRT/VTT;
   check only current corrected text appears. Text-only operations must preserve
   exact EDL/export plans and source hashes; explicit speech cuts change duration.

Unperformed: all new-feature native acceptance, calibrated/held-out precision,
native release build, and the final acceptance audit. The label page has not yet
been visually verified: native Chrome automation timed out in this environment.
