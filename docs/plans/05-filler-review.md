# Implementation plan: feature 5 — occurrence-by-occurrence filler review

Status: Phases 1–5 implemented on 2026-10-29; phase 6 native acceptance is
pending human hands-on review. Requirements and user decisions are recorded in
[feature 5](../requirements/05-filler-review.md). See the
[runnable checkpoint](../filler-review-checkpoint.md).

## Starting point and scope

The inspected branch is `docs/filler-review-and-script-assistance`, at `5064445`
before this planning update. It contains local `main`/`origin/main` at `a847cfd`
and the implemented manual transcript correction APIs. These are local refs;
this planning session did not fetch remote branches.

Reuse the correction foundation; do not reimplement it. Relevant entry points:

| Area | Existing code | Planned use/change |
|---|---|---|
| Transcript projection and original anchors | `src/lib/transcript.ts` | Match current text and recover hidden recognized fillers |
| Text edits and cut validation | `src/lib/transcriptEdits.ts` | Reuse text deletion and group/nonempty validation; add precise cut integration |
| EDL and source/output mapping | `src/lib/edl.ts` | Construct exact occurrence-scoped retained ranges |
| Project history and stale revision checks | `src/stores/projectStore.ts` | Atomic review decisions and one-step undo |
| Native project representation | `src-tauri/src/edl.rs`, `src-tauri/src/transcript.rs` | Persist optional metadata without dropping it on round trip |
| Playback and frame clock | `VideoPreview.tsx`, `useVideoFrameClock.ts` | Audition immutable alternate timelines and bounded playback |
| Transcript decorations | `TranscriptEditor.tsx` | Highlight candidates in the current editable document |
| Existing filler controls/counts | `WordNode.ts`, `FindReplacePanel.tsx`, `Toolbox.tsx`, `Waveform.tsx`, `StatusBar.tsx` | Replace divergent lists and bulk entry points |

The editable transcript currently renders projected plain-text paragraphs with
decorations, rather than relying on `WordNode.renderHTML`. Updating WordNode's
list alone will not implement highlighting. Existing word cuts also use project
padding and whole-anchor removal; they cannot be used unchanged for exact cut
offsets or hidden-text candidates.

Deliver a review panel, unified candidate policy, durable decisions, precise cut
proposals, and explicit before/preview/result playback. No new transcription
model, contextual classifier, script assistance, waveform boundary editor,
crossfades, bulk filler deletion, or automatic review advance is included.

## Review behavior

1. On transcript open/create, derive candidates without mutating the project.
   Highlight visible candidates even when the review panel is closed.
2. **Review fillers** opens a panel alongside the editable transcript. Show the
   candidate, surrounding text, source time, output position, decision status,
   and its position in the active queue. A hidden candidate shows its original
   token with **Text removed, audio retained**; never insert it into the editor.
3. Filters: **Unreviewed** (default), **Kept**, **Audio retained**, and **All**.
   Session-skipped items are omitted from Unreviewed until **Review skipped** or
   a new review session. All exposes skipped items with their session status.
4. Previous/Next are explicit. Keep, text removal, and a committed cut pin the
   current card even if it no longer matches the active filter or survives in
   the EDL. Show its resulting state and a next-unreviewed control. Counts refer
   to the current filtered queue; a pinned resolved card is labeled separately
   instead of inventing an index in an empty queue.
5. Keep is a durable project decision. Skip advances as an explicit deferral
   action, changes no project state, and resets when the panel's review session
   ends. Opening the panel, navigation, preview, and highlighting do not dirty
   the project. A changed detection policy or Keep decision does.
6. Text-only removal is one atomic correction plus review decision. Audio and
   duration remain unchanged. Already-hidden candidates cannot be removed from
   text again. They can be kept or cut if otherwise eligible.
7. Cut filler speech removes the candidate text and the exact proposed audio
   interval in one history step. Stay on the card with **Play result** available.
   If some filler edges remain audible, disclose this rather than claiming all
   filler sound was removed.
