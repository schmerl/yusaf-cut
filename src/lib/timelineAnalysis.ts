import { v4 as uuid } from "uuid";
import { computeTimeline, type Project, type Segment, type Word } from "./edl";
import {
  normalizeProjectTranscripts,
  normalizeTranscript,
  projectTranscript,
  validateProjectTranscripts,
  type TranscriptBlock,
} from "./transcript";
import { reconcileFillerReview } from "./fillerReview";
import { reconcileScriptReview, rebaseReviewContexts } from "./scriptLifecycle";

export interface UnattributedSpeech {
  id: string;
  segmentId: string;
  sourceIn: number;
  sourceOut: number;
  outputStart: number;
  outputEnd: number;
  gapStart: number;
  gapEnd: number;
  nextBlockId?: string;
  nextSegmentId?: string;
  nextSentence?: string;
  previousBlockId?: string;
  previousSegmentId?: string;
  previousSentence?: string;
}

/** Audio activity is a review candidate, not a claim that a recognizer heard speech.
 * Keep hidden words and retained filler edges covered: text removal is intentional.
 */
export function findUnattributedSpeech(
  project: Project,
  peaks: Record<string, number[]>,
): UnattributedSpeech[] {
  const blocks = projectTranscript(project);
  const segmentsById = new Map(project.segments.map((segment) => [segment.id, segment]));
  const blocksBySegment = new Map<string, typeof blocks>();
  for (const block of blocks) {
    const group = blocksBySegment.get(block.segmentId);
    if (group) group.push(block);
    else blocksBySegment.set(block.segmentId, [block]);
  }
  const findings: UnattributedSpeech[] = [];
  const timeline = computeTimeline(project);
  for (const [entryIndex, entry] of timeline.entries()) {
    const segment = segmentsById.get(entry.segmentId)!;
    if (segment.fillerAudio) continue;
    const samples = peaks[entry.mediaId];
    if (!samples)
      throw new Error("Audio analysis is incomplete. Retry after relinking unavailable media.");
    const segmentBlocks = blocksBySegment.get(segment.id) ?? [];
    const covered = [
      ...segment.words.map((word) => ({ start: word.start, end: word.end })),
      ...segmentBlocks.flatMap((b) =>
        b.runs.map((run) => ({ start: run.sourceStart, end: run.sourceEnd })),
      ),
    ].sort((a, b) => a.start - b.start);
    const gaps: { start: number; end: number }[] = [];
    let cursor = segment.sourceIn;
    for (const span of covered) {
      if (span.start > cursor)
        gaps.push({ start: cursor, end: Math.min(span.start, segment.sourceOut) });
      cursor = Math.max(cursor, span.end);
    }
    if (cursor < segment.sourceOut) gaps.push({ start: cursor, end: segment.sourceOut });
    for (const gap of gaps) {
      if (gap.end - gap.start < 0.3) continue;
      // Bridge up to 180ms of quiet within speech, but do not absorb long pauses.
      let first = -1,
        last = -1,
        active = 0;
      function flush() {
        if (first < 0 || active < 8 || (last - first + 1) / 50 < 0.25) return;
        const from = Math.max(gap.start, first / 50 - 0.04);
        const to = Math.min(gap.end, (last + 1) / 50 + 0.04);
        const nextEntry = timeline[entryIndex + 1];
        const continuousNext =
          !segment.words.length &&
          gap.end === entry.sourceOut &&
          nextEntry?.mediaId === entry.mediaId &&
          nextEntry.sourceIn === entry.sourceOut
            ? blocksBySegment.get(nextEntry.segmentId)?.find((b) => b.text.trim())
            : undefined;
        const next =
          segmentBlocks.find((b) => {
            const run = b.runs[0];
            return run && Math.abs(run.sourceStart - gap.end) < 0.001 && b.text.trim();
          }) ?? continuousNext;
        const previousEntry = timeline[entryIndex - 1];
        const continuousPrevious =
          !segment.words.length &&
          gap.start === entry.sourceIn &&
          previousEntry?.mediaId === entry.mediaId &&
          previousEntry.sourceOut === entry.sourceIn
            ? blocksBySegment
                .get(previousEntry.segmentId)
                ?.filter((b) => b.text.trim())
                .at(-1)
            : undefined;
        const previous =
          segmentBlocks.find((b) => {
            const run = b.runs.at(-1);
            return run && Math.abs(run.sourceEnd - gap.start) < 0.001 && b.text.trim();
          }) ?? continuousPrevious;
        // Bound recognition windows to 30 seconds, matching the native command.
        for (let start = from; start < to - 0.001; start += 30) {
          const end = Math.min(to, start + 30);
          findings.push({
            id: `${segment.id}:${start.toFixed(3)}:${end.toFixed(3)}`,
            segmentId: segment.id,
            sourceIn: start,
            sourceOut: end,
            outputStart: entry.outputStart + start - entry.sourceIn,
            outputEnd: entry.outputStart + end - entry.sourceIn,
            gapStart: gap.start,
            gapEnd: gap.end,
            nextBlockId: next?.id,
            nextSegmentId: next?.segmentId,
            nextSentence: next?.text,
            previousBlockId: previous?.id,
            previousSegmentId: previous?.segmentId,
            previousSentence: previous?.text,
          });
        }
      }
      for (let i = Math.ceil(gap.start * 50); i < Math.floor(gap.end * 50); i++) {
        if ((samples[i] ?? 0) >= 0.016) {
          if (first < 0) first = i;
          last = i;
          active++;
        } else if (first >= 0 && i - last > 9) {
          flush();
          first = -1;
          last = -1;
          active = 0;
        }
      }
      flush();
    }
  }
  return findings;
}

