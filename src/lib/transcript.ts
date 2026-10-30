/** Phase 1 foundations. Pure APIs; the legacy editor does not write overlays yet. */
import { validateFillerReview } from "./fillerReview";
import { computeTimeline, type Project, type Segment, type Word } from "./edl";

export interface TranscriptRun {
  id: string;
  text: string;
  /** Explicit spacing, retained for later inline editing; ignored for hidden runs. */
  separatorBefore: string;
  anchorIds: string[];
}

export interface TranscriptBlock {
  id: string;
  runs: TranscriptRun[];
}

export interface TranscriptMetadata {
  version: 1;
  occurrenceId: string;
  /** Immutable available recognition baseline, including text-hidden words. */
  originals: Word[];
  blocks: TranscriptBlock[];
}

export interface ProjectedRun {
  id: string;
  text: string;
  originalText: string;
  anchorIds: string[];
  /** UTF-16 offsets within the block's displayed text, end exclusive. */
  from: number;
  to: number;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
}

export interface ProjectedBlock {
  id: string;
  occurrenceId: string;
  segmentId: string;
  mediaId: string;
  text: string;
  runs: ProjectedRun[];
}

function survivingWords(segment: Segment): Word[] {
  return segment.words.filter((w) => w.end > segment.sourceIn && w.start < segment.sourceOut);
}

