import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addMediaWithTranscript, newProject, computeTimeline, type Project } from "@/lib/edl";
import {
  prepareScript,
  replaceStoredScript,
  validateScriptAssistance,
} from "@/lib/scriptAssistance";
import { automaticScriptLocations, scriptCandidates } from "@/lib/scriptMatching";
import {
  locateScriptSync,
  removeScriptSync,
  scriptSections,
  setScriptSync,
} from "@/lib/scriptSync";
import { normalizeProjectTranscripts, projectTranscript } from "@/lib/transcript";
import { cutTranscriptRanges, splitTranscriptBlock } from "@/lib/transcriptEdits";
import fixture from "./fixtures/transcript-corrections.json";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
async function setup(
  text = "Alpha bravo charly delta.",
  script = "## One\n\nAlpha bravo Charlie delta.\n\n## Two\n\nAlpha bravo cherry delta.",
) {
  const p = addMediaWithTranscript(
    newProject("Script sync"),
    { ...fixture.media.m1, duration: 1000 },
    text.split(" ").map((text, i) => ({
      id: `word-${i}`,
      text,
      start: i * 0.1,
      end: i * 0.1 + 0.08,
      confidence: 1,
    })),
  );
  return replaceStoredScript(p, await prepareScript(script, "script.md"));
}
function ranges(p: Project) {
  return projectTranscript(p).map((b) => ({
    segmentId: b.segmentId,
    blockId: b.id,
    from: 0,
    to: b.text.length,
  }));
}

