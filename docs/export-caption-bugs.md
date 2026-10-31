# Caption export bugs — next-thread handoff

Recorded 2026-10-31 from user review. **Reported, not independently reproduced or
fixed in this thread.** The inline review workflow is good enough to continue work.

Implementation checkpoint: `1816e01` on
`feature/script-assisted-transcript-corrections`, build `4.8.0-dev.7`.
The working tree was clean and the implementation already committed before these
bugs were recorded. Automatic wording application remains outside this checkpoint.

Tracked in [GitHub issue #17](https://github.com/schmerl/yusaf-cut/issues/17) in this fork.

## CAP-01 — Exported captions do not reflect transcript corrections

User report: in **Review fixes (disposable).mp4**, exported captions show **HDTP**
where the edited transcript has **HTTP**, and **Jason** where it has **JSON**.

Project used:

```text
/private/tmp/yusafcut-script-study/review-fixes-1.scribe
```

Expected: caption text uses the current edited transcript on the edited timeline,
including accepted script corrections and manual text edits. Raw recognition
anchors/caches should remain unchanged.

Next-thread reproduction:

1. Preserve this project and export as evidence; work on a disposable copy.
2. Confirm the HTTP/JSON corrections in the live transcript and saved project.
3. Identify the actual caption route: subtitle track/burned-in text in the MP4,
   an accompanying SRT/VTT, or another export. Confirm the artifact's full path and
   that the player is loading the newly generated captions.
4. Export through that route and compare the affected caption text with the saved
   transcript projection. Check SRT and VTT separately if applicable.

Start tracing at `src/lib/captions.ts`, the caption/video export handlers in
`src/components/Toolbar/Toolbar.tsx`, `src/lib/transcript.ts`, and the relevant
native export/transcript path. Do not assume the cause is raw-word reuse until
following the actual route. Existing projection tests did not establish that this
reported export artifact contains the corrected wording.

## CAP-02 — Caption grouping creates unnecessary single-word lines

User report: exported transcript/captions contain lines with just one word, making
them difficult to read.

Expected: readable phrase grouping and balanced line breaks/cue timing, avoiding
unnecessary isolated words while respecting meaningful utterances, pauses and cuts.

Next-thread reproduction:

1. Inspect representative short lines in the exported caption artifact.
2. Distinguish a one-word line inside a multi-line cue from a separate one-word cue.
3. Check whether edit timing groups, paragraph/segment splits, or cue wrapping are
   driving the fragmentation. Compare against both the edited transcript and the
   resulting video timing.

Investigate grouping/wrapping in `src/lib/captions.ts` after confirming the export
route. Record concrete examples and intended grouping before changing the policy.

## Follow-up validation

- Verify HTTP/JSON corrections survive save/reopen and the real export route.
- Cover accepted/manual corrections, multi-anchor replacements, hidden fillers,
  cuts splitting paragraphs and reused clips with regression tests.
- Inspect caption text, line breaks and cue durations together; preserve correct
  output-time mapping, source media and raw recognition.
- Provide a short human export/playback review script for the next build.

No export code was changed, no affected artifact was overwritten, and no new
export test was claimed as passing in this documentation-only handoff. Temporary
study paths may disappear; preserve the relevant evidence before cleanup.
