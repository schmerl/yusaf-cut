/** Pure, conservative candidate generation. Script similarity is not audio proof. */
import type { Project } from "./edl";
import { VOCAL_FILLERS } from "./fillers";
import { occurrenceLineage } from "./fillerReview";
import { projectTranscript, type ProjectedBlock, type ProjectedRun } from "./transcript";
import type { TextRange } from "./transcriptEdits";
import { parseScript, type ScriptPassage } from "./scriptMarkdown";
import type { ScriptResultKind } from "./scriptAssistance";

export const SCRIPT_MATCH_POLICY = "script-match-v2";
export function isVocalFillerOnly(text: string): boolean {
  const words = tokens(text);
  return (
    words.length > 0 &&
    words.every((word) => (VOCAL_FILLERS as readonly string[]).includes(word.value))
  );
}
function spokenNumber(text: string): string | null {
  const digits: Record<string, string> = {
    zero: "0",
    o: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    point: ".",
  };
  const value = tokens(text)
    .map((t) => digits[t.value] ?? (/^\d+$/u.test(t.value) ? t.value : "?"))
    .join("");
  return /^\d+(?:\.\d+)*$/u.test(value) ? value : null;
}
interface Token {
  value: string;
  from: number;
  to: number;
}
export interface ScriptCandidate extends TextRange {
  kind: ScriptResultKind;
  beforeText: string;
  afterText: string;
  scriptFrom: number;
  scriptTo: number;
  occurrenceLineage: string;
  mediaId: string;
  anchorIds: string[];
  sourceIn: number;
  sourceOut: number;
  protected: boolean;
  actionable: boolean;
  reason: string;
}

