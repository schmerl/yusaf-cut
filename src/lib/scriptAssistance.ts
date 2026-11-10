import type { Project } from "./edl";
import { MAX_SCRIPT_BYTES, parseScript, scriptHash } from "./scriptMarkdown";

export type EditAuthorship = "manual" | "script" | "review";
export interface EditProvenance {
  author: EditAuthorship;
  recordId?: string;
}
export interface StoredScript {
  revision: string;
  name: string;
  markdown: string;
}
export type ScriptResultKind = "wording" | "notation" | "punctuation" | "off-script" | "uncertain";
export type ScriptResultStatus =
  | "suggested"
  | "applied"
  | "accepted"
  | "kept"
  | "reverted"
  | "dismissed"
  | "off-script"
  | "cut";
export interface ScriptEvidence {
  engine: string;
  model: string;
  policy: string;
  unprompted: string;
  /** Conditioned output must never be labeled independent confirmation. */
  prompted?: string;
  windows?: { sourceIn: number; sourceOut: number; text: string }[];
}
export interface ScriptReviewRecord {
  id: string;
  policy: string;
  scriptRevision: string;
  mediaId: string;
  occurrenceLineage: string;
  anchorIds: string[];
  beforeText: string;
  afterText: string;
  contextBefore: string;
  contextAfter: string;
  sourceIn: number;
  sourceOut: number;
  scriptFrom: number;
  scriptTo: number;
  kind: ScriptResultKind;
  status: ScriptResultStatus;
  reason: string;
  evidence: ScriptEvidence;
  /** Keep the outcome/evidence when a mapping ceases to be actionable. */
  historicalReason?: string;
}
export interface ScriptAssistance {
  version: 1;
  activeRevision: string;
  scripts: StoredScript[];
  records: ScriptReviewRecord[];
  syncLinks?: ScriptSyncLink[];
}

/** A user-selected correspondence, scoped to one take and one script revision. */
export interface ScriptSyncLink {
  id: string;
  scriptRevision: string;
  mediaId: string;
  occurrenceLineage: string;
  anchorIds: string[];
  scriptFrom: number;
  scriptTo: number;
}

const revisionPattern = /^[a-f0-9]{64}$/;
const kinds: ScriptResultKind[] = ["wording", "notation", "punctuation", "off-script", "uncertain"];
const statuses: ScriptResultStatus[] = [
  "suggested",
  "applied",
  "accepted",
  "kept",
  "reverted",
  "dismissed",
  "off-script",
  "cut",
];
const parsedCopies = new WeakMap<StoredScript, string>();
function requireValid(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(`Invalid script assistance: ${detail}`);
}
function short(value: unknown, limit = 4096): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

/** Synchronous structural validation; native persistence verifies source hashes.
 * Exact text and surviving mappings are checked again by every review action.
 */
