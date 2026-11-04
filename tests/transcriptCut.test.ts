import { describe, expect, it } from "vitest";
import { buildTranscriptCut } from "@/lib/transcriptCut";
import { totalDuration, type Project } from "@/lib/edl";
import { projectTranscript, validateProjectTranscripts } from "@/lib/transcript";
import fixture from "./fixtures/transcript-corrections.json";

function setup() {
  const project = structuredClone(fixture) as Project;
  const block = projectTranscript(project)[0]!;
  const run = block.runs[0]!;
  const range = { segmentId: block.segmentId, blockId: block.id, from: run.from, to: run.to };
  return { project, block, range };
}
describe("direct transcript cut proposals", () => {
  it("uses exact adjusted timing and only removes the selected clip occurrence", () => {
    const { project, range } = setup();
    const before = structuredClone(project);
    const proposal = buildTranscriptCut(project, [range], { startMs: 50, endMs: 50 });
    expect(proposal.cutStart).toBeCloseTo(0.05);
    expect(proposal.cutEnd).toBeCloseTo(1.05);
    expect(totalDuration(proposal.result)).toBeCloseTo(5);
    expect(projectTranscript(proposal.result)[0]!.text).not.toContain("idempotency");
    expect(proposal.result.segments.at(-1)).toEqual(project.segments.at(-1));
    expect(project).toEqual(before);
    expect(proposal.warning).toMatch(/keep 0.050 seconds.*without transcript text/);
    validateProjectTranscripts(proposal.result);
  });
  it("warns when adjustments clip neighboring speech, including text-hidden words", () => {
    const { project, block, range } = setup();
    const before = structuredClone(project);
    const clipped = buildTranscriptCut(project, [range], { startMs: 0, endMs: 200 });
    expect(clipped.warning).toMatch(/neighboring speech/);
    expect(totalDuration(clipped.result)).toBeCloseTo(4.8);
    expect(projectTranscript(clipped.result)[0]!.text).toContain("are not");
    expect(clipped.result.segments[0]!.sourceIn).toBeCloseTo(1.2);
    const run = block.runs.find((run) => run.text === "the")!;
    const next = { ...range, from: run.from, to: run.to };
    const hidden = buildTranscriptCut(project, [next], { startMs: 0, endMs: 100 });
    expect(hidden.warning).toMatch(/text-hidden/);
    validateProjectTranscripts(clipped.result);
    validateProjectTranscripts(hidden.result);
    expect(project).toEqual(before);
  });
  it("rejects partial selections of corrected phrases, invalid timing and existing edit crossings", () => {
    const { project, range } = setup();
    expect(() => buildTranscriptCut(project, [{ ...range, to: range.to - 1 }])).toThrow(/whole/);
    expect(() => buildTranscriptCut(project, [range], { startMs: -10, endMs: 0 })).toThrow(
      /edit boundary/,
    );
    expect(() => buildTranscriptCut(project, [range], { startMs: NaN, endMs: 0 })).toThrow(
      /finite/,
    );
    expect(() => buildTranscriptCut(project, [range], { startMs: 500, endMs: -600 })).toThrow(
      /later/,
    );
  });
  it("allows an overlap to remove some anchors of a neighboring corrected phrase", () => {
    const { project, block, range } = setup();
    const neighbor = block.runs.find((run) => run.text === "are not")!;
    const proposal = buildTranscriptCut(
      project,
      [{ ...range, from: neighbor.from, to: neighbor.to }],
      {
        startMs: -800,
        endMs: 0,
      },
    );
    expect(proposal.warning).toMatch(/neighboring speech/);
    const retained = projectTranscript(proposal.result)[0]!.runs[0]!;
    expect(retained.text).toBe("idempotency");
    expect(retained.anchorIds).toEqual(["w0"]);
    expect(proposal.result.segments[0]!.words[0]).toEqual(project.segments[0]!.words[0]);
    validateProjectTranscripts(proposal.result);
  });
  it("supports whole paragraphs including hidden words, and selections across clips", () => {
    const { project } = setup();
    const ranges = projectTranscript(project).map((block) => ({
      segmentId: block.segmentId,
      blockId: block.id,
      from: 0,
      to: block.text.length,
    }));
    const first = buildTranscriptCut(project, [ranges[0]!]);
    expect(totalDuration(first.result)).toBe(3);
    const all = buildTranscriptCut(project, ranges);
    expect(totalDuration(all.result)).toBe(0);
    expect(all.result.segments).toEqual([]);
  });
  it("removes a selected clip's untranscribed edges and adjacent remnants from the same occurrence", () => {
    const p = structuredClone(fixture) as Project;
    const segment = {
      id: "take",
      mediaId: "m1",
      sourceIn: 1,
      sourceOut: 2.5,
      occurrenceLineage: "selected-take",
      words: [
        { id: "one", text: "Remove", start: 1.2, end: 1.5, confidence: 1 },
        { id: "two", text: "this.", start: 1.6, end: 1.9, confidence: 1 },
      ],
    };
    const head = { ...segment, id: "head-remnant", sourceIn: 0.8, sourceOut: 1, words: [] };
    const tail = { ...segment, id: "tail-remnant", sourceIn: 2.5, sourceOut: 2.7, words: [] };
    const reused = { ...segment, id: "reused", occurrenceLineage: "different-take" };
    p.segments = [head, segment, tail, reused];
    const before = structuredClone(p);
    const block = projectTranscript(p)[0]!;
    const range = { segmentId: block.segmentId, blockId: block.id, from: 0, to: block.text.length };
    const proposal = buildTranscriptCut(p, [range]);
    expect(proposal.result.segments).toEqual([reused]);
    expect(totalDuration(p) - totalDuration(proposal.result)).toBeCloseTo(1.9);
    expect(proposal.warning).toBeUndefined();
    expect(p).toEqual(before);
    const reopened = JSON.parse(JSON.stringify(proposal.result)) as Project;
    validateProjectTranscripts(reopened);
    expect(reopened.segments).toEqual([reused]);
    // Blank clips belonging to other occurrences are independent edits.
    p.segments = [
      { ...head, occurrenceLineage: "other-head" },
      segment,
      { ...tail, occurrenceLineage: "other-tail" },
      reused,
    ];
    expect(buildTranscriptCut(p, [range]).result.segments.map((s) => s.id)).toEqual([
      head.id,
      tail.id,
      reused.id,
    ]);
  });
  it("uses gaps around kept words for default boundaries, preserving their padding and hidden speech", () => {
    const { project, block, range } = setup();
    const target = block.runs.find((run) => run.text === "are not")!;
    const proposal = buildTranscriptCut(project, [{ ...range, from: target.from, to: target.to }]);
    expect(proposal.cutStart).toBeCloseTo(1.08);
    expect(proposal.cutEnd).toBeCloseTo(1.92);
    expect(proposal.result.segments.every((segment) => segment.words.length > 0)).toBe(true);
    expect(
      projectTranscript(proposal.result)
        .flatMap((b) => b.runs)
        .some((r) => r.originalText === "old" && r.text === ""),
    ).toBe(true);
    expect(proposal.warning).toBeUndefined();
    validateProjectTranscripts(proposal.result);
  });
  it("honors deliberately retained edges and warns about their audio", () => {
    const p = structuredClone(fixture) as Project;
    p.segments = [
      {
        id: "take",
        mediaId: "m1",
        sourceIn: 1,
        sourceOut: 2,
        words: [{ id: "one", text: "Remove.", start: 1.2, end: 1.7, confidence: 1 }],
      },
    ];
    const block = projectTranscript(p)[0]!;
    const range = { segmentId: block.segmentId, blockId: block.id, from: 0, to: block.text.length };
    const clean = buildTranscriptCut(p, [range]);
    expect(clean.result.segments).toEqual([]);
    expect(buildTranscriptCut(p, [range], clean.offsets).result.segments).toEqual([]);
    const custom = buildTranscriptCut(p, [range], { startMs: 50, endMs: -50 });
    expect(custom.cutStart).toBeCloseTo(1.25 - 1); // output time, relative to this trimmed clip
    expect(custom.cutEnd).toBeCloseTo(1.65 - 1);
    expect(totalDuration(custom.result)).toBeCloseTo(0.6);
    expect(custom.warning).toMatch(/keep 0.600 seconds.*without transcript text/);
  });
});
