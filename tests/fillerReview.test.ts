import { beforeEach, describe, expect, it } from "vitest";
import {
  addMediaWithTranscript,
  deleteWords,
  newProject,
  removeSilences,
  splitSegmentAtWord,
  type Project,
} from "@/lib/edl";
import { defaultFillerPolicy, matchFillers, normalizeFillerPolicy } from "@/lib/fillers";
import {
  fillerCandidates,
  occurrenceLineage,
  reconcileFillerReview,
  validateFillerReview,
  withFillerPolicy,
  type FillerCandidate,
} from "@/lib/fillerReview";
import {
  normalizeProjectTranscripts,
  projectTranscript,
  validateProjectTranscripts,
} from "@/lib/transcript";
import {
  replaceTranscriptText,
  restoreTranscriptBlock,
  splitTranscriptBlock,
} from "@/lib/transcriptEdits";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import reviewFixture from "./fixtures/filler-review.json";
import fixture from "./fixtures/transcript-corrections.json";

function project(text = "Hello [AH] [UM] [UH] like you know world."): Project {
  const media = structuredClone(fixture.media.m1);
  return addMediaWithTranscript(
    newProject("Fillers"),
    media,
    text.split(" ").map((word, i) => ({
      id: `w${i}`,
      text: word,
      start: i * 0.5,
      end: i * 0.5 + 0.3,
      confidence: 0.9,
    })),
  );
}
function decided(
  p: Project,
  c = fillerCandidates(p)[0]!,
  outcome: "kept" | "text-removed" = "kept",
): Project {
  return {
    ...p,
    fillerReview: {
      version: 1,
      policy: p.fillerReview?.policy ?? defaultFillerPolicy(),
      decisions: [
        {
          candidateId: c.id,
          fingerprint: c.fingerprint,
          mediaId: c.mediaId,
          occurrenceLineage: c.occurrenceLineage,
          anchorIds: c.anchorIds,
          outcome,
        },
      ],
    },
  };
}
function removeText(p: Project, c: FillerCandidate): Project {
  // Include surrounding punctuation when hiding the entire recognition run.
  const block = projectTranscript(p).find((b) => b.id === c.blockId)!;
  const run = block.runs.find((r) => r.anchorIds[0] === c.anchorIds[0])!;
  return replaceTranscriptText(p, {
    segmentId: c.segmentId,
    blockId: c.blockId,
    from: run.from,
    to: run.to,
    text: "",
  });
}

beforeEach(() => replaceProjectBaseline(project()));

describe("literal filler policy", () => {
  it("matches the vocal inventory, bracketed spelling and punctuation without enabling ordinary discourse words", () => {
    const text =
      "😊 [AH], [UM] [UH]! Umm UHH ahh er ERR erm hm HMM like so mm mhm [LAUGH] album uh-huh";
    expect(matchFillers(text).map((m) => text.slice(m.from, m.to))).toEqual([
      "[AH]",
      "[UM]",
      "[UH]",
      "Umm",
      "UHH",
      "ahh",
      "er",
      "ERR",
      "erm",
      "hm",
      "HMM",
    ]);
  });
  it("opts into whole phrases and deterministically resolves overlaps longest-first", () => {
    const policy = normalizeFillerPolicy({
      optional: ["LIKE", "You know"],
      custom: ["you", "you know like", " you KNOW like "],
    });
    expect(policy.custom).toEqual(["you", "you know like"]);
    expect(matchFillers("you know like likelihood you know", policy).map((m) => m.rule)).toEqual([
      "you know like",
      "you know",
    ]);
    expect(matchFillers("you. Know", policy)).toHaveLength(1); // only the custom single word
    expect(() => normalizeFillerPolicy({ optional: ["unknown"], custom: [] })).toThrow();
    expect(() => normalizeFillerPolicy({ optional: [], custom: [".*uh+"] })).toThrow(/literal/);
    expect(() => normalizeFillerPolicy({ optional: [], custom: [" "] })).toThrow();
  });
});

