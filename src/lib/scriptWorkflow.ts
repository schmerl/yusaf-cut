import { projectSession, useProjectStore } from "@/stores/projectStore";
import type { Project } from "./edl";
import type { TextRange } from "./transcriptEdits";
import {
  scriptCandidateBatches,
  SCRIPT_MATCH_POLICY,
  type ScriptCandidate,
} from "./scriptMatching";
import { scriptHash } from "./scriptMarkdown";
import type { ScriptReviewRecord } from "./scriptAssistance";
import { projectTranscript } from "./transcript";
import {
  analyzeScriptAudio,
  cancelScriptAnalysis,
  onScriptProgress,
  type ScriptAudioWindow,
  type WhisperModel,
} from "./ipc";

export function createScriptRun() {
  const run = {
    id: crypto.randomUUID(),
    cancelled: false,
    started: false,
    cancel() {
      run.cancelled = true;
      if (run.started) void cancelScriptAnalysis(run.id).catch(() => {});
    },
  };
  return run;
}
export type ScriptRun = ReturnType<typeof createScriptRun>;

export function scriptAudioWindows(
  project: Project,
  candidates: ScriptCandidate[],
): ScriptAudioWindow[] {
  const windows: ScriptAudioWindow[] = [];
  for (const segment of project.segments) {
    const selected = candidates
      .filter((c) => c.segmentId === segment.id)
      .sort((a, b) => a.sourceIn - b.sourceIn);
    for (const candidate of selected) {
      const from = Math.max(segment.sourceIn, candidate.sourceIn - 1.5),
        to = Math.min(segment.sourceOut, candidate.sourceOut + 1.5);
      for (let start = from; start < to; start += 30) {
        const end = Math.min(to, start + 30);
        const previous = windows.at(-1);
        if (
          previous &&
          previous.segmentId === segment.id &&
          start <= previous.sourceOut &&
          end - previous.sourceIn <= 30
        )
          previous.sourceOut = Math.max(previous.sourceOut, end);
        else windows.push({ segmentId: segment.id, sourceIn: start, sourceOut: end });
      }
    }
  }
  return windows;
}

/** All analysis and record creation are staged; no mutation until the final
 * project/session/script check and one normal undoable store transaction.
 * Production automatic wording application is gated pending acoustic evaluation.
 */
