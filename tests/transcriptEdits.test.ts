import { beforeEach, describe, expect, it } from "vitest";
import fixture from "./fixtures/transcript-corrections.json";
import {
  computeTimeline,
  deleteWords,
  removeSilences,
  totalDuration,
  type Project,
} from "@/lib/edl";
import { projectTranscript, validateProjectTranscripts } from "@/lib/transcript";
import {
  replaceTranscriptText,
  editBlockText,
  replaceTranscriptBatch,
  cutTranscriptRanges,
  restoreTranscriptBlock,
  splitTranscriptBlock,
  joinTranscriptBlocks,
  applyTranscriptDocument,
} from "@/lib/transcriptEdits";
import { buildSrt, buildVtt } from "@/lib/captions";
import { replaceProjectBaseline, useProjectStore, endTypingGroup } from "@/stores/projectStore";
const project = () => globalThis.structuredClone(fixture) as Project;
const range = { segmentId: "s1", blockId: "block-1", from: 0, to: 11 };

beforeEach(() => replaceProjectBaseline(project()));

describe("text operations preserve source anchors and timeline", () => {
  it("corrects a phrase, inserts at its edges, deletes visible words, without changing the audio plan", () => {
    const p = project();
    const next = replaceTranscriptText(p, { ...range, text: "REST" });
    const edited = editBlockText(next, "s1", "block-1", "REST is not the serveur.");
    expect(projectTranscript(edited)[0]!.text).toBe("REST is not the serveur.");
    expect(computeTimeline(edited)).toEqual(computeTimeline(p));
    expect(edited.segments.map((s) => s.words)).toEqual(p.segments.map((s) => s.words));
    expect(totalDuration(edited)).toBe(totalDuration(p));
    expect(projectTranscript(p)[0]!.text).toBe("idempotency are not the serveur.");
  });
  it("deletes text while retaining original audio and allows whole paragraph original restoration", () => {
    let p = project();
    p = editBlockText(p, "s2", "transcript:s2:block:0", "item potency aren’t the server.");
    expect(totalDuration(p)).toBe(6);
    const restored = restoreTranscriptBlock(p, "s2", "transcript:s2:block:0");
    expect(projectTranscript(restored)[1]!.text).toBe("item potency aren’t the old server.");
  });
  it("rejects empty paragraphs and invalid batch atomically", () => {
    const p = project();
    const before = JSON.stringify(p);
    expect(() => editBlockText(p, "s1", "block-1", "  ")).toThrow(/retain text/);
    expect(() =>
      replaceTranscriptBatch(p, p, [
        { ...range, text: "REST" },
        {
          segmentId: "s2",
          blockId: "transcript:s2:block:0",
          from: 0,
          to: projectTranscript(p)[1]!.text.length,
          text: "",
        },
      ]),
    ).toThrow();
    expect(JSON.stringify(p)).toBe(before);
    expect(() => replaceTranscriptBatch(p, project(), [])).toThrow(/changed/);
  });
  it("cuts only the selected occurrence, preserving all other metadata and hidden text", () => {
    const p = project();
    const next = cutTranscriptRanges(p, [range]);
    validateProjectTranscripts(next);
    expect(totalDuration(next)).toBeLessThan(6);
    expect(projectTranscript(next).at(-1)!.text).toBe("item potency aren’t the old server.");
    const retained = projectTranscript(next)[0]!;
    expect(retained.runs.some((r) => r.originalText === "old")).toBe(true);
    const restored = restoreTranscriptBlock(next, retained.segmentId, retained.id);
    expect(projectTranscript(restored)[0]!.text).toBe("aren’t the old server.");
    expect(restored.segments[0]!.sourceIn).toBe(next.segments[0]!.sourceIn);
  });
  it("rejects partial corrected phrase cuts via explicit selection and legacy cuts", () => {
    const p = project();
    expect(() => cutTranscriptRanges(p, [{ ...range, to: 4 }])).toThrow(/whole/);
    expect(() => deleteWords(p, new Set(["w0"]))).toThrow(/splits/);
  });
  it("whole-paragraph cuts remove hidden anchors as well", () => {
    const p = project(),
      block = projectTranscript(p)[0]!;
    const next = cutTranscriptRanges(p, [{ ...range, to: block.text.length }]);
    expect(next.segments).toHaveLength(1);
    expect(next.segments[0]!.id).toBe("s2");
  });
  it("silence splits retain text overlays or reject splitting a corrected group", () => {
    const p = project();
    const segment = p.segments[0]!;
    // There is a 100ms gap after the first corrected group.
    const [next] = removeSilences(p, { gapMs: 90, paddingMs: 0 });
    validateProjectTranscripts(next);
    expect(projectTranscript(next).some((b) => b.text.includes("idempotency"))).toBe(true);
    expect(segment.transcript!.originals).toHaveLength(6);
  });
  it("splits/joins valid paragraph boundaries without changing timing", () => {
    const p = project();
    const split = splitTranscriptBlock(p, "s1", "block-1", 11);
    expect(
      projectTranscript(split)
        .slice(0, 2)
        .map((b) => b.text),
    ).toEqual(["idempotency", "are not the serveur."]);
    const right = projectTranscript(split)[1]!;
    const joined = joinTranscriptBlocks(split, "s1", "block-1", right.id);
    expect(projectTranscript(joined)[0]!.text).toBe("idempotencyare not the serveur.");
    expect(computeTimeline(joined)).toEqual(computeTimeline(p));
    expect(() => splitTranscriptBlock(p, "s1", "block-1", 3)).toThrow(/between/);
  });
  it("validates structural editor changes and refuses losing a different source occurrence", () => {
    const p = project();
    const blocks = projectTranscript(p);
    const paragraphs = blocks.map((b) => ({ segmentId: b.segmentId, blockId: b.id, text: b.text }));
    expect(applyTranscriptDocument(p, paragraphs)).toBe(p);
    expect(() => applyTranscriptDocument(p, [paragraphs[0]!])).toThrow(/across/);
  });
  it("captions preserve removal of spaces between adjacent audio-anchored words", () => {
    const p = project();
    const b = projectTranscript(p)[1]!;
    const next = editBlockText(p, b.segmentId, b.id, "itempotency aren’t the old server.");
    expect(buildSrt(next)).toContain("itempotency aren’t");
  });
  it("rejects stale committed operations and reports invalid original restoration IDs", () => {
    const current = useProjectStore.getState().project;
    useProjectStore.getState().rename("changed");
    expect(() => useProjectStore.getState().correctBlock("s1", "block-1", "REST", current)).toThrow(
      /changed/,
    );
  });
  it("captions use corrected phrase timing once, skip text-hidden audio and retain reused occurrences", () => {
    const p = project();
    const srt = buildSrt(p),
      vtt = buildVtt(p);
    expect(srt).toContain("idempotency are not the serveur.");
    expect(vtt).toContain("00:00:00.000 --> 00:00:03.000");
    expect(srt).toContain("item potency aren’t the old server.");
    expect(srt.match(/idempotency/g)).toHaveLength(1);
  });
});