describe("candidate projection and reconciliation", () => {
  it("validates the shared native serialization fixture", () => {
    const p = structuredClone(reviewFixture) as Project;
    validateProjectTranscripts(p);
    expect(fillerCandidates(p).filter((c) => c.outcome === "text-removed")).toHaveLength(1);
  });
  it("is pure and detects separate bracketed occurrences in output order", () => {
    const state = useProjectStore.getState();
    const before = JSON.stringify(state.project);
    const history = useProjectStore.temporal.getState().pastStates.length;
    expect(fillerCandidates(state.project).map((c) => c.text)).toEqual(["[AH]", "[UM]", "[UH]"]);
    expect(JSON.stringify(state.project)).toBe(before);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(history);
  });
  it("recovers hidden audio but never resurrects corrected visible words", () => {
    let p = project();
    const c = fillerCandidates(p)[0]!;
    p = removeText(p, c);
    const hidden = fillerCandidates(p).find((item) => item.id === c.id)!;
    expect(hidden).toMatchObject({ hidden: true, text: "[AH]", sourceStart: 0.5, sourceEnd: 0.8 });
    p = restoreTranscriptBlock(p, c.segmentId, c.blockId);
    p = replaceTranscriptText(p, {
      segmentId: c.segmentId,
      blockId: c.blockId,
      from: c.from,
      to: c.to,
      text: "apple",
    });
    expect(fillerCandidates(p).some((item) => item.anchorIds.includes("w1"))).toBe(false);
  });
  it("detects visible merged groups conservatively and does not bridge hidden audio", () => {
    let p = normalizeProjectTranscripts(project("Hello um world."));
    const b = projectTranscript(p)[0]!;
    p = replaceTranscriptText(p, {
      segmentId: b.segmentId,
      blockId: b.id,
      from: 0,
      to: 8,
      text: "Hello UM",
    });
    expect(fillerCandidates(p)[0]).toMatchObject({ grouped: true, anchorIds: ["w0", "w1"] });
    let q = withFillerPolicy(project("you uh know world."), { optional: ["you know"], custom: [] });
    q = removeText(q, fillerCandidates(q)[0]!);
    expect(fillerCandidates(q).map((c) => c.rule)).toEqual(["uh"]);
  });
  it("keeps repeated placements distinct and preserves identity through legacy splits and cuts", () => {
    const p = project();
    const original = p.segments[0]!;
    const repeated = { ...p, segments: [original, { ...original, id: "repeat" }] };
    const ids = fillerCandidates(repeated).map((c) => c.id);
    expect(new Set(ids).size).toBe(6);
    const c = fillerCandidates(p)[1]!;
    const kept = decided(p, c);
    const split = reconcileFillerReview({ ...kept, segments: splitSegmentAtWord(original, 2) });
    validateProjectTranscripts(split);
    expect(fillerCandidates(split).find((item) => item.id === c.id)?.outcome).toBe("kept");
    const cut = deleteWords(kept, new Set(["w1"]));
    validateProjectTranscripts(cut);
    expect(fillerCandidates(cut).find((item) => item.id === c.id)?.outcome).toBe("kept");
    expect(deleteWords(kept, new Set(["w2"])).fillerReview!.decisions).toEqual([]);
    expect(() =>
      validateFillerReview({
        ...split,
        segments: [...split.segments, { ...split.segments[0]!, id: "duplicate" }],
      }),
    ).toThrow(/distinct/);
  });
  it("reconciles silence splits, policy changes, grouping edits, and text restoration", () => {
    let p = project();
    p.segments[0]!.words[2]!.start += 0.2;
    const c = fillerCandidates(p)[1]!;
    p = decided(p, c);
    const [trimmed] = removeSilences(p, { gapMs: 300, paddingMs: 0 });
    expect(fillerCandidates(trimmed).find((item) => item.id === c.id)?.outcome).toBe("kept");
    let q = withFillerPolicy(project(), { optional: ["like"], custom: [] });
    const like = fillerCandidates(q).find((item) => item.rule === "like")!;
    q = decided(q, like);
    expect(withFillerPolicy(q, defaultFillerPolicy()).fillerReview!.decisions).toEqual([]);
    const baseline = project();
    const hidden = removeText(baseline, fillerCandidates(baseline)[0]!);
    const resolved = decided(
      hidden,
      fillerCandidates(hidden).find((item) => item.hidden)!,
      "text-removed",
    );
    expect(
      restoreTranscriptBlock(resolved, resolved.segments[0]!.id, projectTranscript(resolved)[0]!.id)
        .fillerReview!.decisions,
    ).toEqual([]);
  });
  it("rejects stale/foreign records and restores metadata atomically with project undo/redo", () => {
    const p = useProjectStore.getState().project;
    const kept = decided(p);
    validateFillerReview(kept);
    expect(JSON.parse(JSON.stringify(kept))).toEqual(kept);
    useProjectStore.getState().commitTranscript(kept, p);
    useProjectStore.temporal.getState().undo();
    expect(useProjectStore.getState().project).toBe(p);
    useProjectStore.temporal.getState().redo();
    expect(useProjectStore.getState().project).toBe(kept);
    const bad = structuredClone(kept);
    bad.fillerReview!.decisions[0]!.fingerprint = "stale";
    expect(() => validateFillerReview(bad)).toThrow(/stale/);
    expect(() => useProjectStore.getState().commitTranscript(p, p)).toThrow(/changed/);
    expect(occurrenceLineage(kept.segments[0]!)).toBe(fillerCandidates(kept)[0]!.occurrenceLineage);
  });
});