8. Use normal project Undo/Redo. A panel Undo control, if supplied, invokes the
   same history and is enabled only when the latest project operation belongs
   to that card; never roll back unrelated intervening edits. After unrelated
   edits, invalidate old preview/replay state and explain that it changed.
9. Kept items can be reopened through the Kept/All filters and explicitly reset
   to Unreviewed. Text restoration through the ordinary editor is reconciled
   with the review state rather than retaining a misleading Text removed label.

## Candidate policy and identity

Implement pure detection in `src/lib/fillers.ts` and projection/reconciliation
in `src/lib/fillerReview.ts`; consumers use these instead of importing a token
set from a UI node.

- Initial vocal inventory: `um`, `umm`, `uh`, `uhh`, `ah`, `ahh`, `er`, `err`,
  `erm`, `hm`, `hmm`. Treat bracketed equivalents and surrounding punctuation
  case-insensitively. Preserve original display text. Keep `mm`, `mhm`, and
  ordinary discourse words optional because they can express agreement or
  meaning. Unknown bracketed tokens are not all assumed to be fillers.
- Built-in optional terms include the existing ordinary words/phrases such as
  `like`, `so`, `right`, `okay`, `basically`, `actually`, `you know`, `I mean`,
  `sort of`, and `kind of`. Nothing in this category is enabled by default.
  Allow custom nonempty literal words/phrases; trim/deduplicate them, reject
  regex syntax as an operating mode, and match whole tokens case-insensitively.
- Match phrases within one spoken block and uninterrupted occurrence. Do not
  cross paragraph, source-clip, or existing-cut boundaries. Resolve overlapping
  matches longest-first, with deterministic tie-breaking; one candidate must
  not produce duplicate actions merely because multiple rules matched it.
- Current visible text governs visible candidates. Original recognized words
  supply hidden candidates only where the corresponding current run is empty.
  Do not resurrect an original filler that the user corrected into other visible
  content. If a visible correction merges a filler with neighboring words,
  expose the candidate as grouped and disable its isolated cut. Text-only
  removal may still operate on an exact current substring if normal validation
  permits it; hidden subspans inside a nonempty corrected group are ambiguous
  and are not independently inferred as candidates.
- Identify an occurrence with project/recording occurrence lineage and ordered
  immutable source anchor IDs, plus normalized candidate span/rule information.
  A word ID or timestamp alone is insufficient when media appears twice.
  Display offsets and segment IDs are recalculated, not used as durable identity.
- Preserve lineage through EDL splits; duplicated/reused placements receive new
  lineage. Reconcile decisions atomically on all EDL changes. Retain decisions
  only for unambiguous surviving candidates; changed wording/grouping/rules
  invalidate an incompatible decision. Re-transcription starts fresh decisions
  for the affected material. Snapshot restore restores the captured decisions.
- Proposed persisted shape: optional versioned project `fillerReview` metadata
  containing detection policy and occurrence decision records, plus an optional
  segment occurrence-lineage field where needed. Update TypeScript and Rust
  together. Validate IDs, finite intervals, decision enums, policy limits, and
  references on load/commit; malformed metadata must not drive a cut.
- Keep transient queue cursor, Skip, offsets, context, loop, pinned cards, and
  audition requests outside persisted project history. Default context is 2 s
  before/after, loop off, offsets zero, nudges 10 ms. Detection settings persist.

The first phase must prove lineage and reconciliation through existing split,
delete, restore, import, snapshot, and transcription paths before these fields
become a UI dependency. Avoid matching a stale decision to a new occurrence by
timestamp heuristics.

## Exact cut proposal

Create a pure `buildFillerCutProposal(project, candidate, offsets)` operation,
returning either a validated immutable proposal or an actionable restriction.

- `cutStart = recognizedStart + startOffsetMs / 1000`;
  `cutEnd = recognizedEnd + endOffsetMs / 1000`. Positive start offset retains
  the leading edge; positive end offset removes more trailing gap. Label both
  controls with this meaning, absolute boundaries, and resulting duration.
