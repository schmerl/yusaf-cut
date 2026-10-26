import { v4 as uuid } from "uuid";
import { deleteWords, type Project, type Segment } from "./edl";
import {
  normalizeProjectTranscripts,
  projectTranscript,
  validateProjectTranscripts,
  type TranscriptBlock,
} from "./transcript";

export interface TextRange {
  segmentId: string;
  blockId: string;
  from: number;
  to: number;
}
export interface TextEdit extends TextRange {
  text: string;
}

function fail(message: string): never {
  throw new Error(message);
}
function finish(project: Project): Project {
  validateProjectTranscripts(project);
  return { ...project, updatedAt: new Date().toISOString() };
}

/** A single replacement retains all affected anchors as one timing group. */
export function replaceTranscriptText(project: Project, edit: TextEdit): Project {
  const normalized = normalizeProjectTranscripts(project);
  const block =
    projectTranscript(normalized).find(
      (b) => b.segmentId === edit.segmentId && b.id === edit.blockId,
    ) ?? fail("This passage changed. Select it again.");
  if (
    !Number.isInteger(edit.from) ||
    !Number.isInteger(edit.to) ||
    edit.from < 0 ||
    edit.to < edit.from ||
    edit.to > block.text.length
  )
    fail("Invalid text selection.");
  const text = block.text.slice(0, edit.from) + edit.text + block.text.slice(edit.to);
  if (text === block.text) return project;
  if (!text.trim())
    fail("A spoken paragraph must retain text. Use Cut speech to remove its audio.");
  // Include separator ranges in their following run. Empty runs retain their anchors.
  const starts = block.runs.map((_r, i) => (i ? block.runs[i - 1]!.to : 0));
  let first = block.runs.findIndex((r) => r.to > edit.from);
  if (first < 0) first = block.runs.length - 1;
  let last = first;
  if (edit.to > edit.from) {
    for (let i = first; i < block.runs.length; i++) if (starts[i]! < edit.to) last = i;
  }
  const segment = normalized.segments.find((s) => s.id === edit.segmentId)!;
  const stored = segment.transcript!.blocks.find((b) => b.id === edit.blockId)!;
  const start = starts[first]!;
  const end = block.runs[last]!.to;
  const replacement =
    block.text.slice(start, edit.from) + edit.text + block.text.slice(edit.to, end);
  const anchors = stored.runs.slice(first, last + 1).flatMap((r) => r.anchorIds);
  const leading = first > 0 && replacement.trim() ? replacement.match(/^\s*/u)![0] : "";
  const run = {
    ...stored.runs[first]!,
    text: replacement.slice(leading.length),
    separatorBefore: leading,
    anchorIds: anchors,
  };
  const nextBlock = {
    ...stored,
    runs: [...stored.runs.slice(0, first), run, ...stored.runs.slice(last + 1)],
  };
  return finish({
    ...normalized,
    segments: normalized.segments.map((s) =>
      s !== segment
        ? s
        : {
            ...s,
            transcript: {
              ...s.transcript!,
              blocks: s.transcript!.blocks.map((b) => (b === stored ? nextBlock : b)),
            },
          },
    ),
  });
}

/** All edits refer to the same revision; apply backwards to avoid offset drift. */
export function replaceTranscriptBatch(
  project: Project,
  expected: Project,
  edits: TextEdit[],
): Project {
  if (project !== expected) fail("The transcript changed. Review the replacements again.");
  const sorted = [...edits].sort(
    (a, b) =>
      a.segmentId.localeCompare(b.segmentId) ||
      a.blockId.localeCompare(b.blockId) ||
      b.from - a.from,
  );
  let previous: TextEdit | undefined;
  for (const edit of sorted) {
    if (
      previous &&
      previous.segmentId === edit.segmentId &&
      previous.blockId === edit.blockId &&
      edit.to > previous.from
    )
      fail("Overlapping replacements are not supported.");
    previous = edit;
  }
  return sorted.reduce(replaceTranscriptText, project);
}

/** Selection restoration is explicit about expanding to complete timing groups.
 * A whole paragraph includes hidden runs, so text-only deletions are recoverable.
 */
export function originalTranscriptPassage(project: Project, range: TextRange) {
  const block =
    projectTranscript(project).find(
      (b) => b.segmentId === range.segmentId && b.id === range.blockId,
    ) ?? fail("This passage changed. Select it again.");
  if (
    !Number.isInteger(range.from) ||
    !Number.isInteger(range.to) ||
    range.from < 0 ||
    range.to <= range.from ||
    range.to > block.text.length
  )
    fail("Select a passage or inspect its whole paragraph.");
  const whole = range.from === 0 && range.to === block.text.length;
  const runs = block.runs.filter((r) => whole || (r.to > range.from && r.from < range.to));
  if (!runs.length) fail("Select a timed passage to restore.");
  return {
    wholeParagraph: whole,
    runIds: runs.map((r) => r.id),
    originalText: runs.map((r) => r.originalText).join(" "),
    expanded: !whole && runs.some((r) => r.from < range.from || r.to > range.to),
  };
}

