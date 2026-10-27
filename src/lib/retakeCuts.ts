import { v4 as uuid } from "uuid";
import { computeTimeline, totalDuration, type Project } from "./edl";
import { normalizeProjectTranscripts, validateProjectTranscripts } from "./transcript";
import { reconcileTranscript } from "./transcriptEdits";
import { retakeRecords, type RetakeCandidate, type RetakeRecord } from "./retakes";

export interface OccurrenceRemoval {
  segmentId: string;
  start: number;
  end: number;
}
export interface AuditionRange {
  start: number;
  end: number;
}
export interface RetakeCutPlan {
  before: Project;
  nextProject: Project;
  removals: OccurrenceRemoval[];
  recordRemap: Map<string, string>;
  originalAudition: AuditionRange;
  editedAudition: AuditionRange;
}
function fail(message: string): never {
  throw new Error(message);
}

/** Explicit source intervals are scoped to ONE output occurrence. */
export function removeOccurrenceIntervals(project: Project, removals: OccurrenceRemoval[]) {
  const normalized = normalizeProjectTranscripts(project);
  const descendants = new Map<string, string[]>();
  for (const removal of removals) {
    const segment = normalized.segments.find((s) => s.id === removal.segmentId);
    if (
      !segment ||
      !Number.isFinite(removal.start) ||
      !Number.isFinite(removal.end) ||
      removal.start < segment.sourceIn ||
      removal.end > segment.sourceOut ||
      removal.start >= removal.end
    )
      fail("The proposed cut no longer matches this passage. Run detection again.");
  }
  const nextProject = {
    ...normalized,
    updatedAt: new Date().toISOString(),
    segments: normalized.segments.flatMap((segment) => {
      const cuts = removals
        .filter((r) => r.segmentId === segment.id)
        .sort((a, b) => a.start - b.start);
      if (!cuts.length) {
        descendants.set(segment.id, [segment.id]);
        return [segment];
      }
      const merged: { start: number; end: number }[] = [];
      for (const cut of cuts) {
        const previous = merged.at(-1);
        if (previous && cut.start <= previous.end) previous.end = Math.max(previous.end, cut.end);
        else merged.push({ start: cut.start, end: cut.end });
      }
      // A cut must contain a complete surviving anchor or none of its audio.
      for (const word of segment.words) {
        const a = Math.max(word.start, segment.sourceIn),
          b = Math.min(word.end, segment.sourceOut);
        for (const cut of merged)
          if (a < cut.end && b > cut.start && !(a >= cut.start && b <= cut.end))
            fail("This cut would clip a spoken word. Review a different take.");
      }
      const keeps: { start: number; end: number }[] = [];
      let cursor = segment.sourceIn;
      for (const cut of merged) {
        if (cut.start > cursor) keeps.push({ start: cursor, end: cut.start });
        cursor = cut.end;
      }
      if (cursor < segment.sourceOut) keeps.push({ start: cursor, end: segment.sourceOut });
      const segments = keeps.map((keep) =>
        reconcileTranscript(segment, {
          id: uuid(),
          mediaId: segment.mediaId,
          sourceIn: keep.start,
          sourceOut: keep.end,
          words: segment.words.filter((w) => w.end > keep.start && w.start < keep.end),
        }),
      );
      descendants.set(
        segment.id,
        segments.map((s) => s.id),
      );
      return segments;
    }),
  };
  validateProjectTranscripts(nextProject);
  const recordRemap = new Map<string, string>();
  const after = retakeRecords(nextProject);
  for (const before of retakeRecords(project)) {
    const allowed = descendants.get(before.segmentId) ?? [];
    const matches = after.filter(
      (r) =>
        allowed.includes(r.segmentId) &&
        r.runId === before.runId &&
        r.text === before.text &&
        r.originalText === before.originalText &&
        r.sourceStart === before.sourceStart &&
        r.sourceEnd === before.sourceEnd &&
        JSON.stringify(r.anchorIds) === JSON.stringify(before.anchorIds),
    );
    if (matches.length === 1) recordRemap.set(before.id, matches[0]!.id);
  }
  return { nextProject, recordRemap };
}

function candidateRecords(project: Project, candidate: RetakeCandidate) {
  const records = retakeRecords(project);
  const first = records.findIndex((r) => r.id === candidate.envelopeIds[0]);
  const envelope = records.slice(first, first + candidate.envelopeIds.length);
  if (
    first < 0 ||
    envelope.length !== candidate.envelopeIds.length ||
    envelope.some((r, i) => r.id !== candidate.envelopeIds[i]) ||
    envelope.some((r) => r.sequence !== envelope[0]!.sequence)
  )
    fail("This candidate changed. Run detection again.");
  const envelopeIds = new Set(candidate.envelopeIds);
  const all = [...candidate.attempts.flatMap((a) => a.recordIds), ...candidate.markerIds];
  if (
    candidate.attempts.length < 2 ||
    all.some((id) => !envelopeIds.has(id)) ||
    new Set(all).size !== all.length
  )
    fail("Invalid competing speech spans.");
  return { records, envelope, first };
}