function tokens(text: string): Token[] {
  return Array.from(text.matchAll(/[\p{L}\p{M}\p{N}_]+(?:['’][\p{L}\p{M}\p{N}_]+)*/gu), (m) => ({
    value: m[0].toLocaleLowerCase("en-US").replaceAll("’", "'"),
    from: m.index!,
    to: m.index! + m[0].length,
  }));
}
export function scriptRunProtected(run: ProjectedRun): boolean {
  if (run.provenance) return run.provenance.author !== "script";
  // Normalized untouched overlays are eligible. Legacy hidden/changed/merged
  // groups are protected; authorship cannot be inferred from overlay presence.
  return !run.text || run.anchorIds.length !== 1 || run.text !== run.originalText.trim();
}

interface Pair {
  current?: number;
  script?: number;
}
interface Alignment {
  cost: number;
  pairs: Pair[];
  passage: ScriptPassage;
  scriptStart: number;
  scriptEnd: number;
}
function align(current: Token[], script: Token[], passage: ScriptPassage): Alignment[] {
  if (!current.length || !script.length) return [];
  if (current.length * script.length > 2_000_000) return [];
  const width = script.length + 1;
  const matrix = new Uint16Array((current.length + 1) * width);
  const at = (i: number, j: number) => matrix[i * width + j]!;
  for (let i = 1; i <= current.length; i++) {
    matrix[i * width] = i;
    for (let j = 1; j <= script.length; j++)
      matrix[i * width + j] = Math.min(
        at(i - 1, j - 1) + (current[i - 1]!.value === script[j - 1]!.value ? 0 : 1),
        at(i - 1, j) + 1,
        at(i, j - 1) + 1,
      );
  }
  const lowest = Math.min(
    ...Array.from({ length: script.length }, (_, j) => at(current.length, j + 1)),
  );
  if (lowest > Math.max(2, Math.floor(current.length * 0.4))) return [];
  const results: Alignment[] = [];
  // Retain equal-cost endpoints until neighboring surviving context can choose
  // a boundary. Collapsing overlapping windows here would confuse a repeated
  // word with the next scripted word, or append an unspoken next sentence.
  for (let end = script.length; end >= 1; end--) {
    if (at(current.length, end) !== lowest) continue;
    const pairs: Pair[] = [];
    let i = current.length,
      j = end;
    while (i > 0) {
      if (
        j > 0 &&
        at(i, j) === at(i - 1, j - 1) + (current[i - 1]!.value === script[j - 1]!.value ? 0 : 1)
      ) {
        pairs.push({ current: --i, script: --j });
      } else if (at(i, j) === at(i - 1, j) + 1) pairs.push({ current: --i });
      else pairs.push({ script: --j });
    }
    pairs.reverse();
    const agreements = pairs.filter(
      (pair) =>
        pair.current !== undefined &&
        pair.script !== undefined &&
        current[pair.current]!.value === script[pair.script]!.value,
    ).length;
    if (agreements < Math.max(2, Math.ceil(current.length * 0.5))) continue;
    results.push({ cost: lowest, pairs, passage, scriptStart: j, scriptEnd: end });
    if (results.length >= 64) break;
  }
  return results;
}

/** Selection is exact, block-local and never expanded through a timing group. */
export function scriptCandidates(project: Project, scope?: TextRange[]): ScriptCandidate[] {
  return Array.from(scriptCandidateBatches(project, scope)).flat();
}

/** Pure block batches let the async workflow yield to Cancel/edits. */
export function* scriptCandidateBatches(
  project: Project,
  scope?: TextRange[],
): Generator<ScriptCandidate[]> {
  const metadata = project.scriptAssistance;
  const stored = metadata?.scripts.find((s) => s.revision === metadata.activeRevision);
  if (!stored) throw new Error("Import a Markdown script before reconciling.");
  const parsed = parseScript(stored.markdown);
  const notationCounts = new Map<string, number>();
  for (const passage of parsed.passages)
    for (const match of passage.text.matchAll(
      /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|QUERY)\s+\/[\p{L}\p{N}_./{}:-]+/gu,
    )) {
      const notation = match[0].replace(/[.,;:]+$/u, "");
      notationCounts.set(notation, (notationCounts.get(notation) ?? 0) + 1);
    }
  const blocks = projectTranscript(project);
  if (scope && !scope.length) throw new Error("Select a nonempty transcript passage.");
  for (const range of scope ?? []) {
    const block = blocks.find((b) => b.segmentId === range.segmentId && b.id === range.blockId);
    if (
      !block ||
      !Number.isInteger(range.from) ||
      !Number.isInteger(range.to) ||
      range.from < 0 ||
      range.to <= range.from ||
      range.to > block.text.length
    )
      throw new Error("The selection changed. Select the passage again.");
  }
  let result: ScriptCandidate[] = [];
  function add(
    block: ProjectedBlock,
    from: number,
    to: number,
    afterText: string,
    kind: ScriptResultKind,
    passage: ScriptPassage,
    reason: string,
  ) {
    if (
      (kind === "wording" || kind === "notation" || kind === "punctuation") &&
      tokens(block.text.slice(from, to)).some((word) =>
        (VOCAL_FILLERS as readonly string[]).includes(word.value),
      )
    )
      return;
    if (isVocalFillerOnly(block.text.slice(from, to))) return;
    if (
      to <= from ||
      (scope &&
        !scope.some(
          (r) =>
            r.segmentId === block.segmentId && r.blockId === block.id && from < r.to && to > r.from,
        ))
    )
      return;
    if (
      result.some(
        (r) =>
          r.segmentId === block.segmentId && r.blockId === block.id && from < r.to && to > r.from,
      )
    )
      return;
    const segment = project.segments.find((s) => s.id === block.segmentId)!;
    const runs = block.runs.filter((r) => r.to > from && r.from < to);
    if (!runs.length) return;
    const first = block.runs.indexOf(runs[0]!),
      last = block.runs.indexOf(runs.at(-1)!);
    const touched = block.runs.slice(first, last + 1); // Includes protected hidden runs.
    const complete = touched.every((r) => r.from >= from && r.to <= to);
    const inScope =
      !scope ||
      touched.every((run) =>
        scope.some(
          (r) =>
            r.segmentId === block.segmentId &&
            r.blockId === block.id &&
            run.from >= r.from &&
            run.to <= r.to,
        ),
      );
    if (!complete && kind !== "off-script" && kind !== "uncertain") {
      afterText =
        block.text.slice(touched[0]!.from, from) +
        afterText +
        block.text.slice(to, touched.at(-1)!.to);
      from = touched[0]!.from;
      to = touched.at(-1)!.to;
    }
    result.push({
      segmentId: block.segmentId,
      blockId: block.id,
      from,
      to,
      beforeText: block.text.slice(from, to),
      afterText,
      kind,
      scriptFrom: passage.from,
      scriptTo: passage.to,
      mediaId: block.mediaId,
      occurrenceLineage: occurrenceLineage(segment),
      anchorIds: touched.flatMap((r) => r.anchorIds),
      sourceIn: touched[0]!.sourceStart,
      sourceOut: touched.at(-1)!.sourceEnd,
      protected: touched.some(scriptRunProtected),
      actionable: (complete || kind !== "off-script") && inScope && !passage.ambiguous,
      reason:
        (!complete && kind === "off-script") || !inScope
          ? "Selection touches part of a timing group; select the complete phrase."
          : passage.ambiguous
            ? "Resolve the ambiguous script markup before applying this suggestion."
            : reason,
    });
  }
  for (const block of blocks) {
    result = [];
    if (scope && !scope.some((r) => r.segmentId === block.segmentId && r.blockId === block.id))
      continue;
    const current = tokens(block.text);
    if (!current.length) continue;
    // An explicit digit-by-digit notation match must preserve every method,
    // path component and value. It does not infer a different identifier.
    for (const passage of parsed.passages) {
      for (const match of passage.text.matchAll(
        /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|QUERY)\s+(\/[\p{L}\p{N}_./{}:-]+)/gu,
      )) {
        const notation = match[0].replace(/[.,;:]+$/u, "");
        const expected = notationAtoms(notation);
        for (let start = 0; start < current.length; start++) {
          if (current[start]!.value !== expected[0]) continue;
          for (let end = start + 2; end <= Math.min(current.length, start + 30); end++) {
            const spoken = block.text.slice(current[start]!.from, current[end - 1]!.to);
            if (notationAtoms(spoken).join(" ") === expected.join(" ") && spoken !== notation) {
              const repeated = notationCounts.get(notation)! > 1;
              add(
                block,
                current[start]!.from,
                current[end - 1]!.to,
                repeated ? spoken : notation,
                repeated ? "uncertain" : "notation",
                passage,
                repeated
                  ? "This notation appears in repeated script contexts; alignment is uncertain."
                  : "Spoken method, path and digit-by-digit identifier match the script; audio review is still required.",
              );
            }
          }
        }
      }
    }
    const matches = parsed.passages.flatMap((passage) =>
      align(current, tokens(passage.text), passage),
    );
    matches.sort((a, b) => a.cost - b.cost);
    let best = matches[0];
    let ambiguous = !!best && !!matches[1] && matches[1].cost === best.cost;
    if (ambiguous) {
      const index = blocks.indexOf(block);
      const previous =
        blocks[index - 1]?.segmentId === block.segmentId
          ? tokens(blocks[index - 1]!.text).slice(-8)
          : [];
      const following =
        blocks[index + 1]?.segmentId === block.segmentId
          ? tokens(blocks[index + 1]!.text).slice(0, 8)
          : [];
      const ranked = matches
        .filter((match) => match.cost === best!.cost)
        .map((match) => {
          const passageIndex = parsed.passages.indexOf(match.passage);
          const passageTokens = tokens(match.passage.text);
          const before = [
            ...tokens(parsed.passages[passageIndex - 1]?.text ?? ""),
            ...passageTokens.slice(0, match.scriptStart),
          ].slice(-previous.length || undefined);
          const after = [
            ...passageTokens.slice(match.scriptEnd),
            ...tokens(parsed.passages[passageIndex + 1]?.text ?? ""),
          ].slice(0, following.length);
          const score =
            previous.filter(
              (word, i) => word.value === before[before.length - previous.length + i]?.value,
            ).length + following.filter((word, i) => word.value === after[i]?.value).length;
          return { match, score };
        })
        .sort((a, b) => b.score - a.score);
      if (ranked[0]!.score >= 3 && ranked[0]!.score - (ranked[1]?.score ?? 0) >= 3) {
        best = ranked[0]!.match;
        ambiguous = false;
      }
    }
    if (!best || current.length < 3 || ambiguous) {
      add(
        block,
        0,
        block.text.length,
        block.text,
        "uncertain",
        best?.passage ?? parsed.passages[0]!,
        best
          ? "More than one script location fits this passage; choose wording by listening."
          : "Script alignment is uncertain; this does not establish unwanted speech.",
      );
      yield result;
      continue;
    }
    const script = tokens(best.passage.text);
    // Exact value equivalence only; script numbers never supply a different value.
    for (const match of best.passage.text.matchAll(/\b\d+(?:\.\d+)*\b/gu)) {
      if (match.index! > 0 && /[\p{L}\p{N}_.]/u.test(best.passage.text[match.index! - 1]!))
        continue;
      const number = match[0];
      for (let start = 0; start < current.length; start++) {
        for (
          let end = start + 1;
          end <= Math.min(current.length, start + number.length * 2 + 2);
          end++
        ) {
          const spoken = block.text.slice(current[start]!.from, current[end - 1]!.to);
          const numericWord = (word: Token | undefined) =>
            !!word && (word.value === "point" || spokenNumber(word.value) !== null);
          if (
            !numericWord(current[start - 1]) &&
            !numericWord(current[end]) &&
            spokenNumber(spoken) === number &&
            !/^\d+(?:\.\d+)*$/u.test(spoken)
          )
            add(
              block,
              current[start]!.from,
              current[end - 1]!.to,
              number,
              "notation",
              best.passage,
              "The spoken digits and decimal points match this written value. Review the notation before accepting.",
            );
        }
      }
    }
    if (best.cost === 0) {
      const first = script[best.scriptStart]!,
        last = script[best.scriptEnd - 1]!;
      const punctuation = /^[^\p{L}\p{N}\s]*/u.exec(best.passage.text.slice(last.to))![0];
      const proposed =
        best.passage.text.slice(best.scriptStart === 0 ? 0 : first.from, last.to) + punctuation;
      const sentenceStart =
        best.scriptStart === 0 || /[.!?][\s"'”’)]*$/u.test(best.passage.text.slice(0, first.from));
      const sentenceEnd = best.scriptEnd === script.length || /[.!?]/u.test(punctuation);
      if (proposed !== block.text && sameSpokenWords(block.text, proposed)) {
        {
          const written = tokens(proposed);
          for (const run of block.runs) {
            const indices = current.flatMap((word, index) =>
              word.from >= run.from && word.to <= run.to ? [index] : [],
            );
            if (!indices.length) continue;
            const start = indices[0]!,
              end = indices.at(-1)!;
            const preceding = proposed.slice(
              start ? written[start - 1]!.to : 0,
              written[start]!.from,
            );
            const following = proposed.slice(
              written[end]!.to,
              written[end + 1]?.from ?? proposed.length,
            );
            const prefix = start ? /[^\s]*$/u.exec(preceding)![0] : preceding;
            const suffix = end < written.length - 1 ? /^[^\s]*/u.exec(following)![0] : following;
            const formatted =
              prefix + proposed.slice(written[start]!.from, written[end]!.to) + suffix;
            if (formatted === run.text || !sameSpokenWords(run.text, formatted)) continue;
            const simple = isSimpleFormatting(run.text, formatted) && sentenceStart && sentenceEnd;
            add(
              block,
              run.from,
              run.to,
              formatted,
              simple ? "punctuation" : "uncertain",
              best.passage,
              simple
                ? "Only punctuation/capitalization differs; apply explicitly after review."
                : !sentenceStart || !sentenceEnd
                  ? "Sentence boundaries are ambiguous; inspect this formatting suggestion individually."
                  : "This formatting changes technical symbols or an identifier; inspect it individually.",
            );
          }
        }
      }
      yield result;
      continue;
    }
    let group: Pair[] = [];
    function flush() {
      if (!group.length) return;
      const left = group.flatMap((p) => (p.current === undefined ? [] : [current[p.current]!]));
      const right = group.flatMap((p) => (p.script === undefined ? [] : [script[p.script]!]));
      if (left.length) {
        const from = left[0]!.from,
          to = left.at(-1)!.to;
        if (right.length) {
          const proposed = best!.passage.text.slice(right[0]!.from, right.at(-1)!.to);
          const target = right
            .map((word) => word.value)
            .join("")
            .replaceAll("'", "");
          let closest: { start: number; end: number; cost: number } | undefined;
          let tied = false;
          for (let start = 0; start < left.length; start++)
            for (
              let end = start + 1;
              end <= Math.min(left.length, start + right.length + 3);
              end++
            ) {
              const spoken = left
                .slice(start, end)
                .map((word) => word.value)
                .join("")
                .replaceAll("'", "");
              const cost =
                spellingDistance(spoken, target) / Math.max(spoken.length, target.length, 1);
              if (!closest || cost < closest.cost) {
                closest = { start, end, cost };
                tied = false;
              } else if (cost === closest.cost) tied = true;
            }
          // A script alias can be adjacent to an intentional aside or filler.
          // Offer the local alias alone; never replace the whole divergent tail
          // with one scripted word (e.g. "hail me in this [UH] class" -> "HailMe").
          if (
            closest &&
            !tied &&
            (closest.cost <= 0.4 || (left.length === 1 && right.length === 1))
          ) {
            add(
              block,
              left[closest.start]!.from,
              left[closest.end - 1]!.to,
              proposed,
              "wording",
              best!.passage,
              "Wording differs from the script; the script alone does not establish what was spoken.",
            );
            for (const extra of [left.slice(0, closest.start), left.slice(closest.end)]) {
              if (
                extra.length &&
                !/^(?:uh|um|erm|ah)$/iu.test(extra.map((word) => word.value).join(" "))
              )
                add(
                  block,
                  extra[0]!.from,
                  extra.at(-1)!.to,
                  block.text.slice(extra[0]!.from, extra.at(-1)!.to),
                  "off-script",
                  best!.passage,
                  "Additional surviving speech may be intentional. Listen before considering an audio/video cut.",
                );
            }
          } else
            add(
              block,
              from,
              to,
              block.text.slice(from, to),
              "uncertain",
              best!.passage,
              "This divergent passage may include intentional speech or skipped script words; no wording replacement was inferred.",
            );
        } else if (!/^\[?(?:uh|um|erm|ah)\]?$/iu.test(block.text.slice(from, to))) {
          const firstIndex = current.indexOf(left[0]!),
            lastIndex = current.indexOf(left.at(-1)!);
          const repeated =
            current[firstIndex - 1]?.value === left[0]!.value ||
            current[lastIndex + 1]?.value === left.at(-1)!.value;
          add(
            block,
            from,
            to,
            block.text.slice(from, to),
            repeated ? "uncertain" : "off-script",
            best!.passage,
            repeated
              ? "Repeated wording has more than one possible alignment. Listen and select the intended take explicitly."
              : "Surviving speech is absent from the matched script context. It may be an intentional addition or a restart.",
          );
        }
      }
      // Script-only insertions represent skipped material; never insert them.
      group = [];
    }
    for (const pair of best.pairs) {
      if (
        pair.current !== undefined &&
        pair.script !== undefined &&
        current[pair.current]!.value === script[pair.script]!.value
      )
        flush();
      else group.push(pair);
    }
    flush();
    yield result;
  }
}

