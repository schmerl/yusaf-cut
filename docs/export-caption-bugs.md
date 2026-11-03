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

## Issue 17 investigation and repair — 2026-11-01

The sections above preserve the original report. The findings below supersede
its unverified status for the investigated artifacts.

### Evidence and caption route

Preserved `project.json`, `Review fixes (disposable).mp4` and the matching `.srt`
from the reported project in `/private/tmp/yusafcut-issue17-evidence/` before
working on them. The original files were not overwritten.

- `ffprobe` reports H.264 video and AAC audio only in the MP4: no subtitle track.
  The frame inspected at 3 seconds has no burned-in captions. The native video
  exporter has no caption-rendering path; the **Captions** toolbar/menu action
  independently builds and writes SRT or VTT.
- The saved transcript and accompanying SRT already contain HTTP and JSON, with
  no HDTP/Jason caption text. One accepted review replacement has immutable
  original text `Jason` and displayed text `JSON`, around output time 00:48.
  The existing SRT correctly exports that replacement.
- Consequently, the original wording report was **not reproduced** in the
  preserved files. Which player/caption source showed HDTP/Jason is still
  unconfirmed; do not attribute that observation to raw-word reuse.
- A separate reproducible stale-revision case was found in the Captions handler:
  it serialized the revision captured before awaiting the save dialog. It now
  reads the current store revision after the dialog returns. Switching projects
  during the dialog cancels that export with an explanatory error.

### Grouping repair

The old SRT contains 359 cues, including 22 single-word cues (separate cues,
not wrapped lines). For example, the passage at 00:11.480–00:17.000 ends with
`it.` in a 140 ms cue after the preceding cue exceeds five seconds.

Grouping now chooses balanced boundaries over each passage between pauses,
with penalties for single-word cues and short flashes. Sentence endings remain
preferred boundaries. Cue candidates respect five seconds and fourteen displayed
words, counting all words in edited runs. A replacement timing group stays whole,
even when that group alone exceeds a limit; no word timings are invented.
Manually joined adjacent runs cannot be split into partial words. Caption
whitespace is normalized so text-edit newlines cannot force orphaned lines.

Re-exporting the preserved saved project using the production SRT/VTT builders
produces 361 cues, with **4 single-word cues instead of 22**, and none over five
seconds. The four remaining words (`state.`, `3.1.2`, `JSON.`, `Third,`) are
separated from neighboring speech by gaps of at least 700 ms, which remain hard
boundaries. The full caption wording matches the saved transcript projection;
no HDTP/Jason text appears. Project data remains byte-for-byte unchanged in
memory. Generated review files are `corrected.srt` and `corrected.vtt` in the
evidence directory.

### Automated validation

- Caption grouping regression uses the actual words/timings of the reported
  `it.` fragment, and also covers word-limit tails, expanded replacements and
  genuine one-word utterances separated by pauses.
- Toolbar export tests exercise SRT and VTT writes after JSON save/reopen,
  accepted review corrections, manual multi-anchor replacements, reused clips,
  hidden text, cuts splitting paragraphs, unchanged raw words/timeline,
  corrections arriving during the save dialog, project switches, cancellation,
  and write errors. Separate caption tests cover HTTP/JSON over raw HDTP/Jason
  and text-hidden fillers.
- Frontend tests, `npm run check`, and `npm run build` pass. Native code was not
  changed. These checks do not establish native save-dialog operation or actual
  player synchronization in a rebuilt desktop app.

### Human export/playback check for the next build

1. Open a disposable copy of the study project in the rebuilt app. Confirm JSON
   around 00:48 and HTTP in the transcript. Make another manual correction,
   save, close, and reopen; confirm both accepted and manual edits remain.
2. Use **Captions** to save uniquely named SRT and VTT files. Inspect those exact
   paths for the corrected text, numbered SRT cues and the `WEBVTT` header.
3. Open the edited MP4 in a player and explicitly load the new SRT. Confirm the
   selected caption source is that file. Check JSON around 00:48 and the phrase
   around 00:11–00:17: `it.` should remain with surrounding words. Check timing
   near a cut and later in the recording. Repeat with VTT in a supporting player.
4. Confirm genuine pauses/short utterances remain distinct and corrections apply
   only to the edited occurrence when source clips are reused. Cancel an export
   and confirm it creates no file.

A player showing HDTP/Jason despite the newly selected file containing HTTP/JSON
still needs its caption source identified; that original observation is not
claimed resolved by these automated checks.

## Readability and script slide breaks — 2026-11-02

This follow-up supersedes the five-second/fourteen-word/700 ms grouping policy
above. The user requested flowing captions within slides and an untimed YouTube
transcript with slide breaks.

- **Captions** now offers **YouTube transcript (without timing)** (`.txt`) alongside
  SRT and WebVTT. It exports current corrected speech in edited playback order,
  including reused clips, with blank lines only at confidently matched script
  section openings. It does not include headings, cue numbers or timestamps.
  With no usable script mapping, text remains continuous.
- Markdown passages retain the enclosing heading's source offset as well as its
  title. Consecutive slides with identical titles remain distinct. Nothing new
  is persisted to the project format.
- Slide matching uses up to twelve normalized opening words per heading section,
  tolerating small transcription differences. At least six words and a distinctive
  script opener are required. Repeated/ambiguous openers and malformed sections
  are skipped. Matching follows the current output text, so cuts, omitted slides,
  reordered clips and repeated takes do not require source-order assumptions.
  A short ad-libbed lead-in such as “So” stays with the next slide.
- These are approximate **spoken** transitions, not detected visual slide changes.
  A boundary inside an indivisible edited timing group is skipped rather than
  assigned an invented timestamp. Unmatched boundaries fall back to ordinary
  caption grouping; headings are never inserted into caption text.
- SRT/VTT cues can span editor paragraphs and ordinary pauses. Confident slide
  transitions and silences of at least two seconds are hard boundaries. Cue
  grouping prefers sentence endings and balanced reading lengths, penalizes
  single words, short flashes and insufficient reading time, and uses limits of
  seven seconds, twenty words and 84 characters. Indivisible replacement groups
  retain the earlier exception to these limits. Display text wraps into at most
  two balanced lines, targeting 42 characters per line; long words or indivisible
  groups can exceed that target. Untimed text has none of these display breaks.

Validation on the preserved study project: **19 matched sections out of 22**,
**256 timed cues**, no single-word cues, no cues over seven seconds, and at most
two display lines per cue. Both timed text and untimed text match the complete
saved transcript projection after whitespace normalization. The project remains
unchanged. Review artifacts are `slide-aware.srt`, `slide-aware.vtt` and
`untimed.txt` under `/private/tmp/yusafcut-issue17-evidence/`.

All 362 frontend tests pass, as do type checking, lint and the production frontend
build. Added checks cover duplicate heading titles, approximate/ambiguous matches,
omitted/reordered/reused slides, paragraph splits, edits/cuts, indivisible timing
groups, ad-libbed lead-ins, long versus ordinary pauses, balanced lines and the
native-dialog handler's `.txt` export route. Native desktop playback and YouTube
alignment have not been exercised by these automated checks.

For human review, load the new SRT or VTT explicitly in the player and inspect
transitions around 01:35, 02:31, 13:05 and 22:21. Compare those spoken transitions
with the actual slide changes. In YouTube Studio, upload the exported `.txt` using
**Without timing** (or Auto-sync); blank lines request a new caption at matched
slides. Review YouTube's generated grouping and timings before relying on them.
The three unmatched script openings intentionally have no forced slide break.
