# Phase 1 design: occurrence-scoped transcript metadata

Initially implemented by the Phase 1 correction-model branch. Phases 2–4 now
connect the editor, captions, and cut operations; their transaction layer is
`src/lib/transcriptEdits.ts`. This document retains the original model design.

## Storage contract

Project format remains version 1. Each segment may have an optional `transcript`
overlay with its own version (currently 1):

```ts
{
  version: 1,
  occurrenceId: "occurrence-1",
  originals: [/* original Word objects for surviving source anchors */],
  blocks: [{
    id: "block-1",
    runs: [
      { id: "r1", text: "idempotency", separatorBefore: "", anchorIds: ["w0", "w1"] },
      { id: "r2", text: "are not", separatorBefore: " ", anchorIds: ["w2"] },
      { id: "r3", text: "the", separatorBefore: " ", anchorIds: ["w3"] },
      { id: "r4", text: "", separatorBefore: " ", anchorIds: ["w4"] },
      { id: "r5", text: "serveur.", separatorBefore: " ", anchorIds: ["w5"] }
    ]
  }]
}
```

The shared executable example is
[`tests/fixtures/transcript-corrections.json`](../../tests/fixtures/transcript-corrections.json).
Its originals are “item potency aren’t the old server.”; another segment repeats
that media without the overlay. Both occurrences play the same three seconds,
but the first projection displays “idempotency are not the serveur.”. The hidden
“old” run retains its original text and audio bounds, with an empty display range.

`segment.words` remains the audio-anchor list for the existing EDL. Originals
are a recognition baseline, not a second writable corrected transcript. Runs
are the only corrected-text representation. Baseline word text is not required
to equal run text. Original IDs and timestamps must agree with the surviving
segment anchors, including anchors partially clipped at segment edges.

Mappings partition those anchors exactly once in order. IDs for blocks and
runs are unique within an occurrence; occurrence IDs are unique in a project.
References are resolved within a segment occurrence, never globally by source
word ID. Thus repeated media/word IDs in distinct segments do not alias edits.

## Normalization and projection

`normalizeTranscript(segment)` derives paragraphs from the legacy 750ms-gap
and sentence-ending rules, with a hard boundary between segments. IDs are
deterministic from the segment ID and original index. Existing metadata is
retained unchanged, so correcting punctuation cannot regenerate paragraph IDs.

`normalizeProjectTranscripts(project)` explicitly materializes overlays in a
new in-memory project without changing source ranges, word lists, timestamps,
or updatedAt. It returns the same project when already normalized. It never
writes to the store, filesystem, dirty flag, or recognition cache.

`projectTranscript(project)` uses that normalization locally and walks output
segment order. Each block contains visible text and mapped runs with UTF-16
half-open text offsets, original text, anchor IDs, clamped source bounds, and
output bounds. Empty runs remain in the projection but emit no separator. A
merged phrase receives a single timing interval; split display words do not
acquire fabricated per-word timing. Offsets exclude `separatorBefore`; spacing
appears in block text only between visible runs.

Normalization is deliberately not installed into every live project load yet.
Existing cuts/recognition operations do not maintain overlays until Phase 2.
Attaching metadata globally before that work would make an ordinary cut leave
stale anchor references. Load validates optional persisted overlays without
normalizing legacy input or dirtying it. Phase 2 must integrate materialization
at the correction transaction boundary and reconcile every affected cut path.

## Persistence and validation

Rust mirrors all overlay types with explicit camelCase fields, optional serde
defaults on the segment, and rejection of unknown overlay fields. Both native
project save/load and gzip snapshot create/restore validate project/metadata
versions, IDs, media references, finite/ranged timing and confidence, anchor
coverage/order, run spacing, and nonempty spoken blocks. Invalid writes fail
before directories or snapshots are created; invalid loads do not replace the
current project. TS validates before projecting or replacing a loaded project.

The outer project version and overlay version must both equal 1. Unknown future
versions are rejected, not treated as legacy or silently stripped. Old binaries
can load a version-1 project but may silently drop overlay fields when saving;
this is **not backward write compatibility**. Keep original files/snapshots and
use the updated app when working with corrected projects.

## Cuts and restoration: Phase 2 contracts

Each segment overlay describes exactly its surviving word anchors. After a
cut, Phase 2 must split/reconcile blocks and groups with the new surviving
segments, preserving original text and occurrence lineage without duplicating
occurrence IDs. Fresh independent copies need fresh occurrence IDs. Stable
block/run IDs should survive unaffected operations.

For example, cutting the complete `r1` group removes w0/w1 from the surviving
EDL and overlay together. A later Restore original operation may expose w4
(“old”), but must not restore the cut w0/w1 or widen source ranges. Cutting
half of r1 must be rejected. Phase 2 implements these contracts in the pure
edit/cut layer and EDL reconciliation. Original-text UI follows in Phase 5.

## Recognition-cache boundary

Only direct successful transcription results may seed the media-hash cache.
Opening any project no longer writes to it, since a legacy project's text may
already contain manual edits and partial/reordered segments. Cache namespace
`yusafcut.recognition.v2.*` ignores v1 entries whose provenance cannot be trusted.
There is no cache migration that guesses originals from saved display text.
Originals in a legacy project mean “available loaded baseline”, not a claim to
recover previous recognition output.

## Validation evidence

TypeScript tests exercise projection, normalization identity, occurrence isolation,
pre-existing cuts, paragraphs, Unicode offsets, hidden text, and invalid mappings.
The exact same fixture is read by Rust tests to verify serialization, native
save/load, and gzip snapshots, including rejection of invalid external content.
Tests for editing operations, editor integration, and later cut reconciliation
belong to their respective phases and are not claimed complete here.
