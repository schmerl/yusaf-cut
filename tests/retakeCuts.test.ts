import { beforeEach, describe, expect, it } from "vitest";
import { totalDuration } from "@/lib/edl";
import {
  normalizeProjectTranscripts,
  projectTranscript,
  validateProjectTranscripts,
} from "@/lib/transcript";
import {
  groupRetakes,
  lexicalRetakes,
  retakeRecords,
  retakeWindows,
  validateRetakeGroups,
} from "@/lib/retakes";
import { planRetakeCut, rebaseRetake, removeOccurrenceIntervals } from "@/lib/retakeCuts";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { buildSrt } from "@/lib/captions";
import { speech } from "./helpers/retakeProject";

const text = (p: ReturnType<typeof speech>) =>
  projectTranscript(p)
    .map((b) => b.text)
    .join(" ");
beforeEach(() => useProjectStore.temporal.getState().clear());

describe("retake cut transactions", () => {
  it("cuts the interrupted requests and JSON starts without removing their shared context", () => {
    const requests = speech("HTTP requests and requests [UH] responses.");
    const requestsCandidate = validateRetakeGroups({ id: "w", records: retakeRecords(requests) }, [
      {
        kind: "interrupted-restart",
        attempts: [
          { start: 1, end: 2, complete: true },
          { start: 3, end: 5, complete: false },
        ],
        markers: [],
      },
    ])[0]!;
    const requestCut = planRetakeCut(
      requests,
      requestsCandidate,
      requestsCandidate.attempts[0]!.id,
    );
    expect(text(requestCut.nextProject)).toBe("HTTP requests and responses.");

    const json = speech("JSON is a JSON is common.");
    const jsonCandidate = validateRetakeGroups({ id: "w", records: retakeRecords(json) }, [
      {
        kind: "interrupted-restart",
        attempts: [
          { start: 0, end: 3, complete: false },
          { start: 3, end: 6, complete: true },
        ],
        markers: [],
      },
    ])[0]!;
    const jsonCut = planRetakeCut(json, jsonCandidate, jsonCandidate.attempts[1]!.id);
    expect(text(jsonCut.nextProject)).toBe("JSON is common.");
  });
  it("retains shared prefix/continuation for either side of a spoken correction", () => {
    const p = speech("Use POST sorry PUT for updates.");
    const records = retakeRecords(p);
    const candidate = validateRetakeGroups({ id: "w", records }, [
      {
        kind: "spoken-correction",
        attempts: [
          { start: 1, end: 2, complete: true },
          { start: 3, end: 4, complete: true },
        ],
        markers: [{ start: 2, end: 3 }],
      },
    ])[0]!;
    const before = structuredClone(p);
    const last = planRetakeCut(p, candidate, candidate.attempts[1]!.id);
    const first = planRetakeCut(p, candidate, candidate.attempts[0]!.id);
    expect(text(last.nextProject)).toBe("Use PUT for updates.");
    expect(text(first.nextProject)).toBe("Use POST for updates.");
    expect(p).toEqual(before);
    expect(buildSrt(last.nextProject)).toContain("Use PUT for updates.");
    expect(last.editedAudition.end - last.editedAudition.start).toBeLessThan(
      last.originalAudition.end - last.originalAudition.start,
    );
  });
  it("removes the pause leading into a shared continuation when keeping an earlier take", () => {
    const p = speech("Use POST sorry PUT for updates.", 2);
    const records = retakeRecords(p);
    const candidate = validateRetakeGroups({ id: "w", records }, [
      {
        kind: "spoken-correction",
        attempts: [
          { start: 1, end: 2, complete: true },
          { start: 3, end: 4, complete: true },
        ],
        markers: [{ start: 2, end: 3 }],
      },
    ])[0]!;
    const plan = planRetakeCut(p, candidate, candidate.attempts[0]!.id);
    expect(Math.max(...plan.removals.map((r) => r.end))).toBeCloseTo(8 - 0.08);
    expect(text(plan.nextProject)).toBe("Use POST for updates.");
  });
  it.each([0, 1, 2])("keeps take %i out of three with one atomic undo and redo", (take) => {
    const p = speech("Before. The server The server The server responds. After.");
    replaceProjectBaseline(p);
    const records = retakeRecords(p);
    const candidate = lexicalRetakes(retakeWindows(records)[0]!)[0]!;
    const plan = planRetakeCut(p, candidate, candidate.attempts[take]!.id);
    const oldDuration = totalDuration(p);
    useProjectStore.getState().commitTranscript(plan.nextProject, p);
    expect(text(plan.nextProject)).toBe("Before. The server responds. After.");
    expect(totalDuration(plan.nextProject)).toBeLessThan(oldDuration);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(1);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    useProjectStore.temporal.getState().redo();
    expect(useProjectStore.getState().project).toBe(plan.nextProject);
    validateProjectTranscripts(JSON.parse(JSON.stringify(plan.nextProject)));
  });
  it("does not cut another occurrence of the same recording/word IDs", () => {
    const p = speech("The the server responds.");
    p.segments.push({ ...p.segments[0]!, id: "copy" });
    const records = retakeRecords(p);
    const candidate = lexicalRetakes({ id: "w", records: records.slice(0, 4) })[0]!;
    const plan = planRetakeCut(p, candidate, candidate.attempts[1]!.id);
    expect(plan.nextProject.segments.find((s) => s.id === "copy")!.words).toEqual(
      p.segments[1]!.words,
    );
    expect(plan.removals.every((r) => r.segmentId === "s")).toBe(true);
  });
  it("rebases a later candidate through known segment splits", () => {
    const p = speech("The the server responds. The the client retries.");
    const records = retakeRecords(p);
    const candidates = groupRetakes(records, lexicalRetakes(retakeWindows(records)[0]!));
    expect(candidates).toHaveLength(2);
    const plan = planRetakeCut(p, candidates[0]!, candidates[0]!.attempts[1]!.id);
    const rebased = rebaseRetake(candidates[1]!, plan)!;
    expect(rebased).not.toBeNull();
    const second = planRetakeCut(plan.nextProject, rebased, rebased.attempts[1]!.id);
    expect(text(second.nextProject)).toBe("the server responds. the client retries.");
    expect(rebaseRetake(candidates[0]!, plan)).toBeNull();
  });
  it("removes silent intervals explicitly while preserving audio anchors", () => {
    const p = speech("One two", 2);
    const next = removeOccurrenceIntervals(p, [
      { segmentId: "s", start: 0.3, end: 1.8 },
    ]).nextProject;
    expect(text(next)).toBe("One two");
    expect(totalDuration(p) - totalDuration(next)).toBeCloseTo(1.5);
    expect(() => removeOccurrenceIntervals(p, [{ segmentId: "s", start: 0.1, end: 1.8 }])).toThrow(
      /clip/,
    );
  });
  it("rejects partial corrected timing groups and stale store commits atomically", () => {
    const p = speech("The the server responds.");
    const candidate = lexicalRetakes(retakeWindows(retakeRecords(p))[0]!)[0]!;
    const plan = planRetakeCut(p, candidate, candidate.attempts[1]!.id);
    replaceProjectBaseline(p);
    useProjectStore.getState().rename("new revision");
    const current = useProjectStore.getState().project;
    expect(() => useProjectStore.getState().commitTranscript(plan.nextProject, p)).toThrow(
      /changed/,
    );
    expect(useProjectStore.getState().project).toBe(current);
    const corrected = normalizeProjectTranscripts(p);
    const block = corrected.segments[0]!.transcript!.blocks[0]!;
    block.runs[0]!.anchorIds.push(...block.runs[1]!.anchorIds);
    block.runs.splice(1, 1);
    expect(() =>
      removeOccurrenceIntervals(corrected, [{ segmentId: "s", start: 0, end: 0.3 }]),
    ).toThrow(/corrected phrase/);
  });
});
