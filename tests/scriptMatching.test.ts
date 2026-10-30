import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newProject, type Project, type Segment } from "@/lib/edl";
import { prepareScript, replaceStoredScript } from "@/lib/scriptAssistance";
import { scriptCandidates, scriptRunProtected } from "@/lib/scriptMatching";
import { normalizeProjectTranscripts, projectTranscript } from "@/lib/transcript";
import { replaceTranscriptText, restoreTranscriptBlock } from "@/lib/transcriptEdits";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
async function fixture(text: string, script: string, repeated = false): Promise<Project> {
  const p = newProject("Synthetic matching test");
  p.media.m = {
    id: "m",
    path: "/tmp/synthetic.mp4",
    sha256: "synthetic",
    duration: 100,
    fps: 30,
    width: 640,
    height: 360,
    audioSampleRate: 16000,
  };
  const segment: Segment = {
    id: "s",
    mediaId: "m",
    sourceIn: 0,
    sourceOut: 50,
    words: text.split(" ").map((word, i) => ({
      id: `w${i}`,
      text: word,
      start: i * 0.3,
      end: i * 0.3 + 0.25,
      confidence: 1,
    })),
  };
  p.segments = repeated ? [segment, { ...segment, id: "reuse" }] : [segment];
  return replaceStoredScript(p, await prepareScript(script, "synthetic.md"));
}
describe("pure script matching and scope", () => {
  it("isolates a spoken name alias without removing an adjacent aside or filler", async () => {
    const p = await fixture(
      "We will follow hail me in this [UH] class from a message to a contract.",
      "We will follow HailMe from a message to a contract.",
    );
    const candidates = scriptCandidates(p);
    expect(candidates.find((c) => c.kind === "wording")).toMatchObject({
      beforeText: "hail me",
      afterText: "HailMe",
    });
    expect(candidates.find((c) => c.kind === "off-script")).toMatchObject({
      beforeText: "in this [UH] class",
      afterText: "in this [UH] class",
    });
  });
  it("uses neighboring surviving speech to avoid appending a skipped next sentence", async () => {
    const p = await fixture(
      "Safety and item potency. We will connect this to the notation you already know.",
      "Safety and idempotency.\nWe will connect this to the notation you already know.",
    );
    const candidate = scriptCandidates(p).find((c) => c.kind === "wording");
    expect(candidate).toMatchObject({ beforeText: "item potency.", afterText: "idempotency." });
    expect(candidate!.afterText).not.toContain("We will");
  });
  it("does not replace a repeated word with the next scripted word across a pause", async () => {
    const p = await fixture(
      "Consumers should not relearn GET basic basic meaning for every URL.",
      "Consumers should not relearn GET basic meaning for every URL.",
    );
    const index = p.segments[0]!.words.findIndex((w) => w.text === "meaning");
    p.segments[0]!.words.slice(index).forEach((w) => {
      w.start += 1;
      w.end += 1;
    });
    const candidates = scriptCandidates(p);
    expect(candidates.some((c) => c.beforeText === "basic" && c.afterText === "meaning")).toBe(
      false,
    );
    expect(candidates.some((c) => c.kind === "uncertain")).toBe(true);
  });
  it("stages a multiword-to-single-word candidate without mutation", async () => {
    const p = await fixture(
      "Safety and item potency are useful concepts.",
      "# Unspoken\n\nSafety and idempotency are useful concepts.",
    );
    const before = JSON.stringify(p),
      candidates = scriptCandidates(p);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      beforeText: "item potency",
      afterText: "idempotency",
      kind: "wording",
      protected: false,
      actionable: true,
    });
    expect(JSON.stringify(p)).toBe(before);
  });
  it("does not force a unique match for repeated script passages", async () => {
    const p = await fixture(
      "The query returns all items.",
      "The query returns all items.\n\nThe query returns all items.",
    );
    expect(scriptCandidates(p)[0]).toMatchObject({
      kind: "uncertain",
      beforeText: "The query returns all items.",
    });
  });
  it("locates selected speech against the full script without changing other occurrences", async () => {
    const p = await fixture(
      "Safety and item potency are useful concepts.",
      "# Start\n\nSomething unrelated is said here.\n\nSafety and idempotency are useful concepts.",
      true,
    );
    const b = projectTranscript(p)[1]!;
    const candidates = scriptCandidates(p, [
      { segmentId: b.segmentId, blockId: b.id, from: 11, to: 23 },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.segmentId).toBe("reuse");
    expect(scriptCandidates(p)).toHaveLength(2);
  });
  it("formats matching spoken notation but never substitutes a different value", async () => {
    const script = "Look at GET /payments/P456 for details.";
    const good = await fixture(
      "Look at get slash payments slash P four five six for details.",
      script,
    );
    expect(scriptCandidates(good).find((c) => c.kind === "notation")).toMatchObject({
      beforeText: "get slash payments slash P four five six",
      afterText: "GET /payments/P456",
    });
    const different = await fixture(
      "Look at get slash payments slash P seven eight nine for details.",
      script,
    );
    expect(scriptCandidates(different).some((c) => c.kind === "notation")).toBe(false);
  });
  it("never inserts skipped script sentences or deletes script-mismatched speech", async () => {
    const p = await fixture(
      "A query returns the useful items.",
      "A query returns the items.\n\nNever insert this skipped line.",
    );
    const candidates = scriptCandidates(p);
    expect(candidates.some((c) => c.afterText.includes("skipped"))).toBe(false);
    expect(candidates.find((c) => c.kind === "off-script")).toMatchObject({
      beforeText: "useful",
      afterText: "useful",
    });
  });
  it("distinguishes uncertain alignment from evidence of off-script speech", async () => {
    const p = await fixture(
      "A completely intentional explanation about birds.",
      "An HTTP method has defined semantics.",
    );
    expect(scriptCandidates(p)).toEqual([expect.objectContaining({ kind: "uncertain" })]);
  });
  it("does not mistake normalized overlays for manual edits and protects restored text", async () => {
    const p = normalizeProjectTranscripts(
      await fixture(
        "Safety and item potency are useful concepts.",
        "Safety and idempotency are useful concepts.",
      ),
    );
    const block = projectTranscript(p)[0]!;
    expect(block.runs.every((r) => !scriptRunProtected(r))).toBe(true);
    const restored = restoreTranscriptBlock(p, block.segmentId, block.id);
    expect(scriptCandidates(restored)[0]!.protected).toBe(true);
  });
  it("protects hidden and manually corrected groups, including partial selections", async () => {
    const p = await fixture(
      "Safety and item potency are useful concepts.",
      "Safety and idempotency are useful concepts.",
    );
    const b = projectTranscript(p)[0]!;
    const manual = replaceTranscriptText(p, {
      segmentId: b.segmentId,
      blockId: b.id,
      from: 11,
      to: 23,
      text: "item potency",
    });
    // A no-op is not an edit; create a real manually merged group then restore spelling.
    const merged = replaceTranscriptText(manual, {
      segmentId: b.segmentId,
      blockId: b.id,
      from: 11,
      to: 23,
      text: "ITEM POTENCY",
    });
    expect(scriptCandidates(merged)[0]!.protected).toBe(true);
    const selected = scriptCandidates(merged, [
      { segmentId: b.segmentId, blockId: b.id, from: 12, to: 23 },
    ]);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((c) => !c.actionable)).toBe(true);
  });
  it("keeps punctuation separate from wording and excludes heading text", async () => {
    const p = await fixture(
      "a query returns all items",
      "# Do not speak this heading\n\nA query returns all items.",
    );
    expect(scriptCandidates(p)).toEqual([
      expect.objectContaining({ kind: "punctuation", beforeText: "a", afterText: "A" }),
      expect.objectContaining({ kind: "punctuation", beforeText: "items", afterText: "items." }),
    ]);
    expect(scriptCandidates(p).some((c) => c.afterText.includes("heading"))).toBe(false);
  });
  it("does not classify altered technical symbols or identifier case as simple punctuation", async () => {
    const p = await fixture("Use API1 with x y now.", "Use api1 with x-y now.");
    expect(scriptCandidates(p).filter((c) => c.kind === "punctuation")).toHaveLength(0);
    expect(scriptCandidates(p).some((c) => c.kind === "uncertain")).toBe(true);
  });
});