describe("script matching windows and explicit sync", () => {
  it("matches a recognition paragraph spanning multiple script paragraphs", async () => {
    const p = await setup(
      "Alpha bravo charly delta echo foxtrot golf hotel.",
      "## One\n\nAlpha bravo Charlie delta.\n\nEcho foxtrot golf hotel.",
    );
    expect(scriptCandidates(p)).toContainEqual(
      expect.objectContaining({ beforeText: "charly", afterText: "Charlie", kind: "wording" }),
    );
    expect(
      scriptCandidates(p).some((c) => c.kind === "uncertain" && c.beforeText.includes("Alpha")),
    ).toBe(false);
  });
  it("can match a transcript paragraph spanning a slide heading without inserting heading text", async () => {
    const p = await setup(
      "Alpha bravo charly delta echo foxtrot golf hotel.",
      "## First slide\n\nAlpha bravo Charlie delta.\n\n## Second slide\n\nEcho foxtrot golf hotel.",
    );
    expect(scriptCandidates(p)).toContainEqual(
      expect.objectContaining({ beforeText: "charly", afterText: "Charlie", kind: "wording" }),
    );
    expect(scriptCandidates(p).some((candidate) => /slide/iu.test(candidate.afterText))).toBe(
      false,
    );
  });
  it("deduplicates matching windows inside long script sections", async () => {
    const script = Array.from({ length: 2000 }, (_v, i) => `term${i}`).join(" ");
    const text = Array.from({ length: 200 }, (_v, i) =>
      i === 50 ? "incorrect" : `term${i + 1200}`,
    ).join(" ");
    const p = await setup(text, `## Long section\n\n${script}`);
    const candidate = scriptCandidates(p).find((c) => c.beforeText === "incorrect");
    expect(candidate).toMatchObject({ kind: "wording", afterText: "term1250" });
  });
  it("batches long transcript paragraphs without dropping text or changing offsets", async () => {
    const words = Array.from({ length: 700 }, (_v, i) => `term${i}`);
    const script = Array.from({ length: 7 }, (_v, i) =>
      words.slice(i * 100, i * 100 + 100).join(" "),
    ).join("\n\n");
    words[500] = "incorrect";
    const p = await setup(words.join(" "), `## Long section\n\n${script}`);
    const before = JSON.stringify(p);
    const candidate = scriptCandidates(p).find((c) => c.afterText === "term500")!;
    expect(candidate).toBeDefined();
    expect(projectTranscript(p)[0]!.text.slice(candidate.from, candidate.to)).toBe("incorrect");
    expect(JSON.stringify(p)).toBe(before);
  });
  it("uses a user link to resolve repeated script contexts without changing speech", async () => {
    const original = normalizeProjectTranscripts(await setup());
    const take = structuredClone(original.segments[0]!);
    take.id = "second-take";
    take.transcript!.occurrenceId = "second-take";
    const p = { ...original, segments: [original.segments[0]!, take] };
    expect(scriptCandidates(p).filter((c) => c.kind === "uncertain")).toHaveLength(2);
    const next = setScriptSync(p, [ranges(p)[0]!], scriptSections(p)[0]!);
    expect(scriptCandidates(next)).toContainEqual(
      expect.objectContaining({
        segmentId: p.segments[0]!.id,
        beforeText: "charly",
        afterText: "Charlie",
        kind: "wording",
      }),
    );
    expect(
      scriptCandidates(next).some((c) => c.segmentId === take.id && c.kind === "uncertain"),
    ).toBe(true);
    expect(next.segments).toBe(p.segments);
    expect(computeTimeline(next)).toEqual(computeTimeline(p));
    const reopened = JSON.parse(JSON.stringify(next)) as Project;
    validateScriptAssistance(reopened);
    expect(locateScriptSync(reopened, reopened.scriptAssistance!.syncLinks![0]!)).toHaveLength(1);
    expect(scriptCandidates(reopened).some((c) => c.afterText === "Charlie")).toBe(true);
    expect(
      removeScriptSync(next, next.scriptAssistance!.syncLinks![0]!.id).scriptAssistance!.syncLinks,
    ).toEqual([]);
  });
  it("re-resolves after paragraph splits, but stops using a link whose audio was removed", async () => {
    const p = await setup();
    const linked = setScriptSync(p, ranges(p), scriptSections(p)[0]!);
    const link = linked.scriptAssistance!.syncLinks![0]!;
    const b = projectTranscript(linked)[0]!;
    const split = splitTranscriptBlock(linked, b.segmentId, b.id, b.runs[2]!.from);
    expect(locateScriptSync(split, link)).toHaveLength(2);
    const cut = cutTranscriptRanges(linked, [
      { segmentId: b.segmentId, blockId: b.id, from: b.runs[1]!.from, to: b.runs[1]!.to },
    ]);
    expect(locateScriptSync(cut, link)).toBeNull();
    validateScriptAssistance(cut);
    const replacement = replaceStoredScript(
      linked,
      await prepareScript("A replacement script with new sections.", "new.md"),
    );
    expect(replacement.scriptAssistance!.syncLinks).toBeUndefined();
  });
  it("rejects partial paragraphs, invalid script ranges and links across different takes", async () => {
    const p = normalizeProjectTranscripts(await setup());
    expect(() => setScriptSync(p, [{ ...ranges(p)[0]!, to: 5 }], scriptSections(p)[0]!)).toThrow(
      /complete transcript/,
    );
    expect(() => setScriptSync(p, ranges(p), { from: 0, to: 1 })).toThrow(
      /complete script section/,
    );
    const duplicate = structuredClone(p.segments[0]!);
    duplicate.id = "other";
    duplicate.transcript!.occurrenceId = "other";
    const repeated = { ...p, segments: [p.segments[0]!, duplicate] };
    expect(() => setScriptSync(repeated, ranges(repeated), scriptSections(repeated)[0]!)).toThrow(
      /one recorded take/,
    );
  });
});

it("suggests slide locations without rewriting the project and leaves repeated or unrelated wording unassigned", async () => {
  const p = await setup(
    "Alpha bravo charly delta. Later words here.",
    `## One

Alpha bravo Charlie delta.

## Two

Later words here.`,
  );
  const before = JSON.stringify(p);
  const matches = [...automaticScriptLocations(p)];
  expect(matches.filter(Boolean).map((m) => m!.sectionFrom)).toEqual(
    scriptSections(p).map((s) => s.from),
  );
  expect(JSON.stringify(p)).toBe(before);
  const repeated = await setup(
    "Alpha bravo charly delta.",
    `## One

Alpha bravo Charlie delta.

## Two

Alpha bravo cherry delta.`,
  );
  expect([...automaticScriptLocations(repeated)]).toEqual([null]);
  const unrelated = await setup(
    "Completely unrelated remarks about something else.",
    `## One

Alpha bravo Charlie delta.`,
  );
  expect([...automaticScriptLocations(unrelated)]).toEqual([null]);
});
