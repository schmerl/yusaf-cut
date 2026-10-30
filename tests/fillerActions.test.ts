import { describe, expect, it } from "vitest";
import { buildFillerCutProposal, removeFillerText, setFillerDecision } from "@/lib/fillerActions";
import { fillerCandidates, withFillerPolicy } from "@/lib/fillerReview";
import { addMediaWithTranscript, newProject, totalDuration, type Project } from "@/lib/edl";
import { projectTranscript, validateProjectTranscripts } from "@/lib/transcript";
import { replaceTranscriptText, cutOutputSpeech } from "@/lib/transcriptEdits";
import { buildSrt, buildVtt } from "@/lib/captions";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import source from "./fixtures/transcript-corrections.json";
import edgesFixture from "./fixtures/filler-retained-edges.json";

export function fillerProject(text = "Hello [UM], world.") {
  return addMediaWithTranscript(
    newProject("Review"),
    structuredClone(source.media.m1),
    text
      .split(" ")
      .map((text, i) => ({ id: `w${i}`, text, start: i * 0.5, end: i * 0.5 + 0.3, confidence: 1 })),
  );
}
const offsets = { startMs: 0, endMs: 0 };
describe("occurrence review actions", () => {
  it("removes only text and captions as one history step, preserving audio/duration and hidden identity", () => {
    const p = fillerProject();
    const c = fillerCandidates(p)[0]!;
    replaceProjectBaseline(p);
    const next = removeFillerText(p, c);
    useProjectStore.getState().commitTranscript(next, p);
    expect(totalDuration(next)).toBe(totalDuration(p));
    expect(next.segments[0]!.words).toEqual(p.segments[0]!.words);
    expect(buildSrt(next)).not.toContain("[UM]");
    expect(buildVtt(next)).not.toContain("[UM]");
    expect(fillerCandidates(next)[0]).toMatchObject({
      id: c.id,
      hidden: true,
      outcome: "text-removed",
    });
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(1);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    useProjectStore.temporal.getState().redo();
    expect(useProjectStore.getState().project).toBe(next);
  });
  it("keeps zero offsets exact, isolates repeated occurrences, and cuts hidden fillers", () => {
    const single = fillerProject();
    const p = {
      ...single,
      segments: [...single.segments, { ...single.segments[0]!, id: "repeat" }],
    };
    const c = fillerCandidates(p)[1]!;
    const snapshot = JSON.stringify(p);
    const proposal = buildFillerCutProposal(p, c, offsets);
    expect(JSON.stringify(p)).toBe(snapshot);
    expect(proposal.cutStart).toBe(0.5);
    expect(proposal.cutEnd).toBe(0.8);
    expect(proposal.result.segments[0]!.words).toEqual(p.segments[0]!.words);
    expect(proposal.result.segments[0]!.sourceIn).toBe(p.segments[0]!.sourceIn);
    expect(proposal.result.segments[0]!.sourceOut).toBe(p.segments[0]!.sourceOut);
    expect(totalDuration(proposal.result)).toBeCloseTo(totalDuration(p) - 0.3);
    expect(fillerCandidates(proposal.result)).toHaveLength(1);
    const hidden = removeFillerText(single, fillerCandidates(single)[0]!);
    const cut = buildFillerCutProposal(hidden, fillerCandidates(hidden)[0]!, offsets);
    expect(cut.result.segments.flatMap((s) => s.words).map((w) => w.id)).toEqual(["w0", "w2"]);
    expect(buildSrt(cut.result)).not.toContain("UM");
  });
  it("represents retained edges as wordless exact fragments with durable provenance", () => {
    const p = fillerProject();
    const proposal = buildFillerCutProposal(p, fillerCandidates(p)[0]!, {
      startMs: 50,
      endMs: -50,
    });
    expect(proposal.retainedEdges).toBe(true);
    expect(proposal.result.segments.map((s) => [s.sourceIn, s.sourceOut])).toEqual([
      [0, 0.5],
      [0.5, 0.55],
      [0.75, 0.8],
      [0.8, 5],
    ]);
    const edges = proposal.result.segments.filter((s) => s.fillerAudio);
    expect(edges).toHaveLength(2);
    expect(edges.every((s) => !s.words.length && !s.transcript && s.precise)).toBe(true);
    expect(proposal.result.segments.flatMap((s) => s.words).map((w) => w.id)).toEqual(["w0", "w2"]);
    expect(fillerCandidates(proposal.result)[0]).toMatchObject({
      hidden: true,
      residual: true,
      outcome: "text-removed",
    });
    const roundTrip = JSON.parse(JSON.stringify(proposal.result)) as Project;
    validateProjectTranscripts(roundTrip);
    expect(totalDuration(roundTrip)).toBeCloseTo(4.8);
    expect(buildSrt(roundTrip)).not.toContain("UM");
    validateProjectTranscripts(structuredClone(edgesFixture) as Project);
  });
  it("extends into surrounding gaps without moving neighbors or adding project padding", () => {
    const p = fillerProject();
    const proposal = buildFillerCutProposal(p, fillerCandidates(p)[0]!, {
      startMs: -100,
      endMs: 100,
    });
    expect(proposal.result.segments.map((s) => [s.sourceIn, s.sourceOut])).toEqual([
      [0, 0.4],
      [0.9, 5],
    ]);
    expect(proposal.result.segments.flatMap((s) => s.words)).toEqual([
      p.segments[0]!.words[0],
      p.segments[0]!.words[2],
    ]);
  });
  it("rejects neighboring speech, hidden neighboring speech, invalid boundaries, stale candidates and groups", () => {
    const p = fillerProject();
    const c = fillerCandidates(p)[0]!;
    for (const o of [
      { startMs: -300, endMs: 0 },
      { startMs: 0, endMs: 300 },
      { startMs: 400, endMs: 0 },
      { startMs: NaN, endMs: 0 },
      { startMs: -1000, endMs: 0 },
    ])
      expect(() => buildFillerCutProposal(p, c, o)).toThrow();
    const b = projectTranscript(p)[0]!;
    const hiddenNeighbor = replaceTranscriptText(p, {
      segmentId: b.segmentId,
      blockId: b.id,
      from: b.runs[0]!.from,
      to: b.runs[0]!.to,
      text: "",
    });
    expect(() =>
      buildFillerCutProposal(hiddenNeighbor, fillerCandidates(hiddenNeighbor)[0]!, {
        startMs: -300,
        endMs: 0,
      }),
    ).toThrow(/neighbor/);
    const corrected = replaceTranscriptText(p, {
      segmentId: b.segmentId,
      blockId: b.id,
      from: 0,
      to: b.runs[1]!.to,
      text: "Hello UM",
    });
    expect(() =>
      buildFillerCutProposal(corrected, fillerCandidates(corrected)[0]!, offsets),
    ).toThrow(/timing group/);
    expect(() => buildFillerCutProposal(corrected, c, offsets)).toThrow(/changed/);
    expect(() => removeFillerText(corrected, c)).toThrow(/changed/);
  });
  it("preserves the nonempty paragraph rule while allowing complete filler-only speech cuts", () => {
    const p = fillerProject("[UM]");
    const c = fillerCandidates(p)[0]!;
    expect(() => removeFillerText(p, c)).toThrow(/paragraph/);
    expect(() => buildFillerCutProposal(p, c, { startMs: 10, endMs: 0 })).toThrow(/paragraph/);
    const full = buildFillerCutProposal(p, c, offsets);
    expect(full.result.segments.flatMap((s) => s.words)).toEqual([]);
    expect(totalDuration(full.result)).toBeCloseTo(totalDuration(p) - 0.3);
  });
  it("commits the exact preview object and undoes EDL, text and decisions together", () => {
    let p = fillerProject();
    const c = fillerCandidates(p)[0]!;
    p = setFillerDecision(p, c, "kept");
    replaceProjectBaseline(p);
    const proposal = buildFillerCutProposal(p, fillerCandidates(p)[0]!, offsets);
    useProjectStore.getState().commitTranscript(proposal.result, proposal.before);
    expect(useProjectStore.getState().project).toBe(proposal.result);
    expect(useProjectStore.getState().project.fillerReview!.decisions).toEqual([]);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    expect(fillerCandidates(useProjectStore.getState().project)[0]!.outcome).toBe("kept");
    useProjectStore.temporal.getState().redo();
    expect(useProjectStore.getState().project).toBe(proposal.result);
    expect(() =>
      useProjectStore.getState().commitTranscript(proposal.result, proposal.before),
    ).toThrow(/changed/);
  });
  it("cuts a selected optional multiword phrase once", () => {
    const p = withFillerPolicy(fillerProject("Hello you know world."), {
      optional: ["you know"],
      custom: [],
    });
    const c = fillerCandidates(p)[0]!;
    expect(c.anchorIds).toEqual(["w1", "w2"]);
    const proposal = buildFillerCutProposal(p, c, offsets);
    expect(proposal.result.segments.flatMap((s) => s.words).map((w) => w.id)).toEqual(["w0", "w3"]);
  });
});