export function validateScriptAssistance(project: Project): void {
  const metadata = project.scriptAssistance;
  if (!metadata) return;
  requireValid(metadata.version === 1, "unsupported metadata version");
  requireValid(
    Array.isArray(metadata.scripts) && metadata.scripts.length <= 100,
    "too many script revisions",
  );
  requireValid(
    Array.isArray(metadata.records) && metadata.records.length <= 10000,
    "too many review records",
  );
  const scripts = new Map<string, StoredScript>();
  let totalBytes = 0;
  for (const script of metadata.scripts) {
    requireValid(
      revisionPattern.test(script.revision) && !scripts.has(script.revision),
      "duplicate/invalid revision",
    );
    requireValid(
      short(script.name, 512) && typeof script.markdown === "string" && script.markdown.trim(),
      "empty script/name",
    );
    const bytes = new globalThis.TextEncoder().encode(script.markdown).length;
    totalBytes += bytes;
    requireValid(
      bytes <= MAX_SCRIPT_BYTES && totalBytes <= 20 * MAX_SCRIPT_BYTES,
      "script size limit exceeded",
    );
    if (parsedCopies.get(script) !== script.markdown) {
      parseScript(script.markdown);
      parsedCopies.set(script, script.markdown);
    }
    scripts.set(script.revision, script);
  }
  requireValid(scripts.has(metadata.activeRevision), "missing active script");
  const linkIds = new Set<string>();
  requireValid(
    !metadata.syncLinks || metadata.syncLinks.length <= 1000,
    "too many script sync links",
  );
  for (const link of metadata.syncLinks ?? []) {
    const source = scripts.get(link.scriptRevision);
    requireValid(
      short(link.id, 128) && !linkIds.has(link.id),
      "duplicate/invalid script sync link",
    );
    linkIds.add(link.id);
    requireValid(
      source && short(link.mediaId) && short(link.occurrenceLineage),
      "invalid script sync identity",
    );
    requireValid(
      Array.isArray(link.anchorIds) &&
        link.anchorIds.length > 0 &&
        link.anchorIds.length <= 10000 &&
        link.anchorIds.every((id) => short(id)) &&
        new Set(link.anchorIds).size === link.anchorIds.length,
      "invalid script sync anchors",
    );
    requireValid(
      Number.isInteger(link.scriptFrom) &&
        Number.isInteger(link.scriptTo) &&
        link.scriptFrom >= 0 &&
        link.scriptTo > link.scriptFrom &&
        link.scriptTo <= source.markdown.length,
      "invalid script sync range",
    );
    requireValid(
      !/[\uD800-\uDBFF]$/u.test(source.markdown.slice(0, link.scriptFrom)) &&
        !/[\uD800-\uDBFF]$/u.test(source.markdown.slice(0, link.scriptTo)),
      "script sync range splits a Unicode character",
    );
  }
  const ids = new Set<string>();
  for (const record of metadata.records) {
    requireValid(short(record.id, 128) && !ids.has(record.id), "duplicate/invalid record ID");
    ids.add(record.id);
    const script = scripts.get(record.scriptRevision);
    requireValid(script, "missing historical script evidence");
    requireValid(
      short(record.policy) && short(record.mediaId) && short(record.occurrenceLineage),
      "missing result identity",
    );
    requireValid(
      Array.isArray(record.anchorIds) &&
        record.anchorIds.length > 0 &&
        record.anchorIds.length <= 10000 &&
        record.anchorIds.every((id) => short(id)) &&
        new Set(record.anchorIds).size === record.anchorIds.length,
      "invalid result anchors",
    );
    requireValid(
      Number.isFinite(record.sourceIn) &&
        record.sourceIn >= 0 &&
        Number.isFinite(record.sourceOut) &&
        record.sourceOut > record.sourceIn,
      "invalid source range",
    );
    requireValid(
      Number.isInteger(record.scriptFrom) &&
        Number.isInteger(record.scriptTo) &&
        record.scriptFrom >= 0 &&
        record.scriptTo >= record.scriptFrom &&
        record.scriptTo <= script.markdown.length,
      "invalid script source range",
    );
    const boundary = (offset: number) =>
      !(
        script.markdown.charCodeAt(offset) >= 0xdc00 &&
        script.markdown.charCodeAt(offset) <= 0xdfff &&
        script.markdown.charCodeAt(offset - 1) >= 0xd800 &&
        script.markdown.charCodeAt(offset - 1) <= 0xdbff
      );
    requireValid(
      boundary(record.scriptFrom) && boundary(record.scriptTo),
      "script range splits a Unicode character",
    );
    requireValid(
      kinds.includes(record.kind) && statuses.includes(record.status),
      "unsupported result kind/status",
    );
    requireValid(
      [record.beforeText, record.afterText, record.contextBefore, record.contextAfter].every(
        (text) => typeof text === "string" && text.length <= 100000,
      ),
      "invalid result text",
    );
    requireValid(record.beforeText.trim() && short(record.reason), "empty result evidence");
    requireValid(
      record.historicalReason === undefined || short(record.historicalReason),
      "invalid historical reason",
    );
    if (!record.historicalReason && record.status !== "cut") {
      const anchors = project.segments
        .filter(
          (segment) =>
            segment.mediaId === record.mediaId &&
            (segment.occurrenceLineage ??
              segment.transcript?.occurrenceId ??
              `transcript:${segment.id}`) === record.occurrenceLineage,
        )
        .flatMap((segment) =>
          segment.words
            .filter((word) => word.end > segment.sourceIn && word.start < segment.sourceOut)
            .map((word) => word.id),
        );
      requireValid(
        project.media[record.mediaId] && record.anchorIds.every((id) => anchors.includes(id)),
        "active record refers to removed audio",
      );
    }
    requireValid(
      record.evidence &&
        [record.evidence.engine, record.evidence.model, record.evidence.policy].every((v) =>
          short(v),
        ) &&
        typeof record.evidence.unprompted === "string" &&
        record.evidence.unprompted.length <= 100000 &&
        (record.evidence.prompted === undefined ||
          (typeof record.evidence.prompted === "string" &&
            record.evidence.prompted.length <= 100000)),
      "invalid acoustic evidence",
    );
    if (record.evidence.windows !== undefined)
      requireValid(
        Array.isArray(record.evidence.windows) &&
          record.evidence.windows.length > 0 &&
          record.evidence.windows.length <= 2000 &&
          record.evidence.windows.every(
            (window) =>
              Number.isFinite(window.sourceIn) &&
              window.sourceIn >= 0 &&
              Number.isFinite(window.sourceOut) &&
              window.sourceOut > window.sourceIn &&
              window.sourceOut - window.sourceIn <= 30 + 1e-6 &&
              typeof window.text === "string" &&
              window.text.length <= 100000,
          ),
        "invalid bounded audio evidence",
      );
  }
}

/** Build before committing so invalid imports and stale async completions cannot
 * replace the previous script. Store Markdown, not a dependency on its path.
 */
export async function prepareScript(markdown: string, name: string): Promise<StoredScript> {
  parseScript(markdown);
  if (!short(name, 512))
    throw new Error("Choose a script with a nonempty filename (at most 512 characters).");
  return { revision: await scriptHash(markdown), markdown, name };
}

export function replaceStoredScript(project: Project, script: StoredScript): Project {
  parseScript(script.markdown);
  if (project.scriptAssistance?.activeRevision === script.revision) return project;
  const previous = project.scriptAssistance;
  const scripts = [...(previous?.scripts ?? [])];
  if (!scripts.some((s) => s.revision === script.revision)) scripts.push(script);
  const next: Project = {
    ...project,
    updatedAt: new Date().toISOString(),
    scriptAssistance: {
      version: 1,
      activeRevision: script.revision,
      scripts,
      records: (previous?.records ?? []).map((record) =>
        !record.historicalReason &&
        (record.status === "suggested" || record.status === "off-script")
          ? { ...record, historicalReason: "Script replaced; run reconciliation again." }
          : record,
      ),
    },
  };
  validateScriptAssistance(next);
  return next;
}
