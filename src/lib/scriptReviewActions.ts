import { computeTimeline, totalDuration, type Project } from "./edl";
import { locateScriptRecord, reconcileScriptReview } from "./scriptLifecycle";
import { scriptRunProtected, isSimpleFormatting } from "./scriptMatching";
import {
  cutTranscriptRanges,
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
export function buildOffScriptCut(project: Project, id: string): OffScriptCutProposal {
  const record = project.scriptAssistance?.records.find(
    (r) => r.id === id && r.kind === "off-script" && r.status === "off-script",
  );
  const location = record && locateScriptRecord(project, record);
  if (!record || !location)
    throw new Error("This off-script passage changed. Reconcile it again before cutting.");
  const next = cutTranscriptRanges(project, [
    {
      segmentId: location.block.segmentId,
      blockId: location.block.id,
      from: location.from,
      to: location.to,
    },
  ]);
  const entry = computeTimeline(project).find((e) => e.segmentId === location.block.segmentId)!;
  const segment = project.segments.find((s) => s.id === location.block.segmentId)!;
  const durationRemoved = totalDuration(project) - totalDuration(next);
  if (durationRemoved <= 0) throw new Error("This passage has no valid speech cut.");
  // Existing explicit-cut padding may remove a different span than the anchor
  // bounds. Report the actual surviving boundary used by both preview and commit.
  const beforeAnchor = segment.words.filter((w) => w.end <= record.sourceIn).at(-1);
  const actualStart = beforeAnchor
    ? Math.min(segment.sourceOut, beforeAnchor.end + project.settings.paddingMs / 1000)
    : segment.sourceIn;
  const joinOutput = entry.outputStart + actualStart - segment.sourceIn;
  return {
    before: project,
    result: reconcileScriptReview(updateRecord(next, record.id, "cut")),
    cutStart: actualStart,
    cutEnd: actualStart + durationRemoved,
    joinOutput,
  };
}