it("allows explicit timeline cuts to remove wordless retained edges", () => {
  const p = structuredClone(edgesFixture) as Project;
  const next = cutOutputSpeech(p, 0.51, 0.53);
  validateProjectTranscripts(next);
  expect(totalDuration(next)).toBeCloseTo(totalDuration(p) - 0.02);
  expect(next.segments.filter((s) => s.fillerAudio).map((s) => [s.sourceIn, s.sourceOut])).toEqual([
    [0.5, 0.51],
    [0.53, 0.55],
    [0.75, 0.8],
  ]);
});

it("keeps a multiword text-only removal eligible for a later isolated speech cut", () => {
  const p = withFillerPolicy(fillerProject("Hello you know world."), {
    optional: ["you know"],
    custom: [],
  });
  const next = removeFillerText(p, fillerCandidates(p)[0]!);
  const hidden = fillerCandidates(next)[0]!;
  expect(hidden).toMatchObject({ hidden: true, grouped: false, outcome: "text-removed" });
  expect(() => buildFillerCutProposal(next, hidden, offsets)).not.toThrow();
});

it("warns about a 20ms recognized filler without widening its anchors or proposed cut", () => {
  const p = fillerProject();
  p.segments[0]!.words[1]!.end = 0.52;
  const candidate = fillerCandidates(p)[0]!;
  const before = JSON.stringify(p);
  const proposal = buildFillerCutProposal(p, candidate, offsets);
  expect(proposal.timingWarning).toContain("only 20 ms");
  expect(proposal.recognizedStart).toBe(0.5);
  expect(proposal.recognizedEnd).toBe(0.52);
  expect(proposal.earliestStart).toBe(0.3);
  expect(proposal.latestEnd).toBe(1);
  expect(proposal.cutStart).toBe(0.5);
  expect(proposal.cutEnd).toBe(0.52);
  expect(totalDuration(proposal.result)).toBeCloseTo(totalDuration(p) - 0.02);
  expect(JSON.stringify(p)).toBe(before);
  const adjusted = buildFillerCutProposal(p, candidate, { startMs: -100, endMs: 180 });
  expect(adjusted.cutStart).toBeCloseTo(0.4);
  expect(adjusted.cutEnd).toBeCloseTo(0.7);
  expect(totalDuration(adjusted.result)).toBeCloseTo(totalDuration(p) - 0.3);
  expect(adjusted.result.segments.flatMap((s) => s.words).map((w) => w.id)).toEqual(["w0", "w2"]);
  expect(() => buildFillerCutProposal(p, candidate, { startMs: -300, endMs: 0 })).toThrow(
    /neighbor/,
  );
});
