import { v4 as uuid } from "uuid";
import { computeTimeline, type Project, type Segment, type Word } from "./edl";
import {
  fillerCandidates,
  occurrenceLineage,
  reconcileFillerReview,
  type FillerCandidate,
} from "./fillerReview";
import { defaultFillerPolicy, normalizeFillerTerm } from "./fillers";
import {
  normalizeProjectTranscripts,
  projectTranscript,
  validateProjectTranscripts,
} from "./transcript";
import {
  reconcileTranscript,
  replaceTranscriptBatch,
  replaceTranscriptText,
} from "./transcriptEdits";

/** Recognition provenance belongs only to wordless retained filler-edge audio. */
export interface FillerAudio {
  candidateId: string;
  rule: string;
  text: string;
  originals: Word[];
}
export interface FillerOffsets {
  startMs: number;
  endMs: number;
}
export interface FillerCutProposal {
  before: Project;
  result: Project;
  candidate: FillerCandidate;
  cutStart: number;
  cutEnd: number;
  joinOutput: number;
  retainedEdges: boolean;
  recognizedStart: number;
  recognizedEnd: number;
  earliestStart: number;
  latestEnd: number;
  timingWarning?: string;
}
function currentCandidate(project: Project, candidate: FillerCandidate): FillerCandidate {
  validateProjectTranscripts(project);
  const current = fillerCandidates(project).find(
    (c) => c.id === candidate.id && c.fingerprint === candidate.fingerprint,
  );
  if (!current) throw new Error("This occurrence changed. Select it again.");
  return current;
}
function finish(project: Project): Project {
  const next = reconcileFillerReview({ ...project, updatedAt: new Date().toISOString() });
  validateProjectTranscripts(next);
  return next;
}
export function setFillerDecision(
  project: Project,
  candidate: FillerCandidate,
  outcome: "kept" | null,
): Project {
  const current = currentCandidate(project, candidate);
  if (current.residual)
    throw new Error("These are retained audio edges. Use the timeline to edit them further.");
  if ((outcome === "kept" && current.outcome === "kept") || (outcome === null && !current.outcome))
    return project;
  const metadata = project.fillerReview ?? {
    version: 1 as const,
    policy: defaultFillerPolicy(),
    decisions: [],
  };
  const decisions = metadata.decisions.filter((d) => d.candidateId !== current.id);
  if (outcome)
    decisions.push({
      candidateId: current.id,
      fingerprint: current.fingerprint,
      mediaId: current.mediaId,
      occurrenceLineage: current.occurrenceLineage,
      anchorIds: current.anchorIds,
      outcome,
    });
  return finish({ ...project, fillerReview: { ...metadata, decisions } });
}

/** Entire recognized tokens include their punctuation; grouped substrings remain exact. */
export function removeFillerText(project: Project, candidate: FillerCandidate): Project {
  const current = currentCandidate(project, candidate);
  if (current.hidden)
    throw new Error("Text removed, audio retained. There is no text to remove again.");
  const block = projectTranscript(project).find(
    (b) => b.id === current.blockId && b.segmentId === current.segmentId,
  )!;
  const runs = block.runs.filter((r) => r.to > current.from && r.from < current.to);
  const wholeRuns = normalizeFillerTerm(runs.map((r) => r.text).join(" ")) === current.rule;
  // Keep independent timing runs independent when hiding a whole phrase. A
  // single replacement would merge them and unnecessarily forbid its later cut.
  const next = wholeRuns
    ? replaceTranscriptBatch(
        project,
        project,
        runs.map((run) => ({
          segmentId: current.segmentId,
          blockId: current.blockId,
          from: run.from,
          to: run.to,
          text: "",
        })),
      )
    : replaceTranscriptText(project, {
        segmentId: current.segmentId,
        blockId: current.blockId,
        from: current.from,
        to: current.to,
        text: "",
      });
  const hidden = fillerCandidates(next).find((c) => c.id === current.id && c.hidden);
  if (!hidden) return next; // Grouped substring edits can change timing-group identity.
  const metadata = next.fillerReview ?? {
    version: 1 as const,
    policy: defaultFillerPolicy(),
    decisions: [],
  };
  return finish({
    ...next,
    fillerReview: {
      ...metadata,
      decisions: [
        ...metadata.decisions.filter((d) => d.candidateId !== hidden.id),
        {
          candidateId: hidden.id,
          fingerprint: hidden.fingerprint,
          mediaId: hidden.mediaId,
          occurrenceLineage: hidden.occurrenceLineage,
          anchorIds: hidden.anchorIds,
          outcome: "text-removed",
        },
      ],
    },
  });
}

