import { describe, expect, it } from "vitest";
import fixture from "./fixtures/transcript-corrections.json";
import { computeTimeline, totalDuration, type Project } from "@/lib/edl";
import {
  normalizeProjectTranscripts,
  projectTranscript,
  validateProjectTranscripts,
} from "@/lib/transcript";

const project = () => globalThis.structuredClone(fixture) as Project;

describe("transcript metadata and projection", () => {
  it("projects merged, expanded and hidden text without changing audio, with UTF-16 offsets", () => {
    const p = project();
    const before = JSON.stringify(p);
    const [block, repeated] = projectTranscript(p);
    expect(block!.text).toBe("idempotency are not the serveur.");
    expect(repeated!.text).toBe("item potency aren’t the old server.");
    expect(block!.runs[0]).toMatchObject({
      originalText: "item potency",
      sourceStart: 0,
      sourceEnd: 1,
      outputStart: 0,
      outputEnd: 1,
      from: 0,
      to: 11,
    });
    expect(block!.runs[1]).toMatchObject({
      text: "are not",
      originalText: "aren’t",
      from: 12,
      to: 19,
    });
    expect(block!.runs[3]).toMatchObject({
      text: "",
      originalText: "old",
      from: 23,
      to: 23,
      sourceStart: 2.3,
      sourceEnd: 2.6,
    });
    for (const run of block!.runs) expect(block!.text.slice(run.from, run.to)).toBe(run.text);
    expect(repeated!.runs[0]!.outputStart).toBe(3);
    expect(JSON.stringify(p)).toBe(before);
    expect(totalDuration(p)).toBe(6);
  });

  it("normalizes legacy baselines deterministically, only once, without changing audio or update time", () => {
    const p = project();
    delete p.segments[0]!.transcript;
    const before = computeTimeline(p);
    const normalized = normalizeProjectTranscripts(p);
    expect(normalizeProjectTranscripts(normalized)).toBe(normalized);
    expect(normalizeProjectTranscripts(p)).toEqual(normalized);
    expect(p.segments[0]!.transcript).toBeUndefined();
    expect(normalized.updatedAt).toBe(p.updatedAt);
    expect(computeTimeline(normalized)).toEqual(before);
    expect(normalized.segments[0]!.transcript!.originals).toEqual(p.segments[0]!.words);
  });

  it("uses output order with occurrence-specific identities when the same source is repeated/reordered", () => {
    const p = normalizeProjectTranscripts(project());
    p.segments.reverse();
    const blocks = projectTranscript(p);
    expect(blocks[0]!.segmentId).toBe("s2");
    expect(blocks[1]!.segmentId).toBe("s1");
    expect(blocks[0]!.occurrenceId).not.toBe(blocks[1]!.occurrenceId);
    expect(blocks[1]!.runs[0]!.outputStart).toBe(3);
  });

  it("clamps legacy anchors at a pre-existing cut and never joins discontinuous segments", () => {
    const p = project();
    delete p.segments[0]!.transcript;
    p.segments[0]!.sourceIn = 0.2;
    p.segments[0]!.sourceOut = 0.8;
    const blocks = projectTranscript(p);
    expect(blocks[0]!.runs[0]).toMatchObject({ sourceStart: 0.2, outputStart: 0 });
    expect(blocks[0]!.runs[1]!.sourceEnd).toBe(0.8);
    expect(blocks[1]!.runs[0]!.outputStart).toBeCloseTo(0.6);
  });

  it("preserves originals, hidden text and identity through JSON serialization", () => {
    const p = normalizeProjectTranscripts(project());
    const roundtrip = JSON.parse(JSON.stringify(p)) as Project;
    validateProjectTranscripts(roundtrip);
    expect(roundtrip).toEqual(p);
    expect(projectTranscript(roundtrip)).toEqual(projectTranscript(p));
  });

  it("uses UTF-16 offsets for non-ASCII text and keeps persisted paragraph identity", () => {
    const p = project();
    p.segments[0]!.transcript!.blocks[0]!.runs[0]!.text = "😊 REST!";
    const block = projectTranscript(p)[0]!;
    expect(block.id).toBe("block-1");
    expect(block.runs[0]!.to).toBe(8);
    expect(block.runs[1]!.from).toBe(9);
    expect(block.text.slice(block.runs[1]!.from, block.runs[1]!.to)).toBe("are not");
  });

  it("retains legacy sentence/gap paragraphs in output order with no shared baseline objects", () => {
    const p = project();
    delete p.segments[0]!.transcript;
    p.segments[0]!.words[0]!.text = "REST.";
    const normalized = normalizeProjectTranscripts(p);
    expect(projectTranscript(normalized)[0]!.text).toBe("REST.");
    expect(projectTranscript(normalized)[1]!.text).toContain("potency");
    expect(normalized.segments[0]!.transcript!.originals[0]).not.toBe(p.segments[0]!.words[0]);
  });

  it.each([
    [
      "future project",
      (p: Project) => {
        (p as { version: number }).version = 2;
      },
    ],
    [
      "future metadata",
      (p: Project) => {
        (p.segments[0]!.transcript! as { version: number }).version = 2;
      },
    ],
    [
      "unknown anchor",
      (p: Project) => {
        p.segments[0]!.transcript!.blocks[0]!.runs[0]!.anchorIds[0] = "missing";
      },
    ],
    [
      "duplicate run",
      (p: Project) => {
        p.segments[0]!.transcript!.blocks[0]!.runs[1]!.id = "r1";
      },
    ],
    [
      "bad timing",
      (p: Project) => {
        p.segments[0]!.transcript!.originals[0]!.start = -1;
      },
    ],
    [
      "empty paragraph",
      (p: Project) => {
        p.segments[0]!.transcript!.blocks[0]!.runs.forEach((r) => {
          r.text = " ";
        });
      },
    ],
    [
      "unmapped anchors",
      (p: Project) => {
        p.segments[0]!.transcript!.blocks[0]!.runs.pop();
      },
    ],
    [
      "duplicate occurrence",
      (p: Project) => {
        p.segments[1]!.transcript = globalThis.structuredClone(p.segments[0]!.transcript!);
      },
    ],
    [
      "unknown media",
      (p: Project) => {
        p.segments[0]!.mediaId = "missing";
      },
    ],
  ] as const)("rejects %s without mutating the input", (_name, mutate) => {
    const p = project();
    mutate(p);
    const before = JSON.stringify(p);
    expect(() => normalizeProjectTranscripts(p)).toThrow();
    expect(JSON.stringify(p)).toBe(before);
  });
});