export function restoreTranscriptRange(
  project: Project,
  expected: Project,
  range: TextRange,
): Project {
  if (project !== expected) fail("The transcript changed. Inspect the passage again.");
  const passage = originalTranscriptPassage(project, range);
  const selected = new Set(passage.runIds);
  const p = normalizeProjectTranscripts(project);
  return finish({
    ...p,
    segments: p.segments.map((s) => {
      if (s.id !== range.segmentId) return s;
      const originals = new Map(s.transcript!.originals.map((w) => [w.id, w]));
      return {
        ...s,
        transcript: {
          ...s.transcript!,
          blocks: s.transcript!.blocks.map((b) =>
            b.id !== range.blockId
              ? b
              : {
                  ...b,
                  runs: b.runs.flatMap((r) =>
                    !selected.has(r.id)
                      ? [r]
                      : r.anchorIds.map((id, i) => ({
                          id: uuid(),
                          text: originals.get(id)!.text,
                          separatorBefore: i || passage.wholeParagraph ? " " : r.separatorBefore,
                          anchorIds: [id],
                        })),
                  ),
                },
          ),
        },
      };
    }),
  });
}

export function restoreTranscriptBlock(
  project: Project,
  segmentId: string,
  blockId: string,
): Project {
  const block =
    projectTranscript(project).find((b) => b.segmentId === segmentId && b.id === blockId) ??
    fail("This passage changed. Select it again.");
  return restoreTranscriptRange(project, project, {
    segmentId,
    blockId,
    from: 0,
    to: block.text.length,
  });
}

/** A partial corrected phrase is rejected, never silently expanded. */
export function cutTranscriptRanges(project: Project, ranges: TextRange[]): Project {
  let p = normalizeProjectTranscripts(project);
  const blocks = projectTranscript(p);
  const selected = new Map<string, Set<string>>();
  for (const range of ranges) {
    const block =
      blocks.find((b) => b.segmentId === range.segmentId && b.id === range.blockId) ??
      fail("This passage changed. Select it again.");
    const fullBlock = range.from === 0 && range.to === block.text.length;
    if (range.from < 0 || range.to > block.text.length || range.from >= range.to)
      fail("Select speech to cut.");
    const ids = selected.get(block.segmentId) ?? new Set<string>();
    for (const run of block.runs) {
      const overlaps = run.to > range.from && run.from < range.to;
      if (!fullBlock && !overlaps) continue;
      if (!fullBlock && (range.from > run.from || range.to < run.to)) {
        fail("Select the whole timed word or corrected phrase to Cut speech.");
      }
      run.anchorIds.forEach((id) => ids.add(id));
    }
    selected.set(block.segmentId, ids);
  }
  // Occurrence-scoped, so repeated source-word IDs never cut a different clip.
  p = {
    ...p,
    segments: p.segments.flatMap((segment) => {
      const ids = selected.get(segment.id);
      return !ids?.size ? [segment] : deleteWords({ ...p, segments: [segment] }, ids).segments;
    }),
  };
  return ranges.length ? finish(p) : project;
}

/** Used by every EDL split/cut. Never discard the overlay of retained speech. */
export function reconcileTranscript(source: Segment, target: Segment): Segment {
  if (!source.transcript) return target;
  const surviving = new Set(
    target.words
      .filter((w) => w.end > target.sourceIn && w.start < target.sourceOut)
      .map((w) => w.id),
  );
  const blocks: TranscriptBlock[] = [];
  for (const block of source.transcript.blocks) {
    const runs = block.runs.filter((r) => {
      const count = r.anchorIds.filter((id) => surviving.has(id)).length;
      if (count && count !== r.anchorIds.length)
        fail("This cut splits a corrected phrase. Select its whole timing group.");
      return count > 0;
    });
    if (runs.length) {
      // Retained hidden speech must not become an invalid empty paragraph after a cut.
      if (!runs.some((r) => r.text.trim()))
        fail(
          "This cut would leave a paragraph with audio but no text. Restore its text or cut the whole paragraph.",
        );
      blocks.push({ ...block, runs });
    }
  }
  return {
    ...target,
    transcript: {
      ...source.transcript,
      occurrenceId:
        target.id === source.id ? source.transcript.occurrenceId : `transcript:${target.id}`,
      originals: source.transcript.originals.filter((w) => surviving.has(w.id)),
      blocks,
    },
  };
}

export function editBlockText(
  project: Project,
  segmentId: string,
  blockId: string,
  text: string,
): Project {
  const block =
    projectTranscript(project).find((b) => b.segmentId === segmentId && b.id === blockId) ??
    fail("This passage changed.");
  if (text === block.text) return project;
  let from = 0;
  while (from < text.length && from < block.text.length && text[from] === block.text[from]) from++;
  let end = block.text.length,
    nextEnd = text.length;
  while (end > from && nextEnd > from && block.text[end - 1] === text[nextEnd - 1]) {
    end--;
    nextEnd--;
  }
  return replaceTranscriptText(project, {
    segmentId,
    blockId,
    from,
    to: end,
    text: text.slice(from, nextEnd),
  });
}

