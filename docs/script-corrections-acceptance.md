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

Workflow revision `4.8.0-dev.3` adds native-menu command/history tests, optional script
opening, text-only suggestion generation without native calls, and inline review
for both scripts and fillers. Tests cover exact preview/commit reuse, restored
Undo → Keep actionability, transcript scroll, caption invariants, stale estimate
rejection and preservation of independently recognized evidence. These supersede
the prior panel/refresh interactions. Native shortcut/focus behavior, perceived
latency and audible joins still require the updated human walkthrough. Text-only
proposals do not count as evaluated automatic corrections for SC-04/05/14/16.

Native review uncovered filler misclassification, unclear no-replacement cards,
missing decimal/status notation and unsuitable legacy cut padding. Development
`4.8.0-dev.5` adds regressions for those cases, custom user replacements, an 80 ms
word cut with its following text/captions preserved, adjustable off-script buffers
and hidden-neighbor rejection. These checks supplement SC-05/08/09/11/12; they do
not establish audible joins or automatic acoustic eligibility. Re-run Find
differences in the updated build before the focused human checks.

Workflow `4.8.0-dev.6` adds combined script/filler advancement, context-preserving
explicit review edits, durable decision-log TS/Rust fixtures and save/snapshot
round trips, guarded revisit/revert, filler cut logging and latest Undo, plus the
hyphenated restart regression. Cut history entries record actual buffered source
spans. Native navigation/focus and audible joins still require the current script.
Automatic acoustic requirements remain unaccepted.

Regression checkpoint `4.8.0-dev.7` covers filler cuts preserving an independent
name proposal in the same paragraph (also confirmed on the reported body example),
filler hiding/custom text and off-script cuts preserving surviving proposals,
removed-target invalidation, automatic once-per-visit estimation, stale navigation
results and manual timing overrides. Automated estimates remain proposals; audible
joins and native interaction require the current focused walkthrough.