export function planRetakeCut(
  project: Project,
  candidate: RetakeCandidate,
  keptAttemptId: string,
): RetakeCutPlan {
  const { records, envelope, first } = candidateRecords(project, candidate);
  const kept =
    candidate.attempts.find((a) => a.id === keptAttemptId) ?? fail("Choose a take to keep.");
  const dropped = new Set([
    ...candidate.markerIds,
    ...candidate.attempts.filter((a) => a !== kept).flatMap((a) => a.recordIds),
  ]);
  const pad = Math.max(0, project.settings.paddingMs) / 1000;
  const timeline = computeTimeline(project);
  const removals: OccurrenceRemoval[] = [];
  const outputCuts: AuditionRange[] = [];
  for (let i = 0; i < envelope.length; i++) {
    if (!dropped.has(envelope[i]!.id)) continue;
    const a = i;
    while (i + 1 < envelope.length && dropped.has(envelope[i + 1]!.id)) i++;
    const head = envelope[a]!,
      tail = envelope[i]!;
    const previous = records[first + a - 1],
      next = records[first + i + 1];
    if ((previous && previous.end > head.start) || (next && next.start < tail.end))
      fail("Word timings overlap at this join. A safe cut cannot be proposed.");
    // Join to surviving speech in the same recording, including the shared
    // continuation just outside the competing spans. Do not trim into another
    // imported recording on either side of the candidate.
    const previousIsRelated = previous?.sequence === head.sequence;
    const nextIsRelated = next?.sequence === tail.sequence;
    const start = previousIsRelated
      ? Math.min(head.start, previous.end + pad)
      : Math.max(0, head.start - pad);
    const end = nextIsRelated
      ? Math.max(tail.end, next.start - pad)
      : Math.min(totalDuration(project), tail.end + pad);
    outputCuts.push({ start, end });
    for (const entry of timeline) {
      const from = Math.max(entry.outputStart, start),
        to = Math.min(entry.outputEnd, end);
      if (from >= to) continue;
      removals.push({
        segmentId: entry.segmentId,
        start: entry.sourceIn + from - entry.outputStart,
        end: entry.sourceIn + to - entry.outputStart,
      });
    }
  }
  // Never remove hidden or unrelated audible speech as a side effect of padding.
  for (const record of records) {
    if (dropped.has(record.id)) continue;
    if (
      removals.some(
        (r) =>
          r.segmentId === record.segmentId &&
          r.start < record.sourceEnd &&
          r.end > record.sourceStart,
      )
    )
      fail("This proposal would remove shared or unrelated speech.");
  }
  const { nextProject, recordRemap } = removeOccurrenceIntervals(project, removals);
  const originalAudition = {
    start: Math.max(0, envelope[0]!.start - 2),
    end: Math.min(totalDuration(project), envelope.at(-1)!.end + 2),
  };
  const mapTime = (time: number) =>
    time -
    outputCuts.reduce((sum, cut) => sum + Math.max(0, Math.min(time, cut.end) - cut.start), 0);
  return {
    before: project,
    nextProject,
    removals,
    recordRemap,
    originalAudition,
    editedAudition: { start: mapTime(originalAudition.start), end: mapTime(originalAudition.end) },
  };
}

/** Only call for our own known transaction, never an arbitrary project edit. */
export function rebaseRetake(
  candidate: RetakeCandidate,
  plan: RetakeCutPlan,
): RetakeCandidate | null {
  const map = (ids: string[]) => ids.map((id) => plan.recordRemap.get(id));
  const envelope = map(candidate.envelopeIds);
  const markers = map(candidate.markerIds);
  if (envelope.some((id) => !id) || markers.some((id) => !id)) return null;
  const attempts = candidate.attempts.map((a) => ({
    ...a,
    recordIds: map(a.recordIds) as string[],
  }));
  if (attempts.some((a) => a.recordIds.some((id) => !id))) return null;
  const rebased = {
    ...candidate,
    envelopeIds: envelope as string[],
    markerIds: markers as string[],
    attempts,
  };
  try {
    const { records } = candidateRecords(plan.nextProject, rebased);
    const byId = new Map<string, RetakeRecord>(records.map((r) => [r.id, r]));
    for (let i = 1; i < attempts.length; i++)
      if (
        byId.get(attempts[i]!.recordIds[0]!)!.start -
          byId.get(attempts[i - 1]!.recordIds[0]!)!.start >
        30
      )
        return null;
    return rebased;
  } catch {
    return null;
  }
}
