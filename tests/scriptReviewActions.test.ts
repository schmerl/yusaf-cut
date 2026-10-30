import { beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/script-assistance.json";
import type { Project } from "@/lib/edl";
import { computeTimeline, totalDuration } from "@/lib/edl";
import { projectTranscript, normalizeProjectTranscripts } from "@/lib/transcript";
import {
  scriptReviewAction,
  bulkScriptPunctuation,
  buildOffScriptCut,
} from "@/lib/scriptReviewActions";
import { reconcileScriptReview, locateScriptRecord } from "@/lib/scriptLifecycle";
import { replaceTranscriptText, cutTranscriptRanges } from "@/lib/transcriptEdits";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";

const project = () => structuredClone(fixture) as Project;
beforeEach(() => replaceProjectBaseline(project()));
describe("durable script review actions", () => {
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
    const result = bulkScriptPunctuation(clean);
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
