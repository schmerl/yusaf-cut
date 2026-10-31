import { v4 as uuid } from "uuid";
import { reconcileFillerReview } from "./fillerReview";
import { computeTimeline, type Project } from "./edl";
import { locateScriptRecord, reconcileScriptReview } from "./scriptLifecycle";
import { scriptRunProtected, isSimpleFormatting } from "./scriptMatching";
import {
  reconcileTranscript,
  replaceTranscriptBatch,
  replaceTranscriptText,
} from "./transcriptEdits";
import type { ScriptResultStatus } from "./scriptAssistance";
import { normalizeProjectTranscripts, validateProjectTranscripts } from "./transcript";

function updateRecord(project: Project, id: string, status: ScriptResultStatus): Project {
  const next: Project = {
    ...project,
    updatedAt: new Date().toISOString(),
    scriptAssistance: {
      ...project.scriptAssistance!,
      records: project.scriptAssistance!.records.map((r) =>
        r.id === id ? { ...r, status, historicalReason: undefined } : r,
      ),
    },
  };
  validateProjectTranscripts(next);
  return next;
}
export function scriptReviewAction(
  project: Project,
  id: string,
  action: "accept" | "dismiss" | "keep" | "revert",
): Project {
  const record = project.scriptAssistance?.records.find((r) => r.id === id);
  if (!record) throw new Error("This review item no longer exists.");
  const location = locateScriptRecord(project, record);
  if (!location)
    throw new Error(
      "This passage changed. Run reconciliation again; removed speech cannot be restored by text review.",
    );
  const pending = record.status === "suggested",
    applied = record.status === "applied",
    offScript = record.status === "off-script";
  if (
    (action === "accept" &&
      (!pending || record.kind === "off-script" || record.beforeText === record.afterText)) ||
    (action === "dismiss" && !pending) ||
    (action === "keep" && !applied && !offScript) ||
    (action === "revert" && !applied)
  )
    throw new Error("This review decision has already changed. Refresh the review list.");
  let next = project;
  if (action === "accept" || action === "revert") {
    next = replaceTranscriptText(
      project,
      {
        segmentId: location.block.segmentId,
        blockId: location.block.id,
        from: location.from,
        to: location.to,
        text: action === "accept" ? record.afterText : record.beforeText,
      },
      { author: "review", recordId: record.id },
    );
  } else if (action === "keep") {
    // Keeping is an explicit user decision even though display text is unchanged.
    const anchors = new Set(record.anchorIds);
    const normalized = normalizeProjectTranscripts(project);
    next = {
      ...normalized,
      segments: normalized.segments.map((segment) =>
        segment.id !== location.block.segmentId
          ? segment
          : {
              ...segment,
              transcript: {
                ...segment.transcript!,
                blocks: segment.transcript!.blocks.map((block) =>
                  block.id !== location.block.id
                    ? block
                    : {
                        ...block,
                        runs: block.runs.map((run) =>
                          run.anchorIds.some((id) => anchors.has(id))
                            ? {
                                ...run,
                                provenance: { author: "review" as const, recordId: record.id },
                              }
                            : run,
                        ),
                      },
                ),
              },
            },
      ),
    };
  }
  return reconcileScriptReview(
    updateRecord(
      next,
      id,
      action === "accept"
        ? "accepted"
        : action === "dismiss"
          ? "dismissed"
          : action === "keep"
            ? "kept"
            : "reverted",
    ),
  );
}

/** One batch, one commit. Validate every eligible precondition before editing. */
export function bulkScriptPunctuation(
  project: Project,
  recordIds?: ReadonlySet<string>,
): { project: Project; count: number } {
  const targets = (project.scriptAssistance?.records ?? []).filter(
    (r) =>
      (!recordIds || recordIds.has(r.id)) &&
      r.status === "suggested" &&
      r.kind === "punctuation" &&
      !r.historicalReason,
  );
  const eligible = targets.flatMap((record) => {
    const location = locateScriptRecord(project, record);
    if (!location)
      throw new Error(
        "A punctuation suggestion is stale. Run reconciliation again before bulk applying.",
      );
    const runs = location.block.runs.filter((r) => r.to > location.from && r.from < location.to);
    if (runs.some(scriptRunProtected)) return [];
    if (!isSimpleFormatting(record.beforeText, record.afterText))
      throw new Error("The punctuation batch contains a wording change. No changes were applied.");
    return [
      {
        record,
        edit: {
          segmentId: location.block.segmentId,
          blockId: location.block.id,
          from: location.from,
          to: location.to,
          text: record.afterText,
        },
      },
    ];
  });
  if (!eligible.length) return { project, count: 0 };
  let next = replaceTranscriptBatch(
    project,
    project,
    eligible.map((item) => item.edit),
    { author: "review" },
  );
  for (const { record } of eligible) next = updateRecord(next, record.id, "accepted");
  return { project: reconcileScriptReview(next), count: eligible.length };
}