- Allow shrinking within the filler and expanding into surrounding gaps. Limit
  cuts to the candidate's continuous surviving source span, with start no
  earlier than the previous noncandidate word's end and end no later than the
  next noncandidate word's start. Include text-hidden neighboring anchors in
  this check. Reject nonfinite, inverted, zero-length, overlapping-neighbor, or
  cross-cut ranges. Do not silently clamp a typed invalid value or widen a cut.
- Where recognition timestamps overlap neighbors, explain the restriction and
  require valid adjustment; never assume exact isolated boundaries exist.
- Reject cuts that split a corrected group or cause an invalid retained spoken
  paragraph. A filler-only paragraph may be cut completely, but a shortened cut
  leaving audio with no text is unavailable under the existing nonempty rule.
- Proposed result is a full validated project/EDL built without store mutation.
  Commit that same result against the captured project revision/session. Offset
  changes and project edits invalidate it. Do not run legacy padding again.
- Remove the entire candidate's displayed text while removing only the selected
  audio interval. Preserve neighboring words, timing groups, manual corrections,
  all existing cuts, and untouched occurrences.
- Retained filler edges require explicit representation. Prefer audio-only EDL
  fragments (`words: []`, no transcript overlay), attached to the cut's occurrence
  provenance, while ordinary retained speech keeps its original anchors. Do not
  duplicate one filler anchor onto both sides, fabricate word timing, or lose
  the edge audio on save/export. Such fragments cannot be a loophole allowing a
  filler-only spoken paragraph to become textless. Validate against the original
  spoken paragraph before constructing fragments. Prove playback/export support
  in phase 2; if current consumers assume every segment has words, fix those
  consumers explicitly as part of that phase.
- Record enough provenance for All/Audio retained views to identify residual
  filler edges without reconstructing deleted recognition records heuristically.
  Fully cut items need only a session pinned card; a persistent archive of every
  cut and permanent before/after recordings is outside scope.

## Audition lifecycle

Add a typed transient audition request/controller, integrated into VideoPreview,
rather than swapping the project in the global store. Request fields include
session token, captured project revision, occurrence, timeline, bounded context,
mode, and loop. The selected timeline is one of:

- **Play before:** captured current edit with this candidate still present.
- **Preview cut:** exact proposed result; preview never commits a temporary cut.
- **Play result:** committed timeline centered on the resulting join.

For the current card, retain before/proposal references in session memory for
comparison immediately after commit. Release them on navigation, project switch,
or incompatible edit; they are not serialized into the project.

Context is adjustable independently before/after, initially 2 s each. Bound
context by available edited media and respect existing cuts, repeated placements,
and media transitions. Loop restarts only on an explicit enabled setting; no
navigation or action starts playback automatically. Stop, close, navigation,
boundary edit, undo/redo, project change, re-transcription, load failure, and
unmount stop audition and cancel pending seeks/play promises. Normal transport
or an ordinary seek exits audition cleanly. Do not restore a previously playing
state automatically after exiting audition.

Keep audition position separate from normal output time where the proposed cut
changes duration. Expose an explicit preview indicator and avoid highlighting
the wrong transcript occurrence while previewing an alternate timeline. Reuse
occurrence-aware playback mapping rather than source-time-first lookup.

Preview and commit share exact EDL boundaries. WebView seek/frame behavior can
still affect audible joins: native A/B checks must compare preview, committed
playback, and exported media rather than treating mocked tests as proof of audio
quality. If these disagree materially, fix the audition path before release.

## Implementation phases and completion gates

Each phase should be a reviewable commit or PR. No implementation phase is
authorized by this planning document alone; implement when the user requests it.

### Phase 1 — policy, candidate identity, and persistence foundation

Implement pure token/phrase matching, current/hidden projection, occurrence
lineage, versioned metadata, and reconciliation. Wire metadata through Rust
serialization and every existing transform that changes occurrence identity.
Do not build a panel yet.

Gate: fixtures prove `[AH]`, `[UM]`, `[UH]`, casing/punctuation, optional words,
custom phrases, overlap resolution, hidden text, corrected wording, merged groups,
repeated clips, splits, and retranscription invalidation. Detection leaves dirty
state/history unchanged. Legacy projects load; new metadata survives native
save/reopen and snapshot serialization. Pin the exact schema in this document.

