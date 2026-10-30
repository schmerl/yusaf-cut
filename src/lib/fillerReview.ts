import { computeTimeline, type Project, type Segment } from "./edl";
import { projectTranscript, type ProjectedRun } from "./transcript";
import {
  defaultFillerPolicy,
  fillerTokens,
  matchFillers,
  normalizeFillerPolicy,
  normalizeFillerTerm,
  type FillerPolicy,
} from "./fillers";

export interface FillerDecision {
  candidateId: string;
  fingerprint: string;
  mediaId: string;
  occurrenceLineage: string;
  anchorIds: string[];
  outcome: "kept" | "text-removed";
}
export interface FillerReviewMetadata {
  version: 1;
  policy: FillerPolicy;
  decisions: FillerDecision[];
}
export interface FillerCandidate {
  id: string;
  fingerprint: string;
  rule: string;
  text: string;
  segmentId: string;
  blockId: string;
  mediaId: string;
  occurrenceLineage: string;
  anchorIds: string[];
  from: number;
  to: number;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  hidden: boolean;
  grouped: boolean;
  residual?: boolean;
  outcome?: FillerDecision["outcome"];
}

function decisionMatches(decision: FillerDecision, candidate: FillerCandidate): boolean {
  return (
    decision.candidateId === candidate.id &&
    decision.fingerprint === candidate.fingerprint &&
    decision.mediaId === candidate.mediaId &&
    decision.occurrenceLineage === candidate.occurrenceLineage &&
    JSON.stringify(decision.anchorIds) === JSON.stringify(candidate.anchorIds) &&
    (decision.outcome === "kept" || (decision.outcome === "text-removed" && candidate.hidden))
  );
}

/** Splits retain this identity; new placements/recognition must receive a new one. */
export function occurrenceLineage(segment: Segment): string {
  return (
    segment.occurrenceLineage ?? segment.transcript?.occurrenceId ?? `transcript:${segment.id}`
  );
}