export async function runScriptReconciliation(
  run: ScriptRun,
  scope: TextRange[] | undefined,
  model: WhisperModel,
  progress: (completed: number, total: number) => void,
  isComposing?: () => boolean,
) {
  const expected = useProjectStore.getState().project,
    session = projectSession();
  const revision = expected.scriptAssistance?.activeRevision;
  let invalidated = false;
  function current() {
    if (run.cancelled) throw new Error("Reconciliation cancelled. No changes were committed.");
    if (
      invalidated ||
      projectSession() !== session ||
      useProjectStore.getState().project !== expected ||
      useProjectStore.getState().project.scriptAssistance?.activeRevision !== revision
    )
      throw new Error(
        "The project, passage or script changed. Current edits were preserved; run reconciliation again.",
      );
  }
  current();
  const unsubscribe = useProjectStore.subscribe((state) => {
    if (state.project !== expected || projectSession() !== session) {
      invalidated = true;
      if (run.started) void cancelScriptAnalysis(run.id).catch(() => {});
    }
  });
  let unlisten: (() => void) | undefined;
  try {
    const candidates: ScriptCandidate[] = [];
    let lastYield = globalThis.performance.now();
    for (const batch of scriptCandidateBatches(expected, scope)) {
      candidates.push(...batch);
      current();
      if (globalThis.performance.now() - lastYield >= 8) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        current();
        lastYield = globalThis.performance.now();
      }
    }
    current();
    const windows = scriptAudioWindows(expected, candidates);
    if (!windows.length) return { applied: 0, pending: 0, offScript: 0, unsupported: 0 };
    unlisten = await onScriptProgress((event) => {
      if (
        event.requestId === run.id &&
        !run.cancelled &&
        !invalidated &&
        projectSession() === session &&
        useProjectStore.getState().project === expected
      )
        progress(event.completed, event.total);
    });
    current();
    progress(0, windows.length);
    run.started = true;
    const audio = await analyzeScriptAudio(expected, windows, run.id, model);
    run.started = false;
    current();
    if (
      audio.windows.length !== windows.length ||
      audio.windows.some(
        (window, index) =>
          window.segmentId !== windows[index]!.segmentId ||
          window.sourceIn !== windows[index]!.sourceIn ||
          window.sourceOut !== windows[index]!.sourceOut ||
          typeof window.text !== "string",
      )
    )
      throw new Error(
        "Audio evidence did not match the requested scope. No changes were committed.",
      );
    const blocks = projectTranscript(expected);
    const records: ScriptReviewRecord[] = [];
    const existing = new Set(expected.scriptAssistance!.records.map((r) => r.id));
    const superseded = new Set<string>();
    for (const candidate of candidates) {
      const block = blocks.find(
        (b) => b.segmentId === candidate.segmentId && b.id === candidate.blockId,
      )!;
      const contextBefore = block.text.slice(Math.max(0, candidate.from - 48), candidate.from);
      const contextAfter = block.text.slice(candidate.to, candidate.to + 48);
      const sameProposal = (record: ScriptReviewRecord) =>
        record.scriptRevision === revision &&
        record.mediaId === candidate.mediaId &&
        record.occurrenceLineage === candidate.occurrenceLineage &&
        JSON.stringify(record.anchorIds) === JSON.stringify(candidate.anchorIds) &&
        record.beforeText === candidate.beforeText &&
        record.afterText === candidate.afterText &&
        record.contextBefore === contextBefore &&
        record.contextAfter === contextAfter;
      const prior = expected.scriptAssistance!.records.filter(sameProposal);
      if (
        prior.some((record) =>
          ["kept", "accepted", "reverted", "dismissed", "cut"].includes(record.status),
        )
      )
        continue;
      const last = prior.at(-1);
      if (
        last &&
        !last.historicalReason &&
        last.evidence.engine === audio.engine &&
        last.evidence.model === audio.model &&
        last.policy === SCRIPT_MATCH_POLICY
      )
        continue;
      let id =
        "script:" +
        (await scriptHash(
          JSON.stringify([
            revision,
            SCRIPT_MATCH_POLICY,
            audio.engine,
            audio.model,
            expected.media[candidate.mediaId]!.sha256,
            candidate.occurrenceLineage,
            candidate.anchorIds,
            candidate.beforeText,
            candidate.afterText,
            contextBefore,
            contextAfter,
            candidate.kind,
          ]),
        ));
      current();
      if (last?.historicalReason) {
        id = "script:" + (await scriptHash(id + "|supersedes:" + last.id));
        current();
      }
      if (existing.has(id)) continue;
      prior
        .filter((record) => !record.historicalReason)
        .forEach((record) => superseded.add(record.id));
      const unprompted = audio.windows
        .filter(
          (w) =>
            w.segmentId === candidate.segmentId &&
            w.sourceIn < candidate.sourceOut &&
            w.sourceOut > candidate.sourceIn,
        )
        .map((w) => w.text)
        .join("\n[Next bounded audio window]\n");
      records.push({
        id,
        policy: SCRIPT_MATCH_POLICY,
        scriptRevision: revision!,
        mediaId: candidate.mediaId,
        occurrenceLineage: candidate.occurrenceLineage,
        anchorIds: candidate.anchorIds,
        beforeText: candidate.beforeText,
        afterText: candidate.afterText,
        contextBefore,
        contextAfter,
        sourceIn: candidate.sourceIn,
        sourceOut: candidate.sourceOut,
        scriptFrom: candidate.scriptFrom,
        scriptTo: candidate.scriptTo,
        kind: candidate.kind,
        status: candidate.kind === "off-script" ? "off-script" : "suggested",
        reason:
          candidate.reason +
          (candidate.protected ? " Existing manual text requires individual acceptance." : "") +
          (last
            ? " Earlier evidence was invalidated or the acoustic provider changed; its history is retained."
            : ""),
        evidence: {
          engine: audio.engine,
          model: audio.model,
          policy: "independent-audio-review-v1",
          unprompted,
          windows: audio.windows
            .filter(
              (window) =>
                window.segmentId === candidate.segmentId &&
                window.sourceIn < candidate.sourceOut &&
                window.sourceOut > candidate.sourceIn,
            )
            .map(({ sourceIn, sourceOut, text }) => ({ sourceIn, sourceOut, text })),
        },
        ...(candidate.actionable ? {} : { historicalReason: candidate.reason }),
      });
    }
    current();
    if (isComposing?.())
      throw new Error("Finish typing and run reconciliation again. No changes were committed.");
    if (records.length)
      useProjectStore.getState().commitTranscript(
        {
          ...expected,
          updatedAt: new Date().toISOString(),
          scriptAssistance: {
            ...expected.scriptAssistance!,
            records: [
              ...expected.scriptAssistance!.records.map((record) =>
                superseded.has(record.id)
                  ? {
                      ...record,
                      historicalReason:
                        "A new explicit analysis superseded this evidence; the earlier record is retained.",
                    }
                  : record,
              ),
              ...records,
            ],
          },
        },
        expected,
      );
    return {
      applied: 0,
      pending: records.filter((r) => !r.historicalReason && r.status === "suggested").length,
      offScript: records.filter((r) => !r.historicalReason && r.status === "off-script").length,
      unsupported: records.filter((r) => r.historicalReason).length,
    };
  } finally {
    run.started = false;
    unsubscribe();
    unlisten?.();
  }
}