### Phase 2 — precise cut engine and atomic decisions

Implement proposal validation, explicit retained ranges/edges, review actions,
and atomic project commits. Reuse existing text correction validation for
Remove text only. Persist Keep and text-only resolution; reconcile external
edits and restored text. Add only the precise cut primitive needed here, leaving
ordinary Cut speech behavior intact.

Gate: zero offsets remove the recognized interval, both offset directions work,
neighbors never move or disappear, hidden candidates can be cut, retained edge
audio survives exports, and only the chosen occurrence changes. One undo/redo
restores/reapplies EDL, text, metadata, and decisions together. Invalid/stale
operations commit nothing. Nonempty/group restrictions hold after every split.

### Phase 3 — bounded before/preview/result playback

Implement alternate-timeline audition, context controls, looping, stop/cancel,
join-centered result playback, and transient before references. Integrate media
switching and asynchronous playback guards with VideoPreview.

Gate: VideoPreview integration tests cover project unchanged during preview,
proposal/commit boundary equality, context at start/end, loops, repeated media,
multi-media transitions, explicit-only playback, and cancellation on all lifecycle
events. Perform an early native spike on `[AH]`/`[UM]` recordings to verify that
the approach lets a listener judge joins. Resolve playback fidelity issues here.

### Phase 4 — transcript highlighting and review panel

Add candidate decorations in the active projected editor and the adjacent review
panel. Wire filters, pinned result cards, Previous/Next, Skip, reset-to-unreviewed,
action eligibility explanations, context/loop controls, offsets/nudges, and
before/preview/result actions. Preserve editor caret/composition and normal
transport shortcuts; panel keyboard handling must respect focused inputs.

Gate: UI tests demonstrate separate occurrences, no auto-advance or autoplay,
post-cut replay, undo, kept/skipped behavior, audio-retained discovery, custom
phrase controls, grouped/nonempty restrictions, stale card invalidation, and no
project mutation from opening/highlighting/filtering/listening. On narrow
windows keep the panel usable without hiding the current transcript context.

### Phase 5 — unify entry points and regression coverage

Replace filler bulk actions in Toolbox, transcript toolbar, and FindReplacePanel
with Review fillers entry points as appropriate; preserve ordinary find/replace
and explicit manual speech cuts. Remove duplicated filler sets and consume shared
candidate projections in waveform/status counts. Count occurrences, including
multiword phrases once; distinguish visible highlighting from hidden audio
candidates. Keep WordNode compatibility only where still used.

Gate: no remaining user-facing filler bulk deletion, conflicting matching lists,
or ordinary-word default candidates. Editor, waveform, status, and review agree
on candidate identity/policy. Existing manual correction, captions, playback,
re-transcription, and project-save tests remain green.

### Phase 6 — acceptance, documentation, and release evidence

Add `docs/manual-filler-review.md` and an acceptance evidence record. Update user
documentation and feature status only as phases pass. Prepare realistic fixtures
with bracketed vocal fillers, content uses of “like,” adjacent words/breaths,
text-hidden fillers, filler-only paragraphs, corrected groups, repeated clips,
existing cuts, and multi-media transitions.

Run `npm run check`, `npm test`, `npm run test:rust`, and `npm run build` for the
completed implementation. Run sidecar tests only if that implementation changes
the sidecar or its interface. Use native save/reopen, snapshot, SRT/VTT, and short
rendered-media checks to verify serialization and actual audio timing.

Native acceptance must verify: explicit playback only; adjustable context/loop;
before/preview/result comparison; 10 ms nudges in both directions; commit matching
the preview; stay on item and undo; kept state after reopen; session Skip reset;
hidden audio revisiting; restrictions with clear explanations; stale requests
after external edits; repeated-occurrence isolation; source media unchanged.
Record automated evidence separately from native checks that remain unperformed.

## Risks and exit criteria

The main risks are retained-edge representation, occurrence lineage through all
existing EDL operations, and native audition fidelity. Phases 1–3 address these
before the full panel. Do not mark the feature complete based only on matching
and UI tests.

