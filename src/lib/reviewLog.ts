import type { Project } from "./edl";
export type ReviewAction =
  | "accept"
  | "dismiss"
  | "keep"
  | "revert"
  | "cut"
  | "replace"
  | "hide"
  | "reopen";
export interface ReviewLogEntry {
  id: string;
  createdAt: string;
  kind: "script" | "filler";
  action: ReviewAction;
  beforeText: string;
  afterText: string;
  mediaId: string;
  occurrenceLineage: string;
  anchorIds: string[];
  sourceIn: number;
  sourceOut: number;
  recordId?: string;
  candidateId?: string;
}
export interface ReviewLog {
  version: 1;
  entries: ReviewLogEntry[];
}
export function appendReviewLog(
  project: Project,
  entry: Omit<ReviewLogEntry, "id" | "createdAt">,
): Project {
  const next = {
    ...project,
    reviewLog: {
      version: 1 as const,
      entries: [
        ...(project.reviewLog?.entries ?? []),
        { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() },
      ],
    },
  };
  validateReviewLog(next);
  return next;
}
export function validateReviewLog(project: Project) {
  const log = project.reviewLog;
  if (!log) return;
  const fail = () => {
    throw new Error("Invalid review log or review log size limit exceeded.");
  };
  if (log.version !== 1 || !Array.isArray(log.entries) || log.entries.length > 10000) fail();
  const ids = new Set<string>();
  let size = 0;
  for (const e of log.entries) {
    const text = (v: unknown, max: number, empty = false): v is string =>
      typeof v === "string" && (empty || v.trim().length > 0) && v.length <= max;
    if (
      !text(e.id, 512) ||
      ids.has(e.id) ||
      !text(e.createdAt, 64) ||
      !Number.isFinite(Date.parse(e.createdAt)) ||
      !["script", "filler"].includes(e.kind) ||
      !["accept", "dismiss", "keep", "revert", "cut", "replace", "hide", "reopen"].includes(
        e.action,
      ) ||
      !text(e.beforeText, 100000, true) ||
      !text(e.afterText, 100000, true) ||
      !text(e.mediaId, 512) ||
      !text(e.occurrenceLineage, 512) ||
      !Array.isArray(e.anchorIds) ||
      !e.anchorIds.length ||
      e.anchorIds.length > 10000 ||
      new Set(e.anchorIds).size !== e.anchorIds.length ||
      !e.anchorIds.every((id) => text(id, 512)) ||
      !Number.isFinite(e.sourceIn) ||
      !Number.isFinite(e.sourceOut) ||
      e.sourceIn < 0 ||
      e.sourceOut < e.sourceIn ||
      (e.recordId !== undefined && !text(e.recordId, 512)) ||
      (e.candidateId !== undefined && !text(e.candidateId, 4096))
    )
      fail();
    ids.add(e.id);
    size += e.beforeText.length + e.afterText.length;
  }
  if (size > 4000000) fail();
}

export function logScriptReview(
  next: Project,
  record: import("./scriptAssistance").ScriptReviewRecord,
  action: ReviewAction,
): Project {
  const beforeText = ["applied", "accepted", "kept"].includes(record.status)
    ? record.afterText
    : record.beforeText;
  const updated = next.scriptAssistance?.records.find((r) => r.id === record.id);
  const afterText =
    action === "cut"
      ? ""
      : action === "revert"
        ? record.beforeText
        : ["accept", "replace"].includes(action)
          ? (updated?.afterText ?? beforeText)
          : beforeText;
  return appendReviewLog(next, {
    kind: "script",
    action,
    beforeText,
    afterText,
    mediaId: record.mediaId,
    occurrenceLineage: record.occurrenceLineage,
    anchorIds: record.anchorIds,
    sourceIn: record.sourceIn,
    sourceOut: record.sourceOut,
    recordId: record.id,
  });
}
export function logFillerReview(
  next: Project,
  candidate: import("./fillerReview").FillerCandidate,
  action: ReviewAction,
  afterText = candidate.text,
): Project {
  return appendReviewLog(next, {
    kind: "filler",
    action,
    beforeText: candidate.text,
    afterText,
    mediaId: candidate.mediaId,
    occurrenceLineage: candidate.occurrenceLineage,
    anchorIds: candidate.anchorIds,
    sourceIn: candidate.sourceStart,
    sourceOut: candidate.sourceEnd,
    candidateId: candidate.id,
  });
}