function currentSegment(project: Project, finding: UnattributedSpeech): Segment {
  const segment = project.segments.find((s) => s.id === finding.segmentId);
  if (
    !segment ||
    finding.sourceIn < segment.sourceIn ||
    finding.sourceOut > segment.sourceOut ||
    !Number.isFinite(finding.sourceIn) ||
    !Number.isFinite(finding.sourceOut) ||
    finding.sourceOut <= finding.sourceIn ||
    segment.words.some((word) => word.start < finding.sourceOut && word.end > finding.sourceIn)
  )
    throw new Error(
      "This audio range changed or is already attributed. Analyze the timeline again.",
    );
  return segment;
}
function finish(project: Project, next: Project): Project {
  next = reconcileFillerReview(next);
  next = reconcileScriptReview(rebaseReviewContexts(project, next));
  validateProjectTranscripts(next);
  return { ...next, updatedAt: new Date().toISOString() };
}

/** Add recognition only in this occurrence's uncovered window; preserve every existing run. */
export function insertGapTranscript(
  project: Project,
  finding: UnattributedSpeech,
  recognition: Word[],
): Project {
  const normalized = normalizeProjectTranscripts(project);
  const segment = currentSegment(normalized, finding);
  const words = recognition
    .filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({
      ...w,
      id: uuid(),
      start: Math.max(w.start, finding.sourceIn),
      end: Math.min(w.end, finding.sourceOut),
    }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  if (!words.length)
    throw new Error("No speech was recognized in this range. Listen again or dismiss the finding.");
  const metadata = segment.transcript ?? normalizeTranscript(segment);
  const newBlocks = normalizeTranscript({
    ...segment,
    id: uuid(),
    words,
    transcript: undefined,
  }).blocks;
  const allWords = [...segment.words, ...words].sort((a, b) => a.start - b.start);
  const originalById = new Map([...metadata.originals, ...words].map((w) => [w.id, w]));
  // Insert at run boundaries, splitting a paragraph when the gap lies inside it.
  // Sorting whole paragraphs would put new anchors after later existing words.
  const units = [...metadata.blocks, ...newBlocks]
    .flatMap((block) => block.runs.map((run) => ({ blockId: block.id, run })))
    .sort(
      (a, b) =>
        originalById.get(a.run.anchorIds[0]!)!.start - originalById.get(b.run.anchorIds[0]!)!.start,
    );
  const blocks: TranscriptBlock[] = [];
  const used = new Set<string>();
  let lastBlockId: string | undefined;
  for (const unit of units) {
    if (unit.blockId !== lastBlockId) {
      blocks.push({ id: used.has(unit.blockId) ? uuid() : unit.blockId, runs: [] });
      used.add(unit.blockId);
      lastBlockId = unit.blockId;
    }
    blocks.at(-1)!.runs.push(unit.run);
  }
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i]!.runs.some((r) => r.text.trim())) continue;
    const empty = blocks.splice(i, 1)[0]!;
    if (i > 0) blocks[i - 1]!.runs.push(...empty.runs);
    else blocks[0]!.runs.unshift(...empty.runs);
    i--;
  }
  return finish(project, {
    ...normalized,
    segments: normalized.segments.map((s) =>
      s.id !== segment.id
        ? s
        : {
            ...segment,
            words: allWords,
            transcript: {
              ...metadata,
              originals: allWords.map((w) => originalById.get(w.id)!),
              blocks,
            },
          },
    ),
  });
}