The feature is complete when the confirmed requirements pass automated and native
acceptance, saved review state survives the frontend/Rust round trip, previews
leave project/history unchanged, and every committed text/cut decision is safely
undoable without affecting another occurrence. Script assistance can follow and
reuse suitable review/playback infrastructure without depending on filler policy.


## Phase 1 implementation record (2026-10-29)

The initial foundation checkpoint was followed by cut, playback, and UI
implementation in the same working tree. The following records the foundation
schema. No live app testing was performed, as requested.

### Version 1 schema

The outer project remains version 1. Both additions are optional and omitted in
legacy projects:

```ts
Segment.occurrenceLineage?: string;
Project.fillerReview?: {
  version: 1;
  policy: { optional: string[]; custom: string[] };
  decisions: Array<{
    candidateId: string;
    fingerprint: string;
    mediaId: string;
    occurrenceLineage: string;
    anchorIds: string[];
    outcome: "kept" | "text-removed";
  }>;
};
```

Vocal rules are always enabled. Policy arrays contain normalized, sorted,
deduplicated literal phrases; at most 100 entries per array, 200 UTF-16 code
units and 20 tokens per input term. Optional entries must belong to the built-in
inventory. Matching uses Unicode letter/number tokens with internal apostrophes
and hyphens, case-insensitively; punctuation may surround tokens but phrases do
not bridge sentence punctuation. Regex operating modes are unavailable.

`candidateId` is an opaque JSON tuple of project ID, media ID, lineage, ordered
anchor IDs, normalized rule, and token offset within the first timing run.
`fingerprint` additionally captures visibility, current/original run spelling,
and timing-group anchor partitions. Neither includes segment IDs, block IDs,
or display/output positions. Consumers must not construct these strings.
Hidden candidates use original anchors only within entirely empty current runs;
hidden merged groups remain marked grouped. Visible and hidden regions interrupt
each other's phrase matches.

Lineage defaults to the preexisting transcript occurrence ID, then to
`transcript:${segment.id}`. Splits materialize and preserve that lineage while
keeping transcript overlay occurrence IDs unique per segment. Shared lineage
requires a single media source and disjoint word IDs. Padding can overlap source
intervals between fragments; that alone is not a duplicate placement. Imported
placements get distinct segment-derived lineage. Re-transcription assigns fresh
UUID lineage even if a provider reuses recognition IDs/timings. Future duplicate
placement operations must assign a fresh lineage and overlay occurrence ID;
copying existing lineage plus anchors is rejected.

Review metadata is part of normal project history and native snapshots.
Incompatible decisions are pruned within text-edit/cut/silence/re-transcription
transactions, and restored snapshots retain captured compatible decisions.
Restoring text invalidates a `text-removed` decision. `withFillerPolicy` returns a
pure project transformation for the existing revision-checked commit API; UI settings and atomic decisions were added in the subsequent implementation.

Frontend load/commit validation checks candidate identity and exact fingerprints.
Rust validates metadata shape, limits, enums, lineage, finite explicit occurrence
intervals, and contiguous anchor references before save/load/snapshot operations.
It preserves the opaque identity/fingerprint strings, leaving wording projection
to the frontend. Future cut proposals must validate the current project and
candidate against the captured revision; a serialized decision is never a cut
instruction. Retained audio provenance was added in phase 2 as described below.


## Hands-on checkpoint (2026-10-29)

Phases 2–5 are implemented. The next gate is trying the feature in the native
app, using [the hands-on checklist](../manual-filler-review.md), rather than
asking the user to run automated suites. Live/native checks are unperformed at
the user's instruction; this is a trial checkpoint, not a release-complete claim.

### Actions, boundaries, and retained edges

`src/lib/fillerActions.ts` provides current-candidate validation, idempotent Keep,
reset, text-only removal, and immutable cut proposals. A proposal includes the
original revision, full result project, exact source interval, join output time,
and retained-edge disclosure. The panel commits that same result object through
the existing revision-checked store. Text/cut decisions occupy one history step.

The segment schema adds optional `precise: boolean` and `fillerAudio`:

