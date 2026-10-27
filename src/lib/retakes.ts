import type { Project } from "./edl";
import { projectTranscript } from "./transcript";

export type RetakeKind =
  | "word-stutter"
  | "phrase-restart"
  | "abandoned-start"
  | "spoken-correction"
  | "reworded-retake";
export interface RetakeRecord {
  id: string;
  segmentId: string;
  occurrenceId: string;
  blockId: string;
  runId: string;
  mediaId: string;
  sequence: number;
  anchorIds: string[];
  text: string;
  originalText: string;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
}
export interface RetakeSpan {
  start: number;
  end: number;
}
export interface RawRetakeGroup {
  kind: RetakeKind;
  attempts: (RetakeSpan & { complete: boolean })[];
  markers: RetakeSpan[];
}
export interface RetakeAttempt {
  id: string;
  recordIds: string[];
  complete: boolean;
}
export interface RetakeCandidate {
  id: string;
  kind: RetakeKind;
  attempts: RetakeAttempt[];
  markerIds: string[];
  envelopeIds: string[];
  suggestedAttemptId?: string;
  explanation: string;
}
export interface RetakeWindow {
  id: string;
  records: RetakeRecord[];
}
export const RETAKE_WINDOW_SECONDS = 30;
const labels: Record<RetakeKind, string> = {
  "word-stutter": "Word stutter",
  "phrase-restart": "Phrase restart",
  "abandoned-start": "Abandoned start",
  "spoken-correction": "Spoken correction",
  "reworded-retake": "Possible reworded retake",
};
function requireValid(valid: unknown, message: string): asserts valid {
  if (!valid) throw new Error(`Invalid retake proposal: ${message}`);
}

/** Current surviving speech only; no normalization is installed in the store. */
export function retakeRecords(project: Project): RetakeRecord[] {
  let sequence = -1;
  let previousMedia = "";
  const sequences = new Map<string, number>();
  for (const segment of project.segments) {
    if (segment.mediaId !== previousMedia) sequence++;
    previousMedia = segment.mediaId;
    sequences.set(segment.id, sequence);
  }
  return projectTranscript(project).flatMap((block) =>
    block.runs.map((run) => ({
      id: JSON.stringify([block.segmentId, block.occurrenceId, run.id]),
      segmentId: block.segmentId,
      occurrenceId: block.occurrenceId,
      blockId: block.id,
      runId: run.id,
      mediaId: block.mediaId,
      sequence: sequences.get(block.segmentId)!,
      anchorIds: [...run.anchorIds],
      text: run.text,
      originalText: run.originalText,
      start: run.outputStart,
      end: run.outputEnd,
      sourceStart: run.sourceStart,
      sourceEnd: run.sourceEnd,
    })),
  );
}

/** Overlapping windows include continuation beyond the comparison-start window.
 * Long passages are bounded to keep inference cancelable and memory predictable.
 */
export function retakeWindows(records: RetakeRecord[]): RetakeWindow[] {
  const windows: RetakeWindow[] = [];
  let start = 0;
  while (start < records.length) {
    const first = records[start]!;
    let end = start + 1;
    while (end < records.length && records[end]!.sequence === first.sequence && end - start < 400) {
      const prev = records[end - 1]!;
      if (prev.end - first.start >= 60 && /[.!?]$/u.test(prev.text)) break;
      end++;
    }
    if (end - start > 1)
      windows.push({ id: `window:${start}`, records: records.slice(start, end) });
    if (end === records.length || records[end]?.sequence !== first.sequence) {
      start = end;
    } else {
      // Move at most 20 seconds, retaining the overlap needed by 30s comparisons.
      let next = start + 1;
      while (next < end - 1 && records[next]!.start - first.start < 20) next++;
      start = next;
    }
  }
  return windows;
}