/** Keep timing extensions on a visible run when a sentence has hidden edge words. */
function attachTimingAnchor(
  block: TranscriptBlock,
  anchor: Word,
  side: "start" | "end",
): TranscriptBlock {
  const runs = block.runs;
  let index = side === "start" ? 0 : runs.length - 1;
  if (side === "start") {
    while (index < runs.length - 1 && runs[index]!.text === "") index++;
    const anchors = runs.slice(0, index + 1).flatMap((run) => run.anchorIds);
    return {
      ...block,
      runs: runs
        .slice(index)
        .map((run, i) => (i ? run : { ...run, anchorIds: [anchor.id, ...anchors] })),
    };
  }
  while (index > 0 && runs[index]!.text === "") index--;
  const anchors = runs.slice(index).flatMap((run) => run.anchorIds);
  return {
    ...block,
    runs: runs
      .slice(0, index + 1)
      .map((run, i) => (i !== index ? run : { ...run, anchorIds: [...anchors, anchor.id] })),
  };
}

/** Add an explicit audio anchor to the first run; existing recognition timestamps
 * remain immutable, and the existing sentence text is preserved verbatim.
 */
export function extendSentenceStart(project: Project, finding: UnattributedSpeech): Project {
  const normalized = normalizeProjectTranscripts(project);
  const segment = currentSegment(normalized, finding);
  if (finding.nextSegmentId && finding.nextSegmentId !== segment.id) {
    const index = normalized.segments.indexOf(segment);
    const target = normalized.segments[index + 1];
    const first = target?.transcript?.originals[0];
    if (
      !target ||
      target.id !== finding.nextSegmentId ||
      segment.words.length ||
      segment.fillerAudio ||
      target.fillerAudio ||
      target.mediaId !== segment.mediaId ||
      target.sourceIn !== segment.sourceOut ||
      !first ||
      first.start < target.sourceIn
    )
      throw new Error(
        "This sentence cannot be extended across an audio cut. Transcribe this range instead.",
      );
    // Coalesce only contiguous source audio with no text in the leading segment.
    // This preserves the exact output samples and leaves every existing anchor intact.
    const merged = {
      ...normalized,
      segments: normalized.segments.flatMap((s) =>
        s.id === segment.id
          ? []
          : s.id === target.id
            ? [
                {
                  ...target,
                  sourceIn: segment.sourceIn,
                  precise: segment.precise || target.precise,
                },
              ]
            : [s],
      ),
    };
    const extended = extendSentenceStart(merged, {
      ...finding,
      segmentId: target.id,
      nextSegmentId: target.id,
      gapEnd: first.start,
    });
    return finish(project, extended);
  }
  const metadata = segment.transcript;
  const block = metadata?.blocks.find((b) => b.id === finding.nextBlockId);
  const first = metadata?.originals.find((w) => w.id === block?.runs[0]?.anchorIds[0]);
  if (
    !metadata ||
    !block ||
    !first ||
    first.start <= finding.sourceIn ||
    Math.abs(first.start - finding.gapEnd) > 0.001 ||
    segment.words.some((w) => w.start < first.start && w.end > finding.sourceIn)
  )
    throw new Error("There is no following sentence in this audio segment that can be extended.");
  const anchor: Word = {
    id: uuid(),
    text: "",
    start: finding.sourceIn,
    end: first.start,
    confidence: 0,
  };
  const words = [...segment.words, anchor].sort((a, b) => a.start - b.start);
  const originals = [...metadata.originals, anchor].sort((a, b) => a.start - b.start);
  return finish(project, {
    ...normalized,
    segments: normalized.segments.map((s) =>
      s.id !== segment.id
        ? s
        : {
            ...segment,
            words,
            transcript: {
              ...metadata,
              originals,
              blocks: metadata.blocks.map((b) =>
                b.id !== block.id ? b : attachTimingAnchor(b, anchor, "start"),
              ),
            },
          },
    ),
  });
}