```ts
fillerAudio?: {
  candidateId: string;
  rule: string;
  text: string;
  originals: Word[];
};
```

Only wordless, overlay-free, precise segments with explicit occurrence lineage
may carry this provenance. Recognition anchors remain immutable in provenance;
no filler anchor is duplicated onto both ordinary speech fragments. Fragment
source ranges must stay within that recognition interval. Duplicate overlapping
edge placements and provenance belonging to another occurrence are rejected.
All/Audio retained project one residual candidate from its edge fragments.
Existing-cut boundaries prevent another isolated review cut on that residual;
manual output-range cuts can explicitly trim wordless edge fragments.

The original spoken paragraph is validated before constructing fragments;
retaining filler edges cannot turn a filler-only paragraph into audio without
text. Grouped corrections, neighbors (including text-hidden words), inverted or
nonfinite bounds, and existing edit boundaries are guarded without clamping.

The first filler review cut marks surviving timeline segments precise, preserving
their existing ranges while disabling the exporter's second pre-roll padding
pass. Normal Cut speech still applies its existing EDL padding. Export combines
adjacent precise ranges for encoding so tiny edge fragments do not create extra
video seams. Precise timelines use full re-encode, avoiding stream-copy GOP/audio
rounding. Both actual export and headless checks use the same trim/concat graph
builder. Further manual splits preserve precise boundaries, and subsequently imported
clips inherit precise export mode; re-transcription
clears obsolete edge provenance and refreshes lineage.

### Audition and panel

`fillerAuditionStore.ts` owns a transient typed request captured against the
current project/session. `FillerAudition.tsx`, inside VideoPreview, owns a separate
media element and bounded output clock for the captured alternate timeline.
Normal player position and transcript playback highlighting are kept separate.
Contiguous fragments play through; actual cuts/repeated placements/media changes
use occurrence-aware seeking. Stop, navigation, offsets/context/Loop changes,
close, normal transport/seek, project changes, processing, and unmount cancel
playback and pending requests. Loading/seeking and play promises are guarded.
Audio-only playback uses the frame clock's rAF fallback.

The adjacent panel has all four filters, pinned cards, explicit navigation,
session Skip/reset, persistent settings, eligibility explanations, offsets and
10 ms nudges, context/Loop, before/preview/result, and a guarded decision Undo.
Opening/highlighting/filtering/listening make no project edits. A project change
clears old comparisons and does not allow the local Undo button to roll back an
unrelated edit. A filler-only full cut keeps the result card visible even when
no transcript words remain. Narrow layouts retain a transcript area above the
scrolling panel.

Toolbox, transcript toolbar, and Search now enter review instead of filler bulk
cuts. WordNode compatibility, editor decorations, waveform, and status use the
shared policy/projection. Ordinary find/replace and manual speech cuts remain.

### Evidence

Final automated checks passed:

- `npm run check`: TypeScript and ESLint.
- `npm test`: 222 tests across 21 files.
- `npm run test:rust`: 55 tests, including native filesystem/snapshot round trips
  and actual headless FFmpeg rendering with the locally available FFmpeg.
- `npm run build`: production bundle completed; Vite retains its bundle-size
  advisory.
- `git diff --check`: passed.

Coverage includes exact
proposals, offset directions, neighbors and hidden speech, repeated occurrences,
nonempty/group restrictions, atomic undo/redo, immutable previews, queue behavior,
settings, cancellation, bounded context/Loop, media transitions, native save/reopen
and snapshots, and a headless FFmpeg render through the production graph.

The headless fixture renders video+audio and audio-only paths from a source-time
ramp: it verifies 230,400 samples
(4.8 s at 48 kHz) and sample values from both retained filler edges. It exercises
filter rendering without opening the app or playing audio. Native WebView seek
behavior and the actual before/preview/result/export listening comparison remain
human acceptance gates. Sidecar interfaces are unchanged.


## Native review follow-up: continuous auditions and true duration reduction

The user reported an unchanged-looking duration and an apparent silence during
in-app playback/preview, and requested playback controls above collapsed boundary
controls. Those UI changes are implemented, with exact before/after duration
readouts and millisecond total-time displays.