/** A complete immutable alternate timeline. No store write and no legacy padding. */
export function buildFillerCutProposal(
  project: Project,
  candidate: FillerCandidate,
  offsets: FillerOffsets,
): FillerCutProposal {
  const current = currentCandidate(project, candidate);
  if (current.residual)
    throw new Error(
      "Retained edges cross an existing cut. Use explicit timeline cuts to edit them further.",
    );
  if (current.grouped)
    throw new Error(
      "This filler shares a corrected timing group with other words. An isolated speech cut is unavailable.",
    );
  if (!Number.isFinite(offsets.startMs) || !Number.isFinite(offsets.endMs))
    throw new Error("Enter finite millisecond offsets.");
  const normalized = normalizeProjectTranscripts(project);
  const source = normalized.segments.find((s) => s.id === current.segmentId)!;
  const ids = new Set(current.anchorIds);
  const originals = source.words.filter((w) => ids.has(w.id));
  const recognizedStart = Math.min(...originals.map((w) => w.start));
  const recognizedEnd = Math.max(...originals.map((w) => w.end));
  const recognizedMs = (recognizedEnd - recognizedStart) * 1000;
  // An advisory for one/two very short alignment frames, not a linguistic
  // minimum or permission to widen a cut automatically. Keep raw anchors intact.
  const timingWarning =
    recognizedMs <= 40 + 1e-6
      ? `Recognition assigned only ${recognizedMs.toFixed(0)} ms to this filler. This may cover only part of its sound. Check that the preview removes the audible filler.`
      : originals.some((w) => w.confidence === 0)
        ? "Recognition marked this occurrence as uncertain. Check its audio boundaries before cutting."
        : undefined;
  const cutStart = recognizedStart + offsets.startMs / 1000;
  const cutEnd = recognizedEnd + offsets.endMs / 1000;
  if (cutEnd <= cutStart) throw new Error("Cut end must be later than cut start.");
  if (cutStart < source.sourceIn || cutEnd > source.sourceOut)
    throw new Error("The proposed cut crosses an existing edit boundary.");
  const firstIndex = source.words.findIndex((w) => ids.has(w.id));
  const lastIndex = source.words.reduce((last, w, i) => (ids.has(w.id) ? i : last), -1);
  if (source.words.slice(firstIndex, lastIndex + 1).some((w) => !ids.has(w.id)))
    throw new Error("The occurrence is interrupted by other speech.");
  const previous = source.words.slice(0, firstIndex);
  const following = source.words.slice(lastIndex + 1);
  if (previous.some((w) => w.end > cutStart) || following.some((w) => w.start < cutEnd))
    throw new Error(
      "The proposed cut overlaps a neighboring word, including text-hidden speech. Adjust the boundaries.",
    );
  const retainedEdges =
    cutStart > Math.max(source.sourceIn, recognizedStart) ||
    cutEnd < Math.min(source.sourceOut, recognizedEnd);
  const block = source.transcript!.blocks.find((b) => b.id === current.blockId)!;
  if (!block.runs.some((r) => r.text.trim() && r.anchorIds.some((id) => !ids.has(id)))) {
    const blockWords = source.transcript!.originals.filter((w) =>
      block.runs.some((r) => r.anchorIds.includes(w.id)),
    );
    if (retainedEdges || blockWords.some((w) => !ids.has(w.id)))
      throw new Error(
        "A spoken paragraph must retain text. Cut the whole paragraph or restore its text.",
      );
  }
  const fragments: Segment[] = [];
  const ordinary = (sourceIn: number, sourceOut: number) => {
    if (sourceOut <= sourceIn) return;
    const words = source.words.filter(
      (w) => !ids.has(w.id) && w.end > sourceIn && w.start < sourceOut,
    );
    const target = reconcileTranscript(source, {
      id: uuid(),
      mediaId: source.mediaId,
      words,
      sourceIn,
      sourceOut,
      precise: true,
    });
    // Wordless gaps have no spoken paragraph overlay.
    fragments.push(words.length ? target : { ...target, transcript: undefined });
  };
  const edge = (sourceIn: number, sourceOut: number) => {
    if (sourceOut <= sourceIn) return;
    fragments.push({
      id: uuid(),
      mediaId: source.mediaId,
      words: [],
      sourceIn,
      sourceOut,
      occurrenceLineage: occurrenceLineage(source),
      precise: true,
      fillerAudio: { candidateId: current.id, rule: current.rule, text: current.text, originals },
    });
  };
  ordinary(source.sourceIn, Math.min(cutStart, recognizedStart));
  edge(Math.max(source.sourceIn, recognizedStart), cutStart);
  edge(cutEnd, Math.min(source.sourceOut, recognizedEnd));
  ordinary(Math.max(cutEnd, recognizedEnd), source.sourceOut);
  const result = finish({
    ...normalized,
    segments: normalized.segments
      .flatMap((s) => (s.id === source.id ? fragments : [s]))
      .map((s) => (s.precise ? s : { ...s, precise: true })),
  });
  const entry = computeTimeline(project).find((e) => e.segmentId === source.id)!;
  return {
    before: project,
    result,
    candidate: current,
    cutStart,
    cutEnd,
    joinOutput: entry.outputStart + cutStart - source.sourceIn,
    retainedEdges,
    recognizedStart,
    recognizedEnd,
    earliestStart: previous.reduce((limit, word) => Math.max(limit, word.end), source.sourceIn),
    latestEnd: following.reduce((limit, word) => Math.min(limit, word.start), source.sourceOut),
    timingWarning,
  };
}