/** Deterministic IDs, no timestamps, no mutation, no dirty-state changes. */
export function normalizeTranscript(segment: Segment): TranscriptMetadata {
  if (segment.transcript) return segment.transcript;
  const originals = survivingWords(segment).map((w) => ({ ...w }));
  const prefix = `transcript:${segment.id}`;
  const blocks: TranscriptBlock[] = [];
  originals.forEach((word, index) => {
    const previous = originals[index - 1];
    if (!previous || word.start - previous.end >= 0.75 || /[.!?]$/.test(previous.text.trim())) {
      blocks.push({ id: `${prefix}:block:${index}`, runs: [] });
    }
    const block = blocks[blocks.length - 1]!;
    block.runs.push({
      id: `${prefix}:run:${index}`,
      text: word.text.trim(),
      separatorBefore: block.runs.length ? " " : "",
      anchorIds: [word.id],
    });
  });
  return { version: 1, occurrenceId: prefix, originals, blocks };
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid transcript: ${message}`);
}

/** Validate before using offsets or saving. Group mappings partition surviving anchors. */
export function validateTranscript(
  segment: Segment,
  metadata = normalizeTranscript(segment),
): void {
  requireValid(metadata.version === 1, "unsupported metadata version");
  requireValid(
    typeof metadata.occurrenceId === "string" && metadata.occurrenceId.trim(),
    "empty occurrence ID",
  );
  requireValid(
    Number.isFinite(segment.sourceIn) &&
      segment.sourceIn >= 0 &&
      Number.isFinite(segment.sourceOut) &&
      segment.sourceOut > segment.sourceIn,
    "invalid segment range",
  );
  const words = survivingWords(segment);
  requireValid(metadata.originals.length === words.length, "anchor coverage mismatch");
  const anchorIds = new Set<string>();
  metadata.originals.forEach((word, i) => {
    const current = words[i]!;
    requireValid(
      typeof word.id === "string" && word.id.trim() && !anchorIds.has(word.id),
      "duplicate/empty anchor ID",
    );
    requireValid(
      typeof word.text === "string" &&
        Number.isFinite(word.confidence) &&
        word.confidence >= 0 &&
        word.confidence <= 1,
      "invalid original word",
    );
    requireValid(
      Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.start >= 0 &&
        word.end > word.start,
      "invalid anchor range",
    );
    requireValid(
      word.id === current.id && word.start === current.start && word.end === current.end,
      "original anchors differ from surviving audio",
    );
    if (i) requireValid(word.start >= metadata.originals[i - 1]!.start, "unordered anchors");
    anchorIds.add(word.id);
  });
  const ids = new Set<string>();
  let cursor = 0;
  for (const block of metadata.blocks) {
    requireValid(
      typeof block.id === "string" && block.id.trim() && !ids.has(block.id),
      "duplicate/empty block ID",
    );
    ids.add(block.id);
    requireValid(block.runs.length > 0, "empty block");
    let text = "";
    for (const run of block.runs) {
      requireValid(
        typeof run.id === "string" && run.id.trim() && !ids.has(run.id),
        "duplicate/empty run ID",
      );
      ids.add(run.id);
      requireValid(
        typeof run.text === "string" &&
          typeof run.separatorBefore === "string" &&
          !/\S/u.test(run.separatorBefore),
        "invalid run text/spacing",
      );
      requireValid(run.anchorIds.length > 0, "unanchored run");
      for (const id of run.anchorIds) {
        requireValid(
          id === metadata.originals[cursor]?.id,
          "unknown, repeated, or unordered anchor reference",
        );
        cursor++;
      }
      text += run.text;
    }
    requireValid(text.trim().length > 0, "empty spoken paragraph");
  }
  requireValid(cursor === metadata.originals.length, "unmapped anchors");
}

/** Existing outer project version stays 1; metadata has its own version. */
export function validateProjectTranscripts(project: Project): void {
  requireValid(project.version === 1, "unsupported project version");
  validateFillerReview(project);
  const occurrences = new Set<string>();
  const segments = new Set<string>();
  for (const segment of project.segments) {
    // Legacy projects are not retroactively subjected to overlay constraints.
    requireValid(
      typeof segment.id === "string" && segment.id.trim() && !segments.has(segment.id),
      "duplicate/empty segment ID",
    );
    segments.add(segment.id);
    if (!segment.transcript) continue;
    requireValid(Boolean(project.media[segment.mediaId]), "unknown source media");
    validateTranscript(segment);
    requireValid(!occurrences.has(segment.transcript.occurrenceId), "duplicate occurrence ID");
    occurrences.add(segment.transcript.occurrenceId);
  }
}

/** Opt-in materialization for future edit transactions; legacy callers stay unchanged. */
export function normalizeProjectTranscripts(project: Project): Project {
  validateProjectTranscripts(project);
  let changed = false;
  const segments = project.segments.map((segment) => {
    if (segment.transcript || !survivingWords(segment).length) return segment;
    const transcript = normalizeTranscript(segment);
    validateTranscript(segment, transcript);
    changed = true;
    return { ...segment, transcript };
  });
  const normalized = changed ? { ...project, segments } : project;
  validateProjectTranscripts(normalized);
  return normalized;
}

/** Output order, not source-time sorting; hidden text retains its timing and original. */
export function projectTranscript(project: Project): ProjectedBlock[] {
  const normalized = normalizeProjectTranscripts(project);
  const timeline = computeTimeline(normalized);
  return normalized.segments.flatMap((segment, i) => {
    const metadata = segment.transcript;
    if (!metadata) return [];
    const entry = timeline[i]!;
    const originals = new Map(metadata.originals.map((w) => [w.id, w]));
    return metadata.blocks.map((block) => {
      let text = "";
      const runs = block.runs.map((run): ProjectedRun => {
        const anchors = run.anchorIds.map((id) => originals.get(id)!);
        if (run.text && text) text += run.separatorBefore;
        const from = text.length;
        text += run.text;
        const sourceStart = Math.max(segment.sourceIn, Math.min(...anchors.map((w) => w.start)));
        const sourceEnd = Math.min(segment.sourceOut, Math.max(...anchors.map((w) => w.end)));
        return {
          id: run.id,
          text: run.text,
          originalText: anchors.map((w) => w.text).join(" "),
          anchorIds: [...run.anchorIds],
          from,
          to: text.length,
          sourceStart,
          sourceEnd,
          outputStart: entry.outputStart + sourceStart - segment.sourceIn,
          outputEnd: entry.outputStart + sourceEnd - segment.sourceIn,
        };
      });
      return {
        id: block.id,
        occurrenceId: metadata.occurrenceId,
        segmentId: segment.id,
        mediaId: segment.mediaId,
        text,
        runs,
      };
    });
  });
}
