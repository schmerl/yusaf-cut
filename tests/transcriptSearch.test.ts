import { describe, expect, it } from "vitest";
import fixture from "./fixtures/transcript-corrections.json";
import { computeTimeline, type Project } from "@/lib/edl";
import { projectTranscript } from "@/lib/transcript";
import { findTranscriptMatches, transcriptMatchContexts } from "@/lib/transcriptSearch";
import {
  cutTranscriptRanges,
  editBlockText,
  originalTranscriptPassage,
  replaceTranscriptBatch,
  restoreTranscriptRange,
} from "@/lib/transcriptEdits";
const project = () => structuredClone(fixture) as Project;
const range = { segmentId: "s1", blockId: "block-1", from: 0, to: 11 };
const withText = (text: string) => editBlockText(project(), "s1", "block-1", text);

describe("projected literal search", () => {
  it("finds phrases across raw records and corrected groups in output order, excluding hidden words", () => {
    const p = project();
    expect(findTranscriptMatches(p, "potency aren’t")).toMatchObject([
      { segmentId: "s2", from: 5, to: 19 },
    ]);
    expect(findTranscriptMatches(p, "idempotency are not")).toHaveLength(1);
    expect(findTranscriptMatches(p, "old")).toMatchObject([{ segmentId: "s2" }]);
    expect(findTranscriptMatches(p, "serveur. item")).toHaveLength(0);
  });
  it("uses Unicode code points, combining marks and connectors for whole-word boundaries", () => {
    const p = withText("post POST posting épost posté post\u0301 post_ 𐐀post post𐐀 (post).");
    expect(findTranscriptMatches(p, "post")).toHaveLength(3);
    expect(findTranscriptMatches(p, "post", { caseSensitive: true })).toHaveLength(2);
    expect(findTranscriptMatches(p, "post", { wholeWord: false })).toHaveLength(10);
  });
  it("handles literal metacharacters, nonoverlap, case folding and literal replacement punctuation", () => {
    const p = withText("[a.*] [A.*] aaaa");
    const matches = findTranscriptMatches(p, "[a.*]");
    expect(matches).toHaveLength(2);
    const next = replaceTranscriptBatch(
      p,
      p,
      matches.map((m) => ({ ...m, text: "$& POST!" })),
    );
    expect(projectTranscript(next)[0]!.text).toBe("$& POST! $& POST! aaaa");
    expect(findTranscriptMatches(p, "aa", { wholeWord: false })).toHaveLength(2);
    expect(findTranscriptMatches(p, "")).toHaveLength(0);
  });
  it("rejects a stale or invalid Replace all without committing any partial batch", () => {
    const p = withText("post");
    const matches = findTranscriptMatches(p, "post");
    expect(() =>
      replaceTranscriptBatch(
        p,
        p,
        matches.map((m) => ({ ...m, text: "" })),
      ),
    ).toThrow(/retain text/);
    expect(() =>
      replaceTranscriptBatch(
        project(),
        p,
        matches.map((m) => ({ ...m, text: "POST" })),
      ),
    ).toThrow(/changed/);
    expect(projectTranscript(p)[0]!.text).toBe("post");
  });
});

describe("selected original restoration", () => {
  it("expands partial corrected groups, preserves unrelated edits and survives serialization", () => {
    const p = JSON.parse(JSON.stringify(withText("idempotency are not the SERVER."))) as Project;
    const selection = { ...range, from: 2, to: 5 };
    expect(originalTranscriptPassage(p, selection)).toMatchObject({
      originalText: "item potency",
      expanded: true,
    });
    const next = restoreTranscriptRange(p, p, selection);
    expect(projectTranscript(next)[0]!.text).toBe("item potency are not the SERVER.");
    expect(projectTranscript(next)[1]!.text).toBe(projectTranscript(p)[1]!.text);
    expect(computeTimeline(next)).toEqual(computeTimeline(p));
    expect(() => restoreTranscriptRange(next, p, selection)).toThrow(/changed/);
  });
  it("recovers hidden words after other speech is cut, preserving the cut and other corrections", () => {
    const p = cutTranscriptRanges(project(), [range]);
    const b = projectTranscript(p)[0]!;
    const selection = { segmentId: b.segmentId, blockId: b.id, from: 0, to: b.text.length };
    expect(originalTranscriptPassage(p, selection).originalText).toBe("aren’t the old server.");
    const next = restoreTranscriptRange(p, p, selection);
    expect(projectTranscript(next)[0]!.text).toBe("aren’t the old server.");
    expect(computeTimeline(next)).toEqual(computeTimeline(p));
    expect(() => originalTranscriptPassage(p, { ...selection, blockId: "gone" })).toThrow(
      /changed/,
    );
  });
});

it("merges token context for multiple partial hits and preserves Unicode/phrase bounds", () => {
  expect(
    transcriptMatchContexts("POSTPOST", [
      { from: 0, to: 2 },
      { from: 4, to: 6 },
    ]),
  ).toEqual([{ from: 0, to: 8 }]);
  expect(
    transcriptMatchContexts("𐐀post cafe\u0301", [
      { from: 2, to: 4 },
      { from: 7, to: 10 },
    ]),
  ).toEqual([
    { from: 0, to: 6 },
    { from: 7, to: 12 },
  ]);
  expect(transcriptMatchContexts("POST server.", [{ from: 2, to: 7 }])).toEqual([
    { from: 0, to: 11 },
  ]);
});
