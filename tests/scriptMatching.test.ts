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
  it.each(["’", "‘", "ʼ", "＇"])(
    "ignores %s versus straight apostrophes in either direction",
    async (apostrophe) => {
      const straight = "We don't change the user's or users' wording here.";
      const styled = straight.replaceAll("'", apostrophe);
      for (const [spoken, written] of [
        [straight, styled],
        [styled, straight],
      ]) {
        const p = await fixture(spoken!, written!);
        const before = structuredClone(p);
        expect(scriptCandidates(p)).toEqual([]);
        expect(p).toEqual(before);
      }
    },
  );
  it("still proposes punctuation and wording changes alongside apostrophe differences", async () => {
    const p = await fixture("We don't use the old server", "We don’t use the new server.");
    expect(scriptCandidates(p)).toContainEqual(
      expect.objectContaining({ kind: "wording", beforeText: "old", afterText: "new" }),
    );
    const formatted = await fixture("We don't use this server", "We don’t use this server.");
    expect(scriptCandidates(formatted)).toEqual([
      expect.objectContaining({ kind: "punctuation", beforeText: "server", afterText: "server." }),
    ]);
    const missing = await fixture("We dont use this server.", "We don’t use this server.");
    expect(scriptCandidates(missing)).toContainEqual(
      expect.objectContaining({ kind: "wording", beforeText: "dont", afterText: "don’t" }),
    );
  });
  it("flags a truncated restart including the hyphen as one complete timed word", async () => {
    const p = await fixture(
      "The editor generates docu- documentation for this example.",
      "The editor generates documentation for this example.",
    );
    const candidate = scriptCandidates(p).find((c) => c.kind === "off-script");
    expect(candidate).toMatchObject({ beforeText: "docu-", afterText: "docu-", actionable: true });
    const b = projectTranscript(p)[0]!,
      run = b.runs.find((r) => r.text === "docu-")!;
    expect(candidate!.from).toBe(run.from);
    expect(candidate!.to).toBe(run.to);
    const partial = scriptCandidates(p, [
      { segmentId: b.segmentId, blockId: b.id, from: run.from, to: run.to - 1 },
    ]).find((c) => c.kind === "off-script");
    expect(partial!.actionable).toBe(false);
  });
  it("leaves vocal fillers to filler review instead of proposing a scripted cue", async () => {
    const p = await fixture(
      "[UH] We need a precise way to describe this example.",
      "[now] We need a precise way to describe this example.",
    );
    expect(
      scriptCandidates(p).filter(
        (c) => c.beforeText.includes("[UH]") && c.afterText !== c.beforeText,
      ),
    ).toEqual([]);
  });
  it.each([
    [
      "We use version three point one for this detailed example.",
      "We use version 3.1 for this detailed example.",
      "three point one",
      "3.1",
    ],
    [
      "The service returns two OH two accepted for this request.",
      "The service returns 202 accepted for this request.",
      "two OH two",
      "202",
    ],
    [
      "The service returns two O two accepted for this request.",
      "The service returns 202 accepted for this request.",
      "two O two",
      "202",
    ],
  ])("proposes exact numeric notation: %s", async (spoken, written, beforeText, afterText) => {
    const p = await fixture(spoken, written);
    expect(scriptCandidates(p)).toContainEqual(
      expect.objectContaining({ beforeText, afterText, kind: "notation" }),
    );
  });
  it("never supplies a different number or truncates a longer spoken version", async () => {
    for (const spoken of [
      "We use version three point two for this detailed example.",
      "We use version three point one point two for this detailed example.",
    ]) {
      const p = await fixture(spoken, "We use version 3.1 for this detailed example.");
      expect(scriptCandidates(p).some((c) => c.kind === "notation" && c.afterText === "3.1")).toBe(
        false,
      );
    }
  });
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
