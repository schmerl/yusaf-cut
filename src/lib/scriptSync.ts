import type { Project } from "./edl";
import { occurrenceLineage } from "./fillerReview";
import { projectTranscript, validateProjectTranscripts } from "./transcript";
import type { ScriptSyncLink } from "./scriptAssistance";
import { parseScript, type ScriptPassage } from "./scriptMarkdown";
import type { TextRange } from "./transcriptEdits";

export interface ScriptSection {
  from: number;
  to: number;
  title: string;
  passages: ScriptPassage[];
}
export function scriptSections(project: Project): ScriptSection[] {
  const metadata = project.scriptAssistance;
  const stored = metadata?.scripts.find((s) => s.revision === metadata.activeRevision);
  if (!stored) return [];
  const result: ScriptSection[] = [];
  for (const passage of parseScript(stored.markdown).passages) {
    const last = result.at(-1);
    if (last && last.passages[0]!.sectionFrom === passage.sectionFrom) {
      last.to = passage.to;
      last.passages.push(passage);
    } else
      result.push({
        from: passage.from,
        to: passage.to,
        title: passage.section.at(-1) ?? "Opening",
        passages: [passage],
      });
  }
  return result;
}

/** Re-resolve saved word anchors after paragraph splits and unrelated edits.
 * Missing/duplicated anchors or a paragraph crossing the link make it stale.
 */
export function locateScriptSync(
  project: Project,
  link: ScriptSyncLink,
  blocks = projectTranscript(project),
): TextRange[] | null {
  if (link.scriptRevision !== project.scriptAssistance?.activeRevision) return null;
  const wanted = new Set(link.anchorIds),
    found = new Set<string>();
  const ranges: TextRange[] = [];
  for (const block of blocks) {
    const segment = project.segments.find((s) => s.id === block.segmentId)!;
    if (block.mediaId !== link.mediaId || occurrenceLineage(segment) !== link.occurrenceLineage)
      continue;
    const ids = block.runs.flatMap((run) => run.anchorIds);
    if (!ids.some((id) => wanted.has(id))) continue;
    if (ids.some((id) => !wanted.has(id))) return null;
    for (const id of ids) {
      if (found.has(id)) return null;
      found.add(id);
    }
    ranges.push({ segmentId: block.segmentId, blockId: block.id, from: 0, to: block.text.length });
  }
  return found.size === wanted.size && ranges.length ? ranges : null;
}

export function setScriptSync(
  project: Project,
  ranges: TextRange[],
  section: { from: number; to: number },
): Project {
  const metadata = project.scriptAssistance;
  if (!metadata || !ranges.length)
    throw new Error("Choose transcript passages and a script section first.");
  const target = scriptSections(project).find(
    (s) => s.from === section.from && s.to === section.to,
  );
  if (!target || target.passages.some((p) => p.ambiguous))
    throw new Error("Choose a complete script section without markup warnings.");
  const blocks = projectTranscript(project);
  const positions = ranges.map((range) =>
    blocks.findIndex((b) => b.segmentId === range.segmentId && b.id === range.blockId),
  );
  if (
    positions.some((position) => position < 0) ||
    positions.some((position, i) => i > 0 && position !== positions[i - 1]! + 1)
  )
    throw new Error("Choose a continuous range of transcript paragraphs.");
  const selected = positions.map((position) => blocks[position]!);
  if (ranges.some((range, i) => range.from !== 0 || range.to !== selected[i]!.text.length))
    throw new Error("Link complete transcript paragraphs.");
  const first = project.segments.find((s) => s.id === selected[0]!.segmentId)!;
  if (
    selected.some(
      (b) =>
        b.mediaId !== first.mediaId ||
        occurrenceLineage(project.segments.find((s) => s.id === b.segmentId)!) !==
          occurrenceLineage(first),
    )
  )
    throw new Error("Choose paragraphs from one recorded take; link other takes separately.");
  const anchorIds = selected.flatMap((b) => b.runs.flatMap((run) => run.anchorIds));
  if (anchorIds.length > 10000 || new Set(anchorIds).size !== anchorIds.length)
    throw new Error("Choose a smaller range from one occurrence.");
  const ids = new Set(anchorIds);
  const link: ScriptSyncLink = {
    id: crypto.randomUUID(),
    scriptRevision: metadata.activeRevision,
    mediaId: first.mediaId,
    occurrenceLineage: occurrenceLineage(first),
    anchorIds,
    scriptFrom: target.from,
    scriptTo: target.to,
  };
  const next: Project = {
    ...project,
    updatedAt: new Date().toISOString(),
    scriptAssistance: {
      ...metadata,
      syncLinks: [
        ...(metadata.syncLinks ?? []).filter(
          (old) =>
            old.mediaId !== link.mediaId ||
            old.occurrenceLineage !== link.occurrenceLineage ||
            !old.anchorIds.some((id) => ids.has(id)),
        ),
        link,
      ],
      records: metadata.records.map((record) =>
        record.mediaId === link.mediaId &&
        record.occurrenceLineage === link.occurrenceLineage &&
        record.anchorIds.some((id) => ids.has(id)) &&
        ["suggested", "off-script"].includes(record.status) &&
        !record.historicalReason
          ? {
              ...record,
              historicalReason: "Script sync changed; find differences again in this passage.",
            }
          : record,
      ),
    },
  };
  validateProjectTranscripts(next);
  return next;
}

export function removeScriptSync(project: Project, id: string): Project {
  const metadata = project.scriptAssistance;
  const link = metadata?.syncLinks?.find((l) => l.id === id);
  if (!metadata || !link) return project;
  const next: Project = {
    ...project,
    updatedAt: new Date().toISOString(),
    scriptAssistance: {
      ...metadata,
      syncLinks: metadata.syncLinks!.filter((l) => l.id !== id),
      records: metadata.records.map((r) =>
        !r.historicalReason &&
        ["suggested", "off-script"].includes(r.status) &&
        r.mediaId === link.mediaId &&
        r.occurrenceLineage === link.occurrenceLineage &&
        r.anchorIds.some((anchor) => link.anchorIds.includes(anchor))
          ? {
              ...r,
              historicalReason: "Script sync removed; find differences again in this passage.",
            }
          : r,
      ),
    },
  };
  validateProjectTranscripts(next);
  return next;
}