/** Validate untrusted inference against the exact labeled window it analyzed. */
export function validateRetakeGroups(window: RetakeWindow, value: unknown): RetakeCandidate[] {
  requireValid(Array.isArray(value) && value.length <= 32, "expected a bounded array");
  const records = window.records;
  return (value as unknown[]).map((item) => {
    requireValid(item && typeof item === "object", "expected group");
    const g = item as RawRetakeGroup;
    requireValid(Object.keys(g).sort().join() === "attempts,kind,markers", "unknown group fields");
    requireValid(Object.hasOwn(labels, g.kind), "unknown group kind");
    requireValid(
      Array.isArray(g.attempts) && g.attempts.length >= 2 && g.attempts.length <= 16,
      "attempt count",
    );
    requireValid(Array.isArray(g.markers) && g.markers.length <= 16, "marker count");
    const occupied = new Set<number>();
    function span(s: RetakeSpan, attempt: boolean) {
      requireValid(s && typeof s === "object", "expected span");
      requireValid(
        Object.keys(s).sort().join() === (attempt ? "complete,end,start" : "end,start"),
        "unknown span fields",
      );
      requireValid(
        Number.isInteger(s.start) &&
          Number.isInteger(s.end) &&
          s.start >= 0 &&
          s.start < s.end &&
          s.end <= records.length,
        "span bounds",
      );
      const result = records.slice(s.start, s.end);
      requireValid(
        result.every((r) => r.sequence === result[0]!.sequence && r.mediaId === result[0]!.mediaId),
        "cross-recording span",
      );
      requireValid(
        result.every((r) => r.text.trim()),
        "hidden audible speech in attempt/marker",
      );
      for (let i = s.start; i < s.end; i++) {
        requireValid(!occupied.has(i), "overlapping spans");
        occupied.add(i);
      }
      return result.map((r) => r.id);
    }
    let previous: RawRetakeGroup["attempts"][number] | undefined;
    const attempts = g.attempts.map((a) => {
      requireValid(typeof a.complete === "boolean", "missing completeness");
      const recordIds = span(a, true);
      if (previous) {
        requireValid(a.start >= previous.end, "unordered attempts");
        requireValid(
          records[a.start]!.start - records[previous.start]!.start <= RETAKE_WINDOW_SECONDS,
          "attempts outside 30 seconds",
        );
      }
      previous = a;
      return { id: JSON.stringify(recordIds), recordIds, complete: a.complete };
    });
    const markerIds = g.markers.flatMap((m) => span(m, false));
    const from = Math.min(...g.attempts.map((a) => a.start), ...g.markers.map((a) => a.start));
    const to = Math.max(...g.attempts.map((a) => a.end), ...g.markers.map((a) => a.end));
    const envelope = records.slice(from, to);
    requireValid(
      envelope.every((r) => r.sequence === envelope[0]!.sequence),
      "cross-recording group",
    );
    const suggestedAttemptId = [...attempts].reverse().find((a) => a.complete)?.id;
    return {
      id: JSON.stringify(attempts.map((a) => a.recordIds)),
      kind: g.kind,
      attempts,
      markerIds,
      envelopeIds: envelope.map((r) => r.id),
      suggestedAttemptId,
      explanation: labels[g.kind],
    };
  });
}

/** Obvious adjacent restarts only; semantic analysis still visits every window. */
export function lexicalRetakes(window: RetakeWindow): RetakeCandidate[] {
  const result: RawRetakeGroup[] = [];
  const words = window.records.map((r) =>
    r.text.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, ""),
  );
  for (let i = 0; i < words.length - 1; i++) {
    for (let size = Math.min(8, Math.floor((words.length - i) / 2)); size >= 1; size--) {
      if (size === 1 && !/^(the|a|an|i|we|it|he|she|they)$/u.test(words[i]!)) continue;
      if (window.records.slice(i, i + size).some((r) => /[.!?]$/u.test(r.text))) continue;
      const equal = (at: number) =>
        words.slice(i, i + size).every((w, j) => w && w === words[at + j]);
      if (!equal(i + size)) continue;
      const attempts = [{ start: i, end: i + size, complete: true }];
      let cursor = i + size;
      while (cursor + size <= words.length && equal(cursor)) {
        const first = window.records[cursor]!;
        const last = window.records[cursor - 1]!;
        if (first.sequence !== last.sequence || first.start - last.end > 1.5) break;
        attempts.push({ start: cursor, end: cursor + size, complete: true });
        cursor += size;
      }
      if (attempts.length < 2 || cursor >= words.length) continue;
      result.push({ kind: size === 1 ? "word-stutter" : "phrase-restart", attempts, markers: [] });
      i = cursor - 1;
      break;
    }
  }
  return validateRetakeGroups(window, result);
}

/** All neighboring sentences are eligible, including those without word overlap.
 * Explicit restart markers also create hypotheses inside a sentence. The local
 * model verifies the relationship and completeness; it cannot change the spans.
 */