/** Orthographic locality is only a candidate boundary heuristic, never acoustic evidence. */
function spellingDistance(left: string, right: string): number {
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++)
      next[j + 1] = Math.min(
        row[j + 1]! + 1,
        next[j]! + 1,
        row[j]! + (left[i] === right[j] ? 0 : 1),
      );
    row = next;
  }
  return row[right.length]!;
}

export function sameSpokenWords(left: string, right: string): boolean {
  return (
    tokens(left)
      .map((t) => t.value)
      .join(" ") ===
    tokens(right)
      .map((t) => t.value)
      .join(" ")
  );
}

export function isSimpleFormatting(left: string, right: string): boolean {
  const technical = (text: string) =>
    Array.from(
      text.matchAll(/\/[^\s]+|\b[\p{L}_]*\d[\p{L}\p{N}_.:,/-]*|[<>=+*@$%#|~^{}[\]\\-]/gu),
      (match) => match[0],
    );
  return (
    sameSpokenWords(left, right) &&
    JSON.stringify(technical(left)) === JSON.stringify(technical(right))
  );
}
function notationAtoms(text: string): string[] {
  const digits: Record<string, string> = {
    zero: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  const expanded = text.replaceAll("/", " slash ").replace(/([\p{L}])(\d)/gu, "$1 $2");
  return tokens(expanded).flatMap((token) => {
    const value = digits[token.value] ?? token.value;
    return /^\d+$/u.test(value) ? value.split("") : [value];
  });
}