describe("explicit project history", () => {
  it("groups consecutive typing, with atomic cut undo/redo and correct dirty state", () => {
    const initial = useProjectStore.getState().project;
    useProjectStore.getState().correctBlock("s1", "block-1", "REST are not the serveur.", initial);
    const typed = useProjectStore.getState().project;
    useProjectStore.getState().correctBlock("s1", "block-1", "REST are not the server.", typed);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(1);
    endTypingGroup();
    const beforeCut = useProjectStore.getState().project;
    const b = projectTranscript(beforeCut)[0]!;
    useProjectStore.getState().cutSpeech([{ ...range, to: b.runs[0]!.to }], beforeCut);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(2);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(beforeCut);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(initial);
    expect(useProjectStore.getState().dirty).toBe(false);
    useProjectStore.temporal.getState().redo();
    expect(useProjectStore.getState().project).toBe(beforeCut);
    expect(useProjectStore.getState().dirty).toBe(true);
  });
});

it("restoration only changes the selected occurrence and all edit operations keep originals recoverable", () => {
  const p = project();
  const b = projectTranscript(p)[1]!;
  const edited = replaceTranscriptText(p, {
    segmentId: b.segmentId,
    blockId: b.id,
    from: 0,
    to: 12,
    text: "REST",
  });
  const restored = restoreTranscriptBlock(edited, b.segmentId, b.id);
  expect(projectTranscript(restored)[0]!.text).toBe("idempotency are not the serveur.");
  expect(projectTranscript(restored)[1]!.text).toBe("item potency aren’t the old server.");
  expect(restored.segments.map((s) => [s.sourceIn, s.sourceOut, s.words])).toEqual(
    p.segments.map((s) => [s.sourceIn, s.sourceOut, s.words]),
  );
});

it("repeated literal phrase replacements inside one timing group use original offsets atomically", () => {
  let p = project();
  p = editBlockText(p, "s1", "block-1", "post post post");
  const next = replaceTranscriptBatch(
    p,
    p,
    [0, 5, 10].map((from) => ({ ...range, from, to: from + 4, text: "POST" })),
  );
  expect(projectTranscript(next)[0]!.text).toBe("POST POST POST");
  expect(totalDuration(next)).toBe(6);
});

it("rejects unsupported cross-paragraph editor replacements and preserves model version stability", () => {
  const p = project();
  const before = JSON.stringify(p);
  expect(() =>
    applyTranscriptDocument(p, [{ segmentId: "s1", blockId: "forged", text: "replacement" }]),
  ).toThrow();
  expect(JSON.stringify(p)).toBe(before);
});
