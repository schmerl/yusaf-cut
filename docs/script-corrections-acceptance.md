# Script correction acceptance audit

Status: development checkpoint, **not release acceptance**. Automatic wording
application and held-out evaluation remain incomplete. The
[native walkthrough](script-corrections-checkpoint.md) awaits human review.

| Criterion | Evidence and remaining work |
|---|---|
| SC-01 | Parser/import UI tests: Markdown rules, UTF-16/CRLF offsets, localized cue/comment/fence warnings, invalid UTF-8/import preservation. Native import walkthrough pending. |
| SC-02 | Shared TS/Rust serialized fixture and native save/load/snapshot round trips; malformed/future schema rejection and legacy loading. Actual app reopen pending. |
| SC-03 | Pure matching and native window tests: exact scope, full-script location, neighboring surviving context, ambiguity, reused occurrences, partial-group abstention. Native selected run pending. |
| SC-04 | Pending wording/notation review and evidence implemented; development examples inspected. **Real automatic eligibility/application not enabled or accepted.** |
| SC-05 | Exact spoken method/path/digit matching with different-value rejection and pending written-form proposals. Automatic notation gate and native acceptance pending. |
| SC-06 | Protected-word exclusion, category checks, atomic batch, one Undo and unchanged timing groups tested. Native bulk action pending. |
| SC-07 | Provenance for typing/paste/replace/restoration/hiding/review; conservative legacy protection without protecting all normalized overlays. Native walkthrough pending. |
| SC-08 | No skipped-line insertion; local aliases retain neighboring asides/fillers; repeated-word ambiguity abstains. No audio cuts during analysis. Full matching quality remains unestablished. |
| SC-09 | Store/editor tests cover Keep/Revert, Accept/Dismiss, stale rejection, decision protection, deduplication and captions. Applied automatic records are synthetic until a real automatic policy is enabled. |
| SC-10 | Replacement preserves accepted/applied text and old evidence, archives pending/off-script items and undoes atomically without starting analysis. Native replace/reopen pending. |
| SC-11 | Immutable shared preview/commit, actual cut bounds, stale/partial-group rejection, occurrence isolation and per-cut Undo tested. Audible native joins unverified. |
| SC-12 | Tests retain words/ranges/duration and caption projection for text-only edits. Original source hashes still match. Full native export-plan audit pending. |
| SC-13 | Controlled cancellation, late progress/results, edit + Undo, same-ID session switch, script replacement, capability/second-window failure, invalid evidence and composition tests. Native cancellation pending. |
| SC-14 | Staged records commit once; review, bulk, cut and replacement actions have separate Undo. **Real automatic-correction batch remains to implement/evaluate.** |
| SC-15 | Lifecycle hooks cover store and pure text/EDL writers, filler actions, successful re-transcription and baseline/snapshot recovery. Native combinations pending. |
| SC-16 | Twelve human labels validated, six development labels inspected; installed recognizers and experimental direct comparison assessed. **No frozen automatic policy or completed held-out precision/recall/error gate.** |

The experimental C++ scorer's source is included under `scripts/`; its executable
and diagnostics stay in ignored/private output. It is not the production audio
provider. In-app analysis uses the existing local Whisper binary
without a script prompt and retains bounded evidence with model hash/provider
identity. Independent recognition is review evidence; it alone never authorizes
an automatic edit.