export interface OffScriptCutProposal {
  before: Project;
  result: Project;
  cutStart: number;
  cutEnd: number;
  joinOutput: number;
}
export function buildOffScriptCut(
  project: Project,
  id: string,
  buffers = { beforeMs: 0, afterMs: 0 },
): OffScriptCutProposal {
  const record = project.scriptAssistance?.records.find(
    (r) => r.id === id && r.kind === "off-script" && r.status === "off-script",
  );
  const location = record && locateScriptRecord(project, record);
  if (!record || !location)
    throw new Error("This off-script passage changed. Reconcile it again before cutting.");
  if (![buffers.beforeMs, buffers.afterMs].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("Enter nonnegative, finite cut buffers in milliseconds.");
  const normalized = normalizeProjectTranscripts(project);
  const source = normalized.segments.find((s) => s.id === location.block.segmentId)!;
  const ids = new Set(record.anchorIds);
  const cutStart = record.sourceIn - buffers.beforeMs / 1000;
  const cutEnd = record.sourceOut + buffers.afterMs / 1000;
  if (cutStart < source.sourceIn || cutEnd > source.sourceOut || cutEnd <= cutStart)
    throw new Error("The cut buffer crosses an existing edit boundary.");
  const remaining = source.words.filter(
    (w) => !ids.has(w.id) && w.end > source.sourceIn && w.start < source.sourceOut,
  );
  if (remaining.some((w) => w.start < cutEnd && w.end > cutStart))
    throw new Error("The cut buffer overlaps neighboring speech. Reduce the buffer.");
  const fragments = [
    [source.sourceIn, cutStart],
    [cutEnd, source.sourceOut],
  ].flatMap(([from, to]) => {
    if (to! <= from!) return [];
    const words = remaining.filter((w) => w.end > from! && w.start < to!);
    const fragment = reconcileTranscript(source, {
      ...source,
      id: uuid(),
      words,
      sourceIn: from!,
      sourceOut: to!,
      precise: true,
    });
    return [words.length ? fragment : { ...fragment, transcript: undefined }];
  });
  const next = reconcileScriptReview(
    reconcileFillerReview({
      ...normalized,
      segments: normalized.segments.flatMap((s) => (s.id === source.id ? fragments : [s])),
    }),
  );
  const entry = computeTimeline(project).find((e) => e.segmentId === source.id)!;
  return {
    before: project,
    result: reconcileScriptReview(updateRecord(next, record.id, "cut")),
    cutStart,
    cutEnd,
    joinOutput: entry.outputStart + cutStart - source.sourceIn,
  };
}

/** An explicit user replacement; script similarity never supplies this decision. */
export function replaceScriptReviewText(project: Project, id: string, text: string): Project {
  const record = project.scriptAssistance?.records.find((r) => r.id === id);
  const location = record && locateScriptRecord(project, record);
  if (!record || !location || !["suggested", "off-script", "applied"].includes(record.status))
    throw new Error("This passage changed. Select a current suggestion.");
  if (text.length > 100000 || /[\r\n\0]/u.test(text))
    throw new Error("Enter replacement text within one paragraph.");
  const next = replaceTranscriptText(
    project,
    {
      segmentId: location.block.segmentId,
      blockId: location.block.id,
      from: location.from,
      to: location.to,
      text,
    },
    { author: "review", recordId: id },
  );
  const updated = {
    ...next,
    scriptAssistance: {
      ...next.scriptAssistance!,
      records: next.scriptAssistance!.records.map((r) =>
        r.id === id
          ? {
              ...r,
              afterText: text,
              status: "accepted" as const,
              historicalReason: undefined,
              reason: r.reason + " Replacement entered by the user.",
            }
          : r,
      ),
    },
  };
  const result = reconcileScriptReview(updated);
  validateProjectTranscripts(result);
  return result;
}