/** Pure projection. Hidden baselines are consulted only for entirely empty runs. */
export function fillerCandidates(project: Project): FillerCandidate[] {
  const policy = project.fillerReview?.policy ?? defaultFillerPolicy();
  // Validation of review records must not recursively project them.
  const blocks = projectTranscript({ ...project, fillerReview: undefined });
  const candidates: FillerCandidate[] = [];
  for (const block of blocks) {
    const segment = project.segments.find((s) => s.id === block.segmentId)!;
    const lineage = occurrenceLineage(segment);
    const emit = (text: string, runs: ProjectedRun[], hidden: boolean, base: number) => {
      for (const match of matchFillers(text, policy)) {
        const coordinateBase = hidden ? 0 : base;
        const affected = runs.filter(
          (r) => r.to > match.from + coordinateBase && r.from < match.to + coordinateBase,
        );
        if (!affected.length) continue;
        const anchorIds = affected.flatMap((r) => r.anchorIds);
        // Match offsets are local to the timing group, never to a paragraph/segment.
        const localFrom = fillerTokens(
          affected[0]!.text.slice(0, match.from + coordinateBase - affected[0]!.from),
        ).length;
        const id = JSON.stringify([
          project.id,
          block.mediaId,
          lineage,
          anchorIds,
          match.rule,
          localFrom,
        ]);
        const grouped =
          affected.some((r) =>
            block.runs.some((original) => original.id === r.id && original.anchorIds.length > 1),
          ) ||
          (!hidden && normalizeFillerTerm(affected.map((r) => r.text).join(" ")) !== match.rule);
        const fingerprint = JSON.stringify([
          hidden,
          affected.map((r) => [r.anchorIds, hidden ? r.originalText : r.text]),
          match.rule,
          localFrom,
          affected.map((r) => block.runs.find((original) => original.id === r.id)!.anchorIds),
        ]);
        candidates.push({
          id,
          fingerprint,
          rule: match.rule,
          text: text.slice(match.from, match.to),
          segmentId: block.segmentId,
          blockId: block.id,
          mediaId: block.mediaId,
          occurrenceLineage: lineage,
          anchorIds,
          from: hidden ? base : match.from + base,
          to: hidden ? base : match.to + base,
          sourceStart: Math.min(...affected.map((r) => r.sourceStart)),
          sourceEnd: Math.max(...affected.map((r) => r.sourceEnd)),
          outputStart: Math.min(...affected.map((r) => r.outputStart)),
          outputEnd: Math.max(...affected.map((r) => r.outputEnd)),
          hidden,
          grouped,
        });
      }
    };
    // Hidden audio interrupts visible text; never bridge the two with a phrase.
    let region: ProjectedRun[] = [];
    const flush = () => {
      if (!region.length) return;
      const base = region[0]!.from;
      if (region[0]!.text.trim())
        emit(block.text.slice(base, region.at(-1)!.to), region, false, base);
      else {
        let text = "";
        const originals = segment.transcript?.originals ?? segment.words;
        const hiddenRuns = region.flatMap((run) =>
          run.anchorIds.map((id) => {
            const word = originals.find((w) => w.id === id)!;
            if (text) text += " ";
            const from = text.length;
            text += word.text;
            const sourceStart = Math.max(segment.sourceIn, word.start);
            const sourceEnd = Math.min(segment.sourceOut, word.end);
            return {
              ...run,
              text: word.text,
              originalText: word.text,
              anchorIds: [id],
              from,
              to: text.length,
              sourceStart,
              sourceEnd,
              outputStart: run.outputStart + sourceStart - run.sourceStart,
              outputEnd: run.outputStart + sourceEnd - run.sourceStart,
            };
          }),
        );
        emit(text, hiddenRuns, true, base);
      }
      region = [];
    };
    for (const run of block.runs) {
      if (region.length && Boolean(region[0]!.text.trim()) !== Boolean(run.text.trim())) flush();
      region.push(run);
    }
    flush();
  }
  const residuals = new Map<string, FillerCandidate>();
  for (const entry of computeTimeline(project)) {
    const segment = project.segments.find((s) => s.id === entry.segmentId)!;
    const audio = segment.fillerAudio;
    if (!audio) continue;
    const previous = residuals.get(audio.candidateId);
    const candidate: FillerCandidate = previous ?? {
      id: audio.candidateId,
      fingerprint: "",
      rule: audio.rule,
      text: audio.text,
      segmentId: segment.id,
      blockId: "",
      mediaId: segment.mediaId,
      occurrenceLineage: occurrenceLineage(segment),
      anchorIds: audio.originals.map((w) => w.id),
      from: 0,
      to: 0,
      sourceStart: segment.sourceIn,
      sourceEnd: segment.sourceOut,
      outputStart: entry.outputStart,
      outputEnd: entry.outputEnd,
      hidden: true,
      grouped: false,
      residual: true,
      outcome: "text-removed",
    };
    candidate.sourceEnd = segment.sourceOut;
    candidate.outputEnd = entry.outputEnd;
    candidate.fingerprint += JSON.stringify([segment.id, segment.sourceIn, segment.sourceOut]);
    residuals.set(audio.candidateId, candidate);
  }
  candidates.push(...residuals.values());
  const decisions = new Map(project.fillerReview?.decisions.map((d) => [d.candidateId, d]));
  return candidates
    .sort((a, b) => a.outputStart - b.outputStart || a.from - b.from)
    .map((c) => {
      const decision = decisions.get(c.id);
      return decision && decisionMatches(decision, c) ? { ...c, outcome: decision.outcome } : c;
    });
}

/** Drop incompatible decisions in the same transaction as an ordinary edit. */
export function reconcileFillerReview(project: Project): Project {
  if (!project.fillerReview?.decisions.length) return project;
  const candidates = new Map(fillerCandidates(project).map((c) => [c.id, c]));
  const decisions = project.fillerReview.decisions.filter((d) => {
    const candidate = candidates.get(d.candidateId);
    return candidate && decisionMatches(d, candidate);
  });
  return decisions.length === project.fillerReview.decisions.length
    ? project
    : {
        ...project,
        fillerReview: { ...project.fillerReview, decisions },
      };
}

