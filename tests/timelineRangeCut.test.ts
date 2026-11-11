import { describe, expect, it } from "vitest";
import {
  newProject,
  computeTimeline,
  totalDuration,
  outputTimeToSource,
  type Project,
} from "@/lib/edl";
import { cutOutputSpeech } from "@/lib/transcriptEdits";
import { projectTranscript, validateProjectTranscripts } from "@/lib/transcript";
import fixture from "./fixtures/transcript-corrections.json";

// Minimal reproduction of the ordinary wordless clips at output 3:50.95 in
// the reported GraphQL project. These have no fillerAudio marker.
function gapProject(): Project {
  const p = newProject("Timeline gap reproduction");
  p.media.m1 = { ...fixture.media.m1, duration: 300 };
  p.segments = [
    {
      id: "before",
      mediaId: "m1",
      sourceIn: 0,
      sourceOut: 230.95,
      words: [{ id: "before-word", text: "query.", start: 229.69, end: 230.05, confidence: 1 }],
    },
    { id: "gap-one", mediaId: "m1", sourceIn: 239.67, sourceOut: 240.35, words: [], precise: true },
    {
      id: "gap-two",
      mediaId: "m1",
      sourceIn: 240.745,
      sourceOut: 240.94,
      words: [],
      precise: true,
    },
    {
      id: "after",
      mediaId: "m1",
      sourceIn: 241.12,
      sourceOut: 245,
      words: [{ id: "after-word", text: "GraphQL", start: 241.12, end: 241.66, confidence: 1 }],
    },
  ];
  return p;
}
describe("timeline cuts include untranscribed media", () => {
  it("removes the reported blank interval by its exact source times without changing any words", () => {
    const p = gapProject(),
      before = structuredClone(p);
    const next = cutOutputSpeech(p, 231, 231.5);
    expect(totalDuration(p) - totalDuration(next)).toBeCloseTo(0.5, 8);
    expect(next.segments[1]!.sourceOut).toBeCloseTo(239.72, 8);
    expect(next.segments[2]!.sourceIn).toBeCloseTo(240.22, 8);
    expect(next.segments[1]!.precise).toBe(true);
    expect(next.segments[2]!.precise).toBe(true);
    expect(outputTimeToSource(next, 231.001)!.sourceTime).toBeCloseTo(240.221, 8);
    expect(next.segments.flatMap((s) => s.words)).toEqual(p.segments.flatMap((s) => s.words));
    expect(projectTranscript(next).map((b) => b.text)).toEqual(
      projectTranscript(p).map((b) => b.text),
    );
    expect(p).toEqual(before);
    const reopened = JSON.parse(JSON.stringify(next)) as Project;
    validateProjectTranscripts(reopened);
    expect(computeTimeline(reopened)).toEqual(computeTimeline(next));
  });
  it("can remove whole wordless clips, including a backwards drag across two clips", () => {
    const p = gapProject();
    const end = computeTimeline(p)[2]!.outputEnd;
    const next = cutOutputSpeech(p, end, 230.95);
    expect(next.segments.map((s) => s.id)).toEqual(["before", "after"]);
    expect(totalDuration(p) - totalDuration(next)).toBeCloseTo(0.875, 8);
    validateProjectTranscripts(next);
  });
  it("cuts a gap inside a word-bearing segment without changing the adjacent words or overlays", () => {
    const p = structuredClone(fixture) as Project;
    const next = cutOutputSpeech(p, 1.02, 1.08);
    expect(totalDuration(p) - totalDuration(next)).toBeCloseTo(0.06, 8);
    expect(next.segments.flatMap((s) => s.words)).toEqual(p.segments.flatMap((s) => s.words));
    expect(projectTranscript(next).flatMap((b) => b.runs.map((r) => r.text))).toEqual(
      projectTranscript(p).flatMap((b) => b.runs.map((r) => r.text)),
    );
    validateProjectTranscripts(next);
  });
  it("cuts a range spanning a whole word and adjacent untranscribed audio", () => {
    const p = gapProject();
    const next = cutOutputSpeech(p, 230.8, 232.365);
    expect(totalDuration(p) - totalDuration(next)).toBeCloseTo(1.565, 8);
    expect(next.segments.flatMap((s) => s.words).map((w) => w.id)).toEqual(["before-word"]);
    validateProjectTranscripts(next);
  });
  it("rejects invalid numbers and preserves identity for empty or out-of-range cuts", () => {
    const p = gapProject();
    expect(cutOutputSpeech(p, 231, 231)).toBe(p);
    expect(cutOutputSpeech(p, 500, 501)).toBe(p);
    expect(() => cutOutputSpeech(p, NaN, 231)).toThrow(/finite/);
  });
});