it("preserves legacy padding overlap when split fragments have disjoint anchors", () => {
  const p = project("Hello uh world.");
  p.segments[0]!.words = [
    { id: "a", text: "Hello", start: 0, end: 1, confidence: 1 },
    { id: "b", text: "uh", start: 1, end: 1.05, confidence: 1 },
    { id: "c", text: "world.", start: 1.05, end: 2, confidence: 1 },
  ];
  const cut = deleteWords(p, new Set(["b"]));
  expect(cut.segments[0]!.sourceOut).toBeGreaterThan(cut.segments[1]!.sourceIn);
  expect(() => validateProjectTranscripts(cut)).not.toThrow();
});

it("recovers originals in fully hidden groups while retaining the group restriction", () => {
  let p = project("Hello um world.");
  const block = projectTranscript(p)[0]!;
  p = replaceTranscriptText(p, {
    segmentId: block.segmentId,
    blockId: block.id,
    from: 0,
    to: 8,
    text: "",
  });
  expect(fillerCandidates(p)[0]).toMatchObject({
    hidden: true,
    grouped: true,
    anchorIds: ["w1"],
    sourceStart: 0.5,
    sourceEnd: 0.8,
  });
});

it("does not match phrases across paragraphs or segment boundaries", () => {
  const p = withFillerPolicy(project("you know world."), { optional: ["you know"], custom: [] });
  expect(fillerCandidates(p)).toHaveLength(1);
  const block = projectTranscript(p)[0]!;
  const paragraphs = splitTranscriptBlock(p, block.segmentId, block.id, 3);
  expect(fillerCandidates(paragraphs)).toHaveLength(0);
  const segments = { ...p, segments: splitSegmentAtWord(p.segments[0]!, 1) };
  expect(fillerCandidates(segments)).toHaveLength(0);
});

it("persists policy changes as one undoable project edit and avoids no-op history", () => {
  const p = useProjectStore.getState().project;
  expect(withFillerPolicy(p, defaultFillerPolicy())).toBe(p);
  const next = withFillerPolicy(p, { optional: ["like"], custom: ["you know"] });
  useProjectStore.getState().commitTranscript(next, p);
  expect(fillerCandidates(next).map((c) => c.rule)).toEqual(["ah", "um", "uh", "like", "you know"]);
  expect(useProjectStore.getState().dirty).toBe(true);
  useProjectStore.temporal.getState().undo();
  expect(useProjectStore.getState().project).toBe(p);
  expect(useProjectStore.getState().dirty).toBe(false);
});