/** Extend only the timing of the preceding sentence, preserving its text and audio. */
export function extendSentenceEnd(project: Project, finding: UnattributedSpeech): Project {
  const normalized = normalizeProjectTranscripts(project);
  const segment = currentSegment(normalized, finding);
  if (finding.previousSegmentId && finding.previousSegmentId !== segment.id) {
    const index = normalized.segments.indexOf(segment);
    const target = normalized.segments[index - 1];
    const last = target?.transcript?.originals.at(-1);
    if (
      !target ||
      target.id !== finding.previousSegmentId ||
      segment.words.length ||
      segment.fillerAudio ||
      target.fillerAudio ||
      target.mediaId !== segment.mediaId ||
      target.sourceOut !== segment.sourceIn ||
      !last ||
      last.end > target.sourceOut
    )
      throw new Error(
        "This sentence cannot be extended across an audio cut. Transcribe this range instead.",
      );
    const merged = {
      ...normalized,
      segments: normalized.segments.flatMap((s) =>
        s.id === segment.id
          ? []
          : s.id === target.id
            ? [
                {
                  ...target,
                  sourceOut: segment.sourceOut,
                  precise: target.precise || segment.precise,
                },
              ]
            : [s],
      ),
    };
    return finish(
      project,
      extendSentenceEnd(merged, {
        ...finding,
        segmentId: target.id,
        previousSegmentId: target.id,
        gapStart: last.end,
      }),
    );
  }
  const metadata = segment.transcript;
  const block = metadata?.blocks.find((b) => b.id === finding.previousBlockId);
  const last = metadata?.originals.find((w) => w.id === block?.runs.at(-1)?.anchorIds.at(-1));
  if (
    !metadata ||
    !block ||
    !last ||
    last.end >= finding.sourceOut ||
    Math.abs(last.end - finding.gapStart) > 0.001 ||
    segment.words.some((w) => w.start < finding.sourceOut && w.end > last.end)
  )
    throw new Error("There is no preceding sentence in this audio segment that can be extended.");
  const anchor: Word = {
    id: uuid(),
    text: "",
    start: last.end,
    end: finding.sourceOut,
    confidence: 0,
  };
  const words = [...segment.words, anchor].sort((a, b) => a.start - b.start);
  const originals = [...metadata.originals, anchor].sort((a, b) => a.start - b.start);
  return finish(project, {
    ...normalized,
    segments: normalized.segments.map((s) =>
      s.id !== segment.id
        ? s
        : {
            ...segment,
            words,
            transcript: {
              ...metadata,
              originals,
              blocks: metadata.blocks.map((b) =>
                b.id !== block.id ? b : attachTimingAnchor(b, anchor, "end"),
              ),
            },
          },
    ),
  });
}
