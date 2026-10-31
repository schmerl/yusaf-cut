import type { Project } from "./edl";
import { occurrenceLineage } from "./fillerReview";
import { projectTranscript, type ProjectedBlock } from "./transcript";
import type { ScriptReviewRecord } from "./scriptAssistance";

export function locateScriptRecord(
  project: Project,
  record: ScriptReviewRecord,
  blocks = projectTranscript(project),
  checkContext = true,
) {
  if (record.historicalReason || record.status === "cut") return null;
  const matches: { block: ProjectedBlock; from: number; to: number }[] = [];
  for (const block of blocks) {
    const segment = project.segments.find((s) => s.id === block.segmentId)!;
    if (block.mediaId !== record.mediaId || occurrenceLineage(segment) !== record.occurrenceLineage)
      continue;
    const selected = block.runs.filter((r) =>
      r.anchorIds.some((id) => record.anchorIds.includes(id)),
    );
    if (!selected.length) continue;
    const first = block.runs.indexOf(selected[0]!),
      last = block.runs.indexOf(selected.at(-1)!);
    const runs = block.runs.slice(first, last + 1);
    const anchors = runs.flatMap((r) => r.anchorIds);
    if (
      anchors.length !== record.anchorIds.length ||
      anchors.some((id, i) => id !== record.anchorIds[i])
    )
      continue;
    const from = runs[0]!.from,
      to = runs.at(-1)!.to;
    const expected = ["applied", "accepted", "kept"].includes(record.status)
      ? record.afterText
      : record.beforeText;
    if (
      block.text.slice(from, to) !== expected ||
      Math.abs(runs[0]!.sourceStart - record.sourceIn) > 0.001 ||
      Math.abs(runs.at(-1)!.sourceEnd - record.sourceOut) > 0.001
    )
      continue;
    if (
      checkContext &&
      ["suggested", "off-script"].includes(record.status) &&
      (block.text.slice(Math.max(0, from - 48), from) !== record.contextBefore ||
        block.text.slice(to, to + 48) !== record.contextAfter)
    )
      continue;
    matches.push({ block, from, to });
  }
  return matches.length === 1 ? matches[0]! : null;
}

/** Run inside the same history transaction as every text/timeline writer.
 * Keep outcomes and old script/audio evidence, disable stale actions. Undo/redo
 * restores captured metadata directly; loading never invents a new edit.
 */
export function reconcileScriptReview(project: Project): Project {
  const metadata = project.scriptAssistance;
  if (!metadata?.records.some((r) => !r.historicalReason && r.status !== "cut")) return project;
  // Project the new text/timeline before validating old review references. An
  // edit may have removed their anchors; archive them in this same transaction.
  const blocks = projectTranscript({
    ...project,
    scriptAssistance: undefined,
    fillerReview: undefined,
  });
  let changed = false;
  const records = metadata.records.map((record) => {
    if (
      record.historicalReason ||
      record.status === "cut" ||
      locateScriptRecord(project, record, blocks)
    )
      return record;
    changed = true;
    return {
      ...record,
      historicalReason:
        "The passage, timing group or occurrence changed; this result is no longer actionable.",
    };
  });
  return changed ? { ...project, scriptAssistance: { ...metadata, records } } : project;
}

/** Only explicit review text edits may rebase unchanged neighboring proposals. */
export function rebaseReviewContexts(before: Project, next: Project, changedId: string): Project {
  if (!next.scriptAssistance) return next;
  const blocks = projectTranscript({
    ...next,
    scriptAssistance: undefined,
    fillerReview: undefined,
  });
  const originals = new Map(before.scriptAssistance?.records.map((r) => [r.id, r]));
  return {
    ...next,
    scriptAssistance: {
      ...next.scriptAssistance,
      records: next.scriptAssistance.records.map((record) => {
        const original = originals.get(record.id);
        if (
          !original ||
          original.id === changedId ||
          original.historicalReason ||
          !["suggested", "off-script"].includes(original.status)
        )
          return record;
        const location = locateScriptRecord(next, original, blocks, false);
        if (!location) return record;
        return {
          ...record,
          historicalReason: undefined,
          contextBefore: location.block.text.slice(Math.max(0, location.from - 48), location.from),
          contextAfter: location.block.text.slice(location.to, location.to + 48),
        };
      }),
    },
  };
}
