# Acoustic feasibility design and evidence

Status: initial Phase 0 experiment; **no production automatic decision rule**.
See [human review checkpoint](../script-corrections-checkpoint.md).

## Local capabilities inspected

The installed whisper.cpp CLI exposes unprompted recognition, `--prompt`, full
token JSON, decoder scores, grammar constraints and word/DTW timing. It does not
expose a calibrated likelihood comparison between arbitrary competing wordings.
The current Tauri transcription IPC takes engine/model/language, not bounded
audio alternatives. Its result is recognition words, not independent evidence
that a script-proposed replacement was actually spoken.

The installed CrisperWhisper bridge calls `CrisperWhisperModel.transcribe` in
verbatim mode with word timestamps. Its public app interface returns word text
and times, not contrastive scores. No additional Python/model stack has been
installed for this feature. Existing model confidence fields are insufficient.

## Initial experiment

Study policy: `script-acoustic-study-v1`. Before decoding, the private config
assigned six development and six held-out excerpts across the supplied pairs.
Each source-bounded clip is at most 30 seconds, comes from one surviving
occurrence, and includes context. Existing cuts cannot be concatenated away.
Source media, project JSON and script hashes are verified before/after work.

Three development excerpts were decoded with local `ggml-large-v3-turbo.bin`:
unprompted, matching script prompt, and deliberately wrong-prompt control.
The model and executable SHA-256 identities, macOS/arm64 identity, full JSON,
logs and wall times are recorded privately in the completed run manifest.

Observed before any listening labels:

- One technical-term error persisted in unprompted recognition but became the
  scripted term when prompted. This cannot establish that the correction is
  acoustically supported; the prompt itself changed the result.
- One technical-word example and one spoken-path example retained the same
  substantive content across the three conditions. Formatting changed between
  conditions. These are promising candidates for further evaluation, not labels.
- No human listening ground truth, automatic precision, false-change rate or
  recall is available yet. Nine successful decoder invocations are **not** nine
  independently verified corrections. Held-out excerpts have not been decoded.

First model load/decode took about 10.1 seconds; subsequent decodes took about
2.3 seconds each. Total decoder wall time was about 28.6 seconds, excluding
hashing/extraction. A first sandboxed invocation failed allocating Metal memory
and was recorded separately as failed. A retry outside the restricted sandbox
completed locally. This does not establish native IPC or cancellation support.
Peak memory was not captured for this first run; the tool now records the child
process high-water mark for subsequent runs (bytes on macOS, converted on Linux).
Hardware marketing model and a production memory/runtime envelope remain open.

## Evidence approach to investigate

Start with an independent unprompted audio baseline, script/current alternatives,
and an explicit other/uncertain outcome. Test contextual and model stability,
competing acoustic evidence and script-induced errors on labeled development
clips. Grammar/forced alignment may help localize a candidate but cannot alone
confirm that its words were spoken. Agreement between recognizers or scalar
confidence likewise cannot alone authorize replacement.

If the installed interfaces cannot provide sufficiently discriminative evidence,
revise the provider/interface and evaluate it explicitly. Do not disguise the
limitation as high confidence, and do not call a review-only prototype the
completed automatic feature. No provider or additional model setup is selected
at this checkpoint; listening labels are needed to assess candidate approaches.

## Release criterion declared before held-out measurement

The following is a **release gate**, not a claim of measured model accuracy:

- At least 99% observed precision among proposed automatic lexical/notation
  changes and **zero false automatic wording changes** in held-out evaluation.
  Both conditions must hold. Report the count, sample size and uncertainty;
  small samples do not establish general 99% accuracy.
- At least 100 independently labeled eligible correction opportunities across
  real audio and separately identified adversarial controls before the feature
  is declared ready. If the supplied material yields fewer opportunities,
  report insufficient evidence rather than inflating the sample with repeated
  decodes of the same passage. Ask for more evaluation material as needed.
- Mandatory examples include multiword technical errors, names, equivalent
  notation and changed spoken methods/identifiers/values. Also challenge skipped
  script lines, intentional substitutions/asides, fillers/restarts, repeated
  passages, existing manual edits/hidden text, reused occurrences, and cuts.
  Every no-overwrite case must produce zero automatic changes to protected or
  contradictory content. Parser/manual/timeline invariants also require tests;
  acoustic success cannot waive those requirements.
- Demonstrate at least one correctly supported automatic correction for each
  required positive category; complete abstention does not pass. Report missed
  corrections and abstention alongside precision, not only successful examples.
- Freeze provider/model/policy identities and thresholds **before** held-out
  scoring. If the rule changes after seeing held-out outcomes, reserve fresh
  held-out material. Keep failed examples in the private audit.