/** Strict load/save validation. Neither timestamps nor stale records authorize actions. */
export function validateFillerReview(project: Project): void {
  const metadata = project.fillerReview;
  const seenEdges = new Map<string, { originals: string; ranges: [number, number][] }>();
  const seen = new Map<string, { mediaId: string; ids: Set<string> }>();
  for (const segment of project.segments) {
    const audio = segment.fillerAudio;
    if (
      audio &&
      (segment.precise !== true ||
        !segment.occurrenceLineage ||
        !project.media[segment.mediaId] ||
        segment.words.length ||
        segment.transcript ||
        !audio.candidateId ||
        !audio.rule ||
        !audio.text ||
        !audio.originals.length ||
        audio.originals.some(
          (w) =>
            !w.id ||
            typeof w.text !== "string" ||
            !Number.isFinite(w.confidence) ||
            w.confidence < 0 ||
            w.confidence > 1 ||
            !Number.isFinite(w.start) ||
            w.start < 0 ||
            !Number.isFinite(w.end) ||
            w.end <= w.start,
        ) ||
        segment.sourceIn < Math.min(...audio.originals.map((w) => w.start)) ||
        segment.sourceOut > Math.max(...audio.originals.map((w) => w.end)))
    )
      throw new Error("Invalid retained filler audio provenance.");
    if (audio) {
      const originals = JSON.stringify(
        audio.originals.map((w) => [w.id, w.text, w.start, w.end, w.confidence, w.speaker ?? null]),
      );
      const previous = seenEdges.get(audio.candidateId) ?? { originals, ranges: [] };
      if (
        previous.originals !== originals ||
        previous.ranges.some(([from, to]) => from < segment.sourceOut && to > segment.sourceIn)
      )
        throw new Error(
          "Ambiguous or duplicated retained filler edges. Repeated placements require fresh lineage.",
        );
      previous.ranges.push([segment.sourceIn, segment.sourceOut]);
      seenEdges.set(audio.candidateId, previous);
    }
    const lineage = occurrenceLineage(segment);
    if (
      audio &&
      audio.candidateId !==
        JSON.stringify([
          project.id,
          segment.mediaId,
          lineage,
          audio.originals.map((w) => w.id),
          audio.rule,
          0,
        ])
    )
      throw new Error("Retained filler audio belongs to a different occurrence.");
    if (typeof lineage !== "string" || !lineage.trim() || lineage.length > 1000)
      throw new Error("Invalid occurrence lineage.");
    if (
      segment.occurrenceLineage !== undefined &&
      (!Number.isFinite(segment.sourceIn) ||
        !Number.isFinite(segment.sourceOut) ||
        segment.sourceIn < 0 ||
        segment.sourceOut <= segment.sourceIn)
    )
      throw new Error("Invalid occurrence source interval.");
    const previous = seen.get(lineage) ?? {
      mediaId: segment.mediaId,
      ids: new Set<string>(),
    };
    if (previous.mediaId !== segment.mediaId)
      throw new Error("Repeated media placements must have distinct occurrence lineage.");
    for (const word of segment.words) {
      if (previous.ids.has(word.id))
        throw new Error(
          "Ambiguous duplicate occurrence anchors: repeated placements need distinct lineage.",
        );
      previous.ids.add(word.id);
    }
    seen.set(lineage, previous);
  }
  if (!metadata) return;
  if (
    metadata.version !== 1 ||
    !Array.isArray(metadata.decisions) ||
    metadata.decisions.length > 100000
  )
    throw new Error("Invalid filler review metadata.");
  const policy = normalizeFillerPolicy(metadata.policy);
  if (
    JSON.stringify(policy.optional) !== JSON.stringify(metadata.policy.optional) ||
    JSON.stringify(policy.custom) !== JSON.stringify(metadata.policy.custom)
  )
    throw new Error("Filler policy must be normalized.");
  const candidates = new Map(fillerCandidates(project).map((c) => [c.id, c]));
  const ids = new Set<string>();
  for (const decision of metadata.decisions) {
    const candidate = candidates.get(decision.candidateId);
    if (!candidate || ids.has(decision.candidateId) || !decisionMatches(decision, candidate))
      throw new Error("Invalid or stale filler review decision.");
    ids.add(decision.candidateId);
  }
}

/** Policy is a project edit; reading candidates is not. Commit through normal history. */
export function withFillerPolicy(project: Project, policy: FillerPolicy): Project {
  const normalized = normalizeFillerPolicy(policy);
  const previous = project.fillerReview?.policy ?? defaultFillerPolicy();
  if (
    JSON.stringify(normalized.optional) === JSON.stringify(previous.optional) &&
    JSON.stringify(normalized.custom) === JSON.stringify(previous.custom)
  )
    return project;
  return reconcileFillerReview({
    ...project,
    updatedAt: new Date().toISOString(),
    fillerReview: {
      version: 1,
      policy: normalized,
      decisions: project.fillerReview?.decisions ?? [],
    },
  });
}
