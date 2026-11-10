import { beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/script-assistance.json";
import type { Project } from "@/lib/edl";
import { computeTimeline, totalDuration } from "@/lib/edl";
import { projectTranscript, normalizeProjectTranscripts } from "@/lib/transcript";
import {
  scriptReviewAction,
  replaceScriptReviewText,
  bulkScriptPunctuation,
  buildOffScriptCut,
  revisitScriptReview,
} from "@/lib/scriptReviewActions";
import { reconcileScriptReview, locateScriptRecord } from "@/lib/scriptLifecycle";
import { replaceTranscriptText, cutTranscriptRanges } from "@/lib/transcriptEdits";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";

const project = () => structuredClone(fixture) as Project;
function neighboringSuggestions() {
  const p = normalizeProjectTranscripts(project());
  const template = p.scriptAssistance!.records.find((r) => r.id === "pending-example")!;
  p.scriptAssistance!.records = [];
  p.segments = [p.segments[1]!];
  const b = projectTranscript(p)[0]!;
  p.scriptAssistance!.records = b.runs.map((r, i) => ({
    ...template,
    id: `neighbor-${i}`,
    occurrenceLineage: p.segments[0]!.transcript!.occurrenceId,
    anchorIds: r.anchorIds,
    beforeText: r.text,
    afterText: r.text.toUpperCase(),
    sourceIn: r.sourceStart,
    sourceOut: r.sourceEnd,
    contextBefore: b.text.slice(Math.max(0, r.from - 48), r.from),
    contextAfter: b.text.slice(r.to, r.to + 48),
    kind: "punctuation" as const,
  }));
  return p;
}
beforeEach(() => replaceProjectBaseline(project()));
describe("durable script review actions", () => {
  it("retains protected and unselected neighboring suggestions after bulk formatting", () => {
    const p = neighboringSuggestions();
    p.segments[0]!.transcript!.blocks[0]!.runs[1]!.provenance = { author: "manual" };
    const result = bulkScriptPunctuation(p, new Set(["neighbor-0", "neighbor-1"]));
    expect(result.count).toBe(1);
    expect(result.project.scriptAssistance!.records[0]!.status).toBe("accepted");
    for (const record of result.project.scriptAssistance!.records.slice(1)) {
      expect(record.historicalReason).toBeUndefined();
      expect(locateScriptRecord(result.project, record)).not.toBeNull();
    }
    expect(computeTimeline(result.project)).toEqual(computeTimeline(p));
  });
  it("normalizes custom replacement whitespace and can revert the accepted edit", () => {
    const p = neighboringSuggestions();
    const result = replaceScriptReviewText(p, "neighbor-1", " \t replacement  ");
    const record = result.scriptAssistance!.records[1]!;
    expect(record.afterText).toBe("replacement");
    expect(record.historicalReason).toBeUndefined();
    expect(locateScriptRecord(result, record)).not.toBeNull();
    const reverted = revisitScriptReview(result, record.id, true);
    expect(projectTranscript(reverted)[0]!.text).toBe(projectTranscript(p)[0]!.text);
  });
  it.each([0, 1, 2, 5])(
    "restores empty replacements to their own anchors at position %s",
    (index) => {
      const p = neighboringSuggestions();
      const before = projectTranscript(p)[0]!;
      const accepted = replaceScriptReviewText(p, `neighbor-${index}`, "");
      expect(accepted.scriptAssistance!.records[index]!.historicalReason).toBeUndefined();
      const reverted = revisitScriptReview(accepted, `neighbor-${index}`, true);
      const after = projectTranscript(reverted)[0]!;
      expect(after.text).toBe(before.text);
      expect(after.runs.map((run) => [run.text, run.anchorIds])).toEqual(
        before.runs.map((run) => [run.text, run.anchorIds]),
      );
      expect(reverted.scriptAssistance!.records[index]!.status).toBe("reverted");
      expect(computeTimeline(reverted)).toEqual(computeTimeline(p));
      expect(reverted.segments[0]!.words).toEqual(p.segments[0]!.words);
    },
  );
  it("restores a hidden multiword replacement as one anchored timing group", () => {
    const p = neighboringSuggestions();
    const before = projectTranscript(p)[0]!;
    const first = before.runs[0]!,
      last = before.runs[1]!;
    const record = p.scriptAssistance!.records[0]!;
    Object.assign(record, {
      anchorIds: [...first.anchorIds, ...last.anchorIds],
      beforeText: before.text.slice(first.from, last.to),
      sourceOut: last.sourceEnd,
      contextAfter: before.text.slice(last.to, last.to + 48),
    });
    p.scriptAssistance!.records = [record];
    const accepted = replaceScriptReviewText(p, record.id, "");
    const reverted = revisitScriptReview(accepted, record.id, true);
    const after = projectTranscript(reverted)[0]!;
    expect(after.text).toBe(before.text);
    expect(after.runs[0]!.anchorIds).toEqual(record.anchorIds);
    expect(after.runs.slice(1).map((r) => r.anchorIds)).toEqual(
      before.runs.slice(2).map((r) => r.anchorIds),
    );
    expect(computeTimeline(reverted)).toEqual(computeTimeline(p));
  });
  it("applies user-entered text with review provenance and one Undo without changing timing", () => {
    const p = useProjectStore.getState().project;
    const result = replaceScriptReviewText(p, "pending-example", "service.");
    expect(projectTranscript(result)[0]!.text).toContain("service.");
    expect(totalDuration(result)).toBe(totalDuration(p));
    expect(result.scriptAssistance!.records.find((r) => r.id === "pending-example")).toMatchObject({
      afterText: "service.",
      status: "accepted",
    });
    useProjectStore.getState().commitTranscript(result, p);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
  });
  it("cuts only the selected source span and rejects buffers entering hidden neighboring speech", () => {
    const p = useProjectStore.getState().project;
    const cut = buildOffScriptCut(p, "off-script-example");
    expect(cut.cutStart).toBe(2);
    expect(cut.cutEnd).toBe(2.3);
    expect(totalDuration(p) - totalDuration(cut.result)).toBeCloseTo(0.3);
    expect(
      projectTranscript(cut.result)
        .map((b) => b.text)
        .join(" "),
    ).toContain("serveur.");
    const tiny = structuredClone(p);
    tiny.segments[0]!.words.find((w) => w.id === "w3")!.end = 2.08;
    tiny.segments[0]!.transcript!.originals.find((w) => w.id === "w3")!.end = 2.08;
    tiny.scriptAssistance!.records.find((r) => r.id === "off-script-example")!.sourceOut = 2.08;
    const shortCut = buildOffScriptCut(tiny, "off-script-example");
    expect(totalDuration(tiny) - totalDuration(shortCut.result)).toBeCloseTo(0.08);
    expect(shortCut.cutStart).toBe(2);
    expect(shortCut.cutEnd).toBe(2.08);
    expect(
      projectTranscript(shortCut.result)
        .map((b) => b.text)
        .join(" "),
    ).toContain("serveur.");
    const buffered = buildOffScriptCut(p, "off-script-example", { beforeMs: 100, afterMs: 0 });
    expect(buffered.cutStart).toBeCloseTo(1.9);
    expect(buffered.cutEnd).toBe(2.3);
    expect(() => buildOffScriptCut(p, "off-script-example", { beforeMs: 0, afterMs: 50 })).toThrow(
      /neighboring speech/,
    );
    expect(() => buildOffScriptCut(p, "off-script-example", { beforeMs: -10, afterMs: 0 })).toThrow(
      /nonnegative/,
    );
  });
  it("keeps an automatic change as an explicit protected decision; undo restores its marker", () => {
    const p = useProjectStore.getState().project;
    const next = scriptReviewAction(p, "automatic-example", "keep");
    useProjectStore.getState().commitTranscript(next, p);
    expect(next.scriptAssistance!.records[0]!.status).toBe("kept");
    expect(next.segments[0]!.transcript!.blocks[0]!.runs[0]!.provenance!.author).toBe("review");
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    expect(p.scriptAssistance!.records[0]!.status).toBe("applied");
  });
  it("reverts to the immediate before-text and preserves unrelated edits and audio", () => {
    const p = project();
    const edited = replaceTranscriptText(p, {
      segmentId: "s1",
      blockId: "block-1",
      from: 24,
      to: 32,
      text: "service.",
    });
    const next = scriptReviewAction(edited, "automatic-example", "revert");
    expect(projectTranscript(next)[0]!.text).toBe("item potency are not the service.");
    expect(computeTimeline(next)).toEqual(computeTimeline(p));
    expect(next.segments[0]!.words).toEqual(p.segments[0]!.words);
    expect(projectTranscript(next)[1]!.text).toBe(projectTranscript(p)[1]!.text);
    expect(next.scriptAssistance!.records[0]!.status).toBe("reverted");
  });
  it("never restores cut speech or reverts a changed automatic passage", () => {
    const p = project();
    const changed = reconcileScriptReview(
      replaceTranscriptText(p, {
        segmentId: "s1",
        blockId: "block-1",
        from: 0,
        to: 11,
        text: "manual text",
      }),
    );
    expect(() => scriptReviewAction(changed, "automatic-example", "revert")).toThrow(/changed/);
    const cut = reconcileScriptReview(
      cutTranscriptRanges(p, [{ segmentId: "s1", blockId: "block-1", from: 0, to: 11 }]),
    );
    expect(() => scriptReviewAction(cut, "automatic-example", "revert")).toThrow(/changed/);
  });
  it("accepts/dismisses individually with text and metadata in one undo step", () => {
    const p = useProjectStore.getState().project;
    const next = scriptReviewAction(p, "pending-example", "accept");
    useProjectStore.getState().commitTranscript(next, p);
    expect(projectTranscript(next)[0]!.text).toContain("server.");
    expect(next.scriptAssistance!.records.find((r) => r.id === "pending-example")!.status).toBe(
      "accepted",
    );
    expect(() => scriptReviewAction(next, "pending-example", "accept")).toThrow(/already changed/);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    const dismissed = scriptReviewAction(p, "pending-example", "dismiss");
    expect(dismissed.segments).toBe(p.segments);
  });
  it("bulk punctuation excludes protected runs and rejects a mislabeled wording change atomically", () => {
    const p = project();
    const record = p.scriptAssistance!.records.find((r) => r.id === "pending-example")!;
    record.kind = "punctuation";
    record.afterText = "SERVEUR.";
    // The fixture's changed legacy word is protected, so it cannot be bulk applied.
    expect(bulkScriptPunctuation(p)).toEqual({ project: p, count: 0 });
    const clean = normalizeProjectTranscripts({
      ...p,
      segments: [p.segments[1]!],
      scriptAssistance: { ...p.scriptAssistance!, records: [] },
    });
    const b = projectTranscript(clean)[0]!,
      run = b.runs.at(-1)!;
    const cleanRecord = {
      ...record,
      occurrenceLineage: clean.segments[0]!.transcript!.occurrenceId,
      beforeText: run.text,
      afterText: run.text.toUpperCase(),
      contextBefore: b.text.slice(Math.max(0, run.from - 48), run.from),
      contextAfter: "",
    };
    clean.scriptAssistance!.records = [cleanRecord];
    expect(bulkScriptPunctuation(clean, new Set())).toEqual({ project: clean, count: 0 });
    const result = bulkScriptPunctuation(clean, new Set([cleanRecord.id]));
    expect(result.count).toBe(1);
    expect(projectTranscript(result.project)[0]!.text).toContain("SERVER.");
    expect(projectTranscript(result.project)[0]!.runs.map((r) => r.anchorIds)).toEqual(
      b.runs.map((r) => r.anchorIds),
    );
    replaceProjectBaseline(clean);
    useProjectStore.getState().commitTranscript(result.project, clean);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(1);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(clean);
    cleanRecord.afterText = "a different word";
    expect(() => bulkScriptPunctuation(clean)).toThrow(/wording change/);
    expect(projectTranscript(clean)[0]!.text).toBe(b.text);
  });
  it("previews and commits one exact off-script cut, keeps reused occurrences independent, and undoes together", () => {
    const p = useProjectStore.getState().project;
    const preview = buildOffScriptCut(p, "off-script-example");
    expect(totalDuration(preview.result)).toBeLessThan(totalDuration(p));
    expect(p.scriptAssistance!.records.find((r) => r.id === "off-script-example")!.status).toBe(
      "off-script",
    );
    useProjectStore.getState().commitTranscript(preview.result, preview.before);
    expect(useProjectStore.getState().project).toBe(preview.result);
    expect(
      preview.result.scriptAssistance!.records.find((r) => r.id === "off-script-example")!.status,
    ).toBe("cut");
    expect(projectTranscript(preview.result).at(-1)!.segmentId).toBe("s2");
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    expect(locateScriptRecord(p, p.scriptAssistance!.records[0]!)).not.toBeNull();
  });
});
