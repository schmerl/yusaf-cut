import { v4 as uuid } from "uuid";
import { computeTimeline, type Project } from "./edl";
import { projectTranscript, validateProjectTranscripts } from "./transcript";
import { cutTranscriptRanges, reconcileTranscript, type TextRange } from "./transcriptEdits";
import { reconcileFillerReview } from "./fillerReview";
import { reconcileScriptReview, rebaseReviewContexts } from "./scriptLifecycle";

/** An explicit audio interval for a complete, contiguous transcript selection. */
export function buildTranscriptCut(
  project: Project,
  ranges: TextRange[],
  offsets = { startMs: 0, endMs: 0 },
) {
  if (!ranges.length) throw new Error("Select speech to cut.");
  // Reuse the text selection guards, including indivisible corrected phrases.
  cutTranscriptRanges(project, ranges);
  if (![offsets.startMs, offsets.endMs].every(Number.isFinite))
    throw new Error("Enter finite cut offsets in milliseconds.");
  const blocks = projectTranscript(project);
  const selected = new Map<string, Set<string>>();
  const runs = ranges
    .flatMap((range) => {
      const block = blocks.find((b) => b.segmentId === range.segmentId && b.id === range.blockId)!;
      const full = range.from === 0 && range.to === block.text.length;
      const touched = block.runs.filter(
        (run) => full || (run.to > range.from && run.from < range.to),
      );
      const ids = selected.get(range.segmentId) ?? new Set<string>();
      touched.forEach((run) => run.anchorIds.forEach((id) => ids.add(id)));
      selected.set(range.segmentId, ids);
      return touched;
    })
    .sort((a, b) => a.outputStart - b.outputStart);
  if (!runs.length) throw new Error("Select timed speech to cut.");
  const from = runs[0]!.outputStart;
  const to = Math.max(...runs.map((run) => run.outputEnd));
  const cutStart = from + offsets.startMs / 1000;
  const cutEnd = to + offsets.endMs / 1000;
  if (cutEnd <= cutStart) throw new Error("Cut end must be later than cut start.");
  const timeline = computeTimeline(project);
  const selectedEntries = timeline.filter((entry) => selected.has(entry.segmentId));
  const first = selectedEntries[0]!;
  const last = selectedEntries.at(-1)!;
  if (cutStart < first.outputStart || cutEnd > last.outputEnd)
    throw new Error("The proposed cut crosses an existing edit boundary.");
  // Offsets may trim the boundary words, but cannot leave whole selected words
  // audible after their text has been removed.
  if (cutStart >= runs[0]!.outputEnd || cutEnd <= runs.at(-1)!.outputStart)
    throw new Error("Keep the cut boundaries within the selected boundary words.");
  let overlapsNeighbor = false;
  const segments = project.segments.flatMap((segment) => {
    const entry = timeline.find((item) => item.segmentId === segment.id)!;
    if (entry.outputEnd <= cutStart || entry.outputStart >= cutEnd) return [segment];
    const start = Math.max(segment.sourceIn, segment.sourceIn + cutStart - entry.outputStart);
    const end = Math.min(segment.sourceOut, segment.sourceIn + cutEnd - entry.outputStart);
    const ids = selected.get(segment.id) ?? new Set<string>();
    const remaining = segment.words.filter((word) => !ids.has(word.id));
    if (remaining.some((word) => word.start < end && word.end > start)) overlapsNeighbor = true;
    return [
      [segment.sourceIn, start],
      [end, segment.sourceOut],
    ].flatMap(([sourceIn, sourceOut]) => {
      if (sourceOut! <= sourceIn!) return [];
      const words = remaining.filter((word) => word.end > sourceIn! && word.start < sourceOut!);
      const survivingIds = new Set(words.map((word) => word.id));
      // An explicit overlap may swallow some anchors of a neighboring corrected
      // phrase. Keep its displayed text with the surviving original anchors.
      // Ordinary transcript cuts still require complete timing groups.
      const source = segment.transcript
        ? {
            ...segment,
            transcript: {
              ...segment.transcript,
              blocks: segment.transcript.blocks.map((block) => ({
                ...block,
                runs: block.runs.map((run) => {
                  const anchorIds = run.anchorIds.filter((id) => survivingIds.has(id));
                  return anchorIds.length && anchorIds.length < run.anchorIds.length
                    ? { ...run, anchorIds }
                    : run;
                }),
              })),
            },
          }
        : segment;
      const fragment = reconcileTranscript(source, {
        ...segment,
        id: uuid(),
        sourceIn: sourceIn!,
        sourceOut: sourceOut!,
        words,
        precise: true,
      });
      return [words.length ? fragment : { ...fragment, transcript: undefined }];
    });
  });
  const result = reconcileScriptReview(
    reconcileFillerReview(
      rebaseReviewContexts(project, {
        ...project,
        segments,
        updatedAt: new Date().toISOString(),
      }),
    ),
  );
  validateProjectTranscripts(result);
  const warning = overlapsNeighbor
    ? "This cut overlaps neighboring speech, including text-hidden words. Neighboring words may be clipped or removed, and remaining text may no longer match the audio. Preview before cutting."
    : undefined;
  return { before: project, result, cutStart, cutEnd, joinOutput: cutStart, from, to, warning };
}