The initial source-seeking audition player has been replaced. Native
`prepare_filler_audition` renders only the bounded passage through the production
edit filter builder, then the review player loads that single clip. Its internal
cut joins do not seek or switch source files. Each coalesced retained range uses
a fast-seeked input, including repeated placements and media transitions, so a
short audition near the end of a long recording does not decode the whole file.
Mixed audio/video passages get a blank picture for audio-only ranges. Review
clips use 640×360 H.264 video when applicable and 192 kbps AAC audio; media files
are transient app-cache artifacts, released on Stop/navigation/invalidation.
Preparation has a visible state. Native cancellation kills an active FFmpeg child
and removes its output; cancellation arriving before prepare is guarded. Frontend
request identity guards prevent a stale completed render or play promise from
starting after Stop, edits, or unmount. Rendering changes no project/history.

A separate, reproduced export defect was fixed in the shared filter builder:
combined A/V concat padded audio to each rounded video segment duration. On a
30 fps synthetic source, four 20 ms cuts produced 5.0043958 s rather than 4.920 s,
including 4,051 inserted silent samples. Audio now concatenates independently on
a sample-count clock; retained video frames are placed on absolute edited output
timestamps and interleaved. VFR encoding preserves those cut timestamps instead
of restoring source CFR spacing. This avoids accumulating rounded frame durations
and silence at each cut. Source ranges and the cut engine already removed the
selected interval; they were not replaced with silence in the EDL.

Validation: TypeScript/ESLint, production build, 223 frontend tests, and 57 Rust
tests pass. Headless 30/29.97 fps renders verify exact 4.920 s audio, no silent
samples, and video duration within one frame. Frontend tests cover one prepared
clip across joins, immutable project/playhead, loops, render failures, cancellation
while preparing or playing, media/repeated placement input, and the collapsed UI.
No app was launched, operated, or listened to by the agent. Native listening
checks remain pending with the user.


## Before/Preview isolation follow-up

The user reported hearing the filler in both Before and Preview/committed
playback. Automated event-order reproduction exposed an independent source-player
race: a delayed native source `play` event set the shared playing state, which
could start the original video again during an audition. Source playback, queued
play promises, native events and frame-clock updates are now guarded while an
audition is active; the original display is also hidden. Explicit normal transport
still exits audition before starting the source player.

Each new audition now mounts a fresh keyed media element. The frame clock accepts
a media identity and rebinds when that identity changes even if its enabled flag
stays true. This prevents stale Before callbacks/promises or old media clocks
from acting on the new Preview/Result element. Regression tests failed before
these guards and isolation changes, then passed afterward.

The native render command's input/filter planning was extracted unchanged into a
pure render-plan function used by a new headless content test. A compressed,
long-GOP source has an 1800 Hz marker only during the synthetic filler interval.
The production audition plan's Before clip contains that marker and 206,400
samples (4.300 s); its cut Preview contains 192,000 samples (4.000 s) and removes
the marker. This checks real source selection and fast seeking, rather than only
checking duration or mocked media URLs. The frontend workflow test also verifies
that Before and Preview receive different EDLs and commit uses the preview EDL.

The user confirmed Undo permits boundary adjustment and requested no controls
changes. No controls behavior or explanatory text was added for that report.

Validation: 226 frontend tests, 58 Rust tests, TypeScript/ESLint, production build,
and `git diff --check` pass. The agent did not operate or listen to the live app.


## Very short recognition spans

The user's screenshot established a 20 ms default cut with both offsets at zero.
The bridge passes CrisperWhisper's nonzero start/end timestamps through unchanged;
only exactly zero-length spans receive the existing 1 ms uncertain placeholder.
The cut engine uses those raw intervals, so a correctly rendered 20 ms removal
can leave most of an actual filler audible. Prior player-race corrections did not
validate the recognizer's alignment against that particular spoken filler.