/** Paragraph splits at timing-group boundaries only; no invented timestamps. */
export function splitTranscriptBlock(
  project: Project,
  segmentId: string,
  blockId: string,
  offset: number,
): Project {
  const p = normalizeProjectTranscripts(project);
  const block = projectTranscript(p).find((b) => b.segmentId === segmentId && b.id === blockId)!;
  const index = block.runs.findIndex(
    (r, i) => i > 0 && offset >= block.runs[i - 1]!.to && offset <= r.from,
  );
  if (index < 1)
    fail("Split paragraphs between timed words or phrases, not inside a timing group.");
  return finish({
    ...p,
    segments: p.segments.map((s) =>
      s.id !== segmentId
        ? s
        : {
            ...s,
            transcript: {
              ...s.transcript!,
              blocks: s.transcript!.blocks.flatMap((b) =>
                b.id !== blockId
                  ? [b]
                  : [
                      { ...b, runs: b.runs.slice(0, index) },
                      { id: uuid(), runs: b.runs.slice(index) },
                    ],
              ),
            },
          },
    ),
  });
}

export function joinTranscriptBlocks(
  project: Project,
  segmentId: string,
  firstId: string,
  secondId: string,
): Project {
  const p = normalizeProjectTranscripts(project);
  const segment = p.segments.find((s) => s.id === segmentId)!;
  const blocks = segment.transcript!.blocks;
  const index = blocks.findIndex((b) => b.id === firstId);
  if (index < 0 || blocks[index + 1]?.id !== secondId)
    fail("Cannot join paragraphs across clips or cuts.");
  const first = blocks[index]!,
    second = blocks[index + 1]!;
  const joined = {
    ...first,
    runs: [...first.runs, ...second.runs.map((r, i) => (i ? r : { ...r, separatorBefore: "" }))],
  };
  return finish({
    ...p,
    segments: p.segments.map((s) =>
      s !== segment
        ? s
        : {
            ...s,
            transcript: {
              ...s.transcript!,
              blocks: [...blocks.slice(0, index), joined, ...blocks.slice(index + 2)],
            },
          },
    ),
  });
}

export function cutOutputSpeech(project: Project, start: number, end: number): Project {
  const from = Math.min(start, end),
    to = Math.max(start, end);
  const ranges: TextRange[] = [];
  for (const block of projectTranscript(project)) {
    for (const run of block.runs) {
      if (run.outputEnd <= from || run.outputStart >= to || !run.text.trim()) continue;
      if (run.anchorIds.length > 1 && (from > run.outputStart || to < run.outputEnd)) {
        fail("The range splits a corrected phrase. Select its whole audio span.");
      }
      ranges.push({ segmentId: block.segmentId, blockId: block.id, from: run.from, to: run.to });
    }
    // A whole paragraph includes any text-hidden audio anchors.
    if (
      block.runs.length &&
      from <= block.runs[0]!.outputStart &&
      to >= block.runs.at(-1)!.outputEnd
    ) {
      ranges.push({
        segmentId: block.segmentId,
        blockId: block.id,
        from: 0,
        to: block.text.length,
      });
    }
  }
  return cutTranscriptRanges(project, ranges);
}

export interface EditorParagraph {
  segmentId: string;
  blockId: string;
  text: string;
}
/** Converts a structural editor transaction to validated model changes. */
export function applyTranscriptDocument(project: Project, paragraphs: EditorParagraph[]): Project {
  let p = project;
  const before = projectTranscript(project);
  if (!paragraphs.length)
    fail("A spoken paragraph must retain text. Use Cut speech to remove audio.");
  const positions = new Map(before.map((b, index) => [`${b.segmentId}:${b.id}`, index]));
  const retained = new Set(paragraphs.map((b) => `${b.segmentId}:${b.blockId}`));
  // Joining adjacent paragraphs is allowed only within one continuous segment.
  for (let i = 0; i < paragraphs.length; i++) {
    const next = paragraphs[i]!;
    const oldIndex = positions.get(`${next.segmentId}:${next.blockId}`) ?? -1;
    if (oldIndex < 0) fail("Use Enter to split at a timed word boundary.");
    const nextId = paragraphs[i + 1]?.blockId;
    let j = oldIndex + 1;
    let joined = false;
    while (j < before.length && before[j]!.id !== nextId) {
      if (retained.has(`${before[j]!.segmentId}:${before[j]!.id}`)) break;
      if (before[j]!.segmentId !== next.segmentId) fail("Cannot join text across clips or cuts.");
      p = joinTranscriptBlocks(p, next.segmentId, next.blockId, before[j]!.id);
      joined = true;
      j++;
    }
    if (joined || next.text !== before[oldIndex]!.text)
      p = editBlockText(p, next.segmentId, next.blockId, next.text);
  }
  const projected = projectTranscript(p);
  if (
    projected.length !== paragraphs.length ||
    projected.some((b, i) => b.text !== paragraphs[i]!.text)
  ) {
    fail("This edit would lose a spoken paragraph. Use Cut speech to remove audio.");
  }
  return p;
}