- Report matching/off-script errors, native runtime/peak memory/hardware and
  provider identity. Native review is distinct evidence from pure/mock tests.

The initial twelve excerpts are a feasibility seed, not the complete release
evaluation set. They may contain multiple opportunities, but their count alone
cannot satisfy the declared sample requirement.

## Integration inventory for subsequent phases

| Surface | Writers/transactions and required hook |
|---|---|
| Typing, paste, replacement | `applyTranscriptDocument`, `editBlockText`, `replaceTranscriptText`/`Batch`; assign explicit provenance while retaining hidden anchors and complete timing groups |
| Restoration | `restoreTranscriptRange`/`Block`; mark a manual decision even when restoring the baseline; do not implement automatic Revert with Restore original |
| Paragraph transforms | `splitTranscriptBlock`, `joinTranscriptBlocks`; preserve authorship and reconcile durable anchor-based review identities |
| Filler review | `removeFillerText`, `setFillerDecision`, `buildFillerCutProposal`; preserve manual hidden text and do not use filler-token policy for off-script cuts |
| Timeline | `deleteWords`, `splitSegmentAtWord`, `removeSilences`, `cutTranscriptRanges`, `cutOutputSpeech`, `reconcileTranscript`; map surviving occurrence lineage and disable ambiguous review actions |
| Store/history | `commitTranscript` groups typing, validates project identity and records history; script import/replacement/run commits/review actions need their own atomic steps |
| Other store writers | deletion by source/time/text, chapter/music changes, `setProject`; review metadata needs the same transaction, including direct setters that bypass `commitTranscript` |
| Re-transcription | `captureTranscription`/`runTranscription` use session/revision guards and replace the baseline on full success; invalidate affected active results only after success, never reuse this path for reconciliation |
| Project switches | `openProject`, `replaceProjectBaseline`, `projectSession`, snapshot recovery; late results/progress must be ignored even when a new project has similar IDs |
| Persistence | `saveProjectRevision`, autosave, native `project.rs`/`snapshots.rs`, TS/Rust transcript validators; script/review version validation must run on all load/save/snapshot paths |
| Captions/export/cache | `projectTranscript` drives captions; recognition caches contain raw words only; script evidence requires separate storage/identity |

Untouched normalized overlays are not manual provenance. Legacy protection must
compare individual runs/groups with their available originals, including empty
hidden runs and ambiguous merged groups. Explicit restoration and later user
acceptance need provenance even if resulting text equals the baseline. None of
these provenance hooks has been implemented at this checkpoint.

## Development labels and follow-up experiment

The user supplied all twelve listening labels; validation passed. Only the six
development labels have been inspected. The labels demonstrate that a correct
local technical-term/notation rendering can coexist with an intentional nearby
variation. A whole-clip script-match answer is not a token-level replacement
license. The user also noted that the item potency/idempotency homophone is
inherently difficult. Such ambiguity remains pending; no additional model has
been downloaded or made a product prerequisite.

A larger installed-model experiment produced useful unprompted text, but also
invented repetitions under the experimental script prompt and omitted a spoken
restart. Those outcomes concern that prompted/fixed-decoding experiment, not a
claim that the existing recognition is generally poor. The app prototype uses
unprompted recognition with ordinary fallback and automatic language detection;
it does not apply that transcript wholesale.

An experimental scorer was built against official whisper.cpp v1.7.5 commit
`51c6961c7b64b406833f4b6a4a20e67142f69225` under ignored build output. It scores
competing complete text sequences autoregressively on recorded audio and on
silence, and also obtains an unprompted baseline. The public API fills only the
last logits row: the implementation decodes each next token explicitly, rather
than reading unfilled batch rows. Scores include end-of-transcript and retain
per-token log probabilities for private inspection.

On three development clips, the target JSON spelling had a better conditional
score than the recognition spelling, while the idempotency spelling lost to its
recognized homophone. Written/spelled path alternatives shared acoustic content;
a wrong method/identifier scored substantially worse. Exact raw results and
inputs are in the private study folder. These comparisons are not calibrated
acoustic probabilities or a release criterion pass: decoder language priors and
representation/sequence length still affect the scores. No production automatic
rule has been selected from them.

The reusable experiment sources are `scripts/script-acoustic-score.cpp` and
`scripts/build-script-acoustic.sh`; the build requires an explicit unmodified
pinned upstream checkout and never downloads models or installs the app. The
interface is based on the upstream [public C API](https://github.com/ggml-org/whisper.cpp/blob/v1.7.5/include/whisper.h).
Neither this experiment nor matching text fixtures replaces held-out listening
evaluation. All previous release criteria remain unmet until measured.