Proposals now expose recognized start/end, neighboring-word boundary limits,
and an advisory warning when the recognized span is at most 40 ms. The threshold
is an engineering warning, not a linguistic classifier, required minimum cut, or
auto-expansion rule. Zero-confidence recognition also receives an uncertainty
advisory. The panel shows these details and tells the user how to expand earlier
with negative Start offsets or later with positive End offsets. Warnings survive
explicit adjustments because the underlying recognition estimate remains short.
Raw recognition anchors, default zero offsets, neighbor protection and project
serialization are unchanged. No speech span is guessed or silently widened.

A 20 ms regression proves the default result shortens by precisely 20 ms; explicit
−100 ms/+180 ms adjustments produce a 300 ms cut, preserve neighboring anchors,
and commit the same project previewed. Overlapping a neighbor still fails without
mutation. Automated checks pass: 228 frontend tests, TypeScript/ESLint, production
build and diff whitespace checks; the unchanged native suite last passed 58 tests.
No live app interaction/listening was performed. Source-specific timing calibration
still requires the occurrence source time and a listening comparison.


## Audio-informed estimates bounded by neighboring tokens

The user requested the boundary calculation inside the app and asked that it use
the tokens before and after the occurrence. A new local native command,
`estimate_filler_boundaries`, derives the preceding anchors' maximum end and
following anchors' minimum start within the exact segment occurrence. Text-hidden
words count, and segment in/out bounds constrain the envelope. It reads only a
bounded audio window (up to one second around recognition, clipped to that
envelope, with a ten-second hard cap), producing numeric estimates without
transcription/model downloads, original-media changes, or project writes.

The initial conservative estimator uses 10 ms demeaned RMS windows at 5 ms hops,
a local noise/signal contrast check, and short-dip bridging. It selects activity
intersecting the recognized span (or a single unambiguous burst within 40 ms),
not unrelated activity elsewhere in the neighboring gap. It adds 20 ms edge
padding subject to word/edit limits and up to 10 ms neighbor margins. A burst
continuing into a neighbor limit is disclosed; insufficient contrast, distant or
ambiguous bursts, and search-window truncation return an uncertain result rather
than a guessed range. This is an acoustic heuristic, not word classification or
forced phonetic alignment. All returned offsets pass the existing precise-cut
validator before being applied to a draft.

Very short (≤40 ms) or zero-confidence recognition automatically triggers this
read-only estimation when selected. Other eligible occurrences offer **Estimate
from audio**. The UI retains offsets relative to immutable recognition anchors;
**Use recognized timing** explicitly restores zero. Estimation does not dirty the
project, and pending estimates block audition/cut until resolved or overridden.
Manual boundary changes, Stop, navigation, project/session changes and unmount
invalidate callbacks. Native reads are bounded and time out after 20 seconds;
stale work can finish locally but cannot play audio or apply results afterward.

Before playback is now centered on the actual proposed interval, rather than
only the original text-alignment span. Thus Before/Preview contain matching
surrounding material and their duration difference equals the selected removal,
even when an estimate expands a 20 ms recognition interval to a longer cut.

Validation: 233 frontend tests, 61 Rust tests, TypeScript/ESLint, production build
and diff whitespace checks pass. Coverage includes token/cut bounds, a short
attention span expanded to its nearby burst while ignoring a preceding burst,
noise-only/continuous/ambiguous audio fallbacks, no project/history mutation,
manual overrides and stale-session/Stop cancellation, neighbor rejection, and
preview/commit identity. The user's local short window informed offline analysis;
no personal media or project path was added to test fixtures and no app was
operated or listened to by the agent. Native listening acceptance remains pending.


## Compact timing presentation

Per user review, the short-span warning and permanently visible timing diagnostics
were removed from the panel. A round information icon beside the compact removed-
duration readout opens recognition/source timing, neighboring-word limits, and
estimation details on demand. Escape closes it. Successful estimation adds no
persistent status paragraph; pending/error states remain actionable. Boundary
controls have short labels and compact estimation/original-timing actions. Cut
ranges, estimation, validation and commit behavior are unchanged.

TypeScript/ESLint, all 233 frontend tests, production build and diff checks pass.
Existing UI checks were updated for the collapsed information control and warning
removal. Native code is unchanged; its last 61-test run remains green. No live
app testing was performed.