export function semanticHypotheses(window: RetakeWindow): RawRetakeGroup[] {
  const records = window.records;
  const words = records.map((r) => r.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ""));
  const markers: RetakeSpan[] = [];
  const phrases = [
    "no let me put that differently",
    "let me put that differently",
    "let me start again",
    "let me try again",
    "let me rephrase that",
    "sorry",
    "i mean",
  ];
  for (let i = 0; i < words.length; i++) {
    const phrase = phrases.find((p) => p.split(" ").every((word, j) => words[i + j] === word));
    if (phrase) {
      const end = i + phrase.split(" ").length;
      markers.push({ start: i, end });
      i = end - 1;
    }
  }
  const hypotheses: RawRetakeGroup[] = [];
  function add(first: RetakeSpan, last: RetakeSpan, marker?: RetakeSpan) {
    if (
      first.start >= first.end ||
      last.start >= last.end ||
      last.start < first.end ||
      records[last.start]!.start - records[first.start]!.start > 30 ||
      records[first.start]!.sequence !== records[last.start]!.sequence
    )
      return;
    const spans = [first, last];
    if (spans.some((s) => records.slice(s.start, s.end).some((r) => !r.text.trim()))) return;
    if (spans.some((s) => markers.some((m) => m.start < s.end && m.end > s.start))) return;
    const markerText = marker ? words.slice(marker.start, marker.end).join(" ") : "";
    hypotheses.push({
      kind:
        markerText === "sorry" || markerText === "i mean"
          ? "spoken-correction"
          : markerText.includes("differently") || markerText.includes("rephrase")
            ? "reworded-retake"
            : "abandoned-start",
      attempts: [
        { ...first, complete: false },
        { ...last, complete: false },
      ],
      markers: marker ? [marker] : [],
    });
  }
  for (const marker of markers) {
    if (marker.start === 0 || marker.end >= records.length) continue;
    if (["sorry", "i mean"].includes(words.slice(marker.start, marker.end).join(" "))) {
      // Single timed terms only; complex phrase corrections need better boundary evidence.
      add(
        { start: marker.start - 1, end: marker.start },
        { start: marker.end, end: marker.end + 1 },
        marker,
      );
      continue;
    }
    let start = marker.start - 1,
      end = marker.end + 1;
    while (start > 0 && !/[.!?]$/u.test(records[start - 1]!.text)) start--;
    while (end < records.length && !/[.!?]$/u.test(records[end - 1]!.text)) end++;
    add({ start, end: marker.start }, { start: marker.end, end }, marker);
  }
  const sentences: RetakeSpan[] = [];
  let start = 0;
  for (let i = 0; i < records.length; i++)
    if (/[.!?]$/u.test(records[i]!.text) || i === records.length - 1) {
      sentences.push({ start, end: i + 1 });
      start = i + 1;
    }
  for (let i = 1; i < sentences.length; i++) add(sentences[i - 1]!, sentences[i]!);
  return [...new Map(hypotheses.map((h) => [JSON.stringify(h), h])).values()].slice(0, 32);
}

/** Deduplicate identical groups, merge compatible chains, omit conflicting overlaps. */
export function groupRetakes(records: RetakeRecord[], input: RetakeCandidate[]): RetakeCandidate[] {
  const positions = new Map(records.map((r, i) => [r.id, i]));
  const unique = [...new Map(input.map((c) => [c.id, c])).values()];
  const result: RetakeCandidate[] = [];
  for (const candidate of unique) {
    const prior = result.find((p) =>
      p.attempts.some((a) => candidate.attempts.some((b) => a.id === b.id)),
    );
    if (!prior) {
      result.push(candidate);
      continue;
    }
    const attempts = [
      ...new Map([...prior.attempts, ...candidate.attempts].map((a) => [a.id, a])).values(),
    ].sort((a, b) => positions.get(a.recordIds[0]!)! - positions.get(b.recordIds[0]!)!);
    const allIds = attempts.flatMap((a) => a.recordIds);
    if (new Set(allIds).size !== allIds.length) {
      result.push(candidate);
      continue;
    }
    prior.attempts = attempts;
    prior.markerIds = [...new Set([...prior.markerIds, ...candidate.markerIds])];
    const from = Math.min(
      ...[...prior.envelopeIds, ...candidate.envelopeIds].map((id) => positions.get(id)!),
    );
    const to = Math.max(
      ...[...prior.envelopeIds, ...candidate.envelopeIds].map((id) => positions.get(id)!),
    );
    prior.envelopeIds = records.slice(from, to + 1).map((r) => r.id);
    prior.suggestedAttemptId = [...attempts].reverse().find((a) => a.complete)?.id;
    prior.id = JSON.stringify(attempts.map((a) => a.recordIds));
  }
  return result
    .filter(
      (a) => !result.some((b) => a !== b && a.envelopeIds.some((id) => b.envelopeIds.includes(id))),
    )
    .sort((a, b) => positions.get(a.envelopeIds[0]!)! - positions.get(b.envelopeIds[0]!)!);
}
