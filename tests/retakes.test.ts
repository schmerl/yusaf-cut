import { describe, expect, it } from "vitest";
import {
  groupRetakes,
  hypothesisOptions,
  lexicalRetakes,
  retakeRecords,
  retakeWindows,
  semanticHypotheses,
  validateRetakeGroups,
} from "@/lib/retakes";
import { normalizeProjectTranscripts } from "@/lib/transcript";

import { speech } from "./helpers/retakeProject";
import fixtures from "./fixtures/retakes.json";

const correction = {
  kind: "spoken-correction",
  attempts: [
    { start: 1, end: 2, complete: true },
    { start: 3, end: 4, complete: true },
  ],
  markers: [{ start: 2, end: 3 }],
};

describe("retake analysis snapshots", () => {
  it("proposes bounded semantic comparisons including low-overlap rewordings", () => {
    for (const id of [
      "abandoned",
      "correction",
      "reworded",
      "incomplete-last",
      "elaboration",
      "terminology",
    ]) {
      const fixture = fixtures.find((f) => f.id === id)!;
      const records = retakeRecords(speech(fixture.words));
      const proposed = semanticHypotheses({ id: "w", records });
      const expected = fixture.hypotheses[0]!;
      expect(
        proposed.some(
          (p) =>
            JSON.stringify(p.attempts.map(({ start, end }) => ({ start, end }))) ===
            JSON.stringify(expected.attempts.map(({ start, end }) => ({ start, end }))),
        ),
      ).toBe(true);
      expect(() =>
        validateRetakeGroups({ id: "w", records }, proposed.flatMap(hypothesisOptions)),
      ).not.toThrow();
    }
  });
  it("is read only and preserves corrected and hidden audible groups", () => {
    const p = normalizeProjectTranscripts(speech("Use POST sorry PUT today."));
    p.segments[0]!.transcript!.blocks[0]!.runs[1]!.text = "";
    const before = structuredClone(p);
    const records = retakeRecords(p);
    expect(records[1]!.text).toBe("");
    expect(records[1]!.originalText).toBe("POST");
    expect(p).toEqual(before);
    expect(() => validateRetakeGroups({ id: "w", records }, [correction])).toThrow(/hidden/);
  });
  it("keeps repeated source IDs distinct and never bridges different recordings", () => {
    const p = speech("The the server responds.");
    p.media.n = { ...p.media.m!, id: "n" };
    p.segments.push(
      { ...p.segments[0]!, id: "other", mediaId: "n" },
      { ...p.segments[0]!, id: "copy" },
    );
    const records = retakeRecords(p);
    expect(new Set(records.map((r) => r.id)).size).toBe(12);
    expect(retakeWindows(records)).toHaveLength(3);
    expect(records.map((r) => r.sequence)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  });
  it("uses inclusive 30 second successive-start windows; a take can end later", () => {
    const records = retakeRecords(speech("Use POST sorry PUT today."));
    records[3]!.start = records[1]!.start + 30;
    records[3]!.end = records[3]!.start + 20;
    expect(validateRetakeGroups({ id: "w", records }, [correction])).toHaveLength(1);
    records[3]!.start += 0.001;
    expect(() => validateRetakeGroups({ id: "w", records }, [correction])).toThrow(/30 seconds/);
  });
  it("rejects invented indices, extra fields, overlap and incomplete labels", () => {
    const w = retakeWindows(retakeRecords(speech("Use POST sorry PUT today.")))[0]!;
    for (const g of [
      { ...correction, hallucination: true },
      { ...correction, markers: [{ start: 1, end: 2 }] },
      { ...correction, attempts: [{ start: -1, end: 2, complete: true }, correction.attempts[1]] },
      { ...correction, attempts: [{ start: 1, end: 2 }, correction.attempts[1]] },
    ])
      expect(() => validateRetakeGroups(w, [g])).toThrow(/Invalid retake/);
  });
  it("prefers an earlier complete take over a later fragment", () => {
    const w = retakeWindows(retakeRecords(speech("Use POST sorry PUT today.")))[0]!;
    const g = structuredClone(correction);
    g.attempts[1]!.complete = false;
    const c = validateRetakeGroups(w, [g])[0]!;
    expect(c.suggestedAttemptId).toBe(c.attempts[0]!.id);
    g.attempts[0]!.complete = false;
    expect(validateRetakeGroups(w, [g])[0]!.suggestedAttemptId).toBeUndefined();
  });
  it("groups three adjacent lexical restarts without emphasis or terminology matches", () => {
    const records = retakeRecords(speech("The server The server The server responds."));
    const w = retakeWindows(records)[0]!;
    const groups = lexicalRetakes(w);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.attempts).toHaveLength(3);
    expect(groupRetakes(records, [...groups, ...lexicalRetakes(w)])).toHaveLength(1);
    for (const text of [
      "It is very very important.",
      "REST is useful. REST is a style.",
      "The server responds. The server logs.",
    ])
      expect(lexicalRetakes(retakeWindows(retakeRecords(speech(text)))[0]!)).toEqual([]);
  });
  it("merges compatible overlapping pairs into a single chain", () => {
    const records = retakeRecords(speech("The The The server responds."));
    const w = { id: "w", records };
    const pair = (a: number, b: number) =>
      validateRetakeGroups(w, [
        {
          kind: "word-stutter",
          attempts: [
            { start: a, end: a + 1, complete: true },
            { start: b, end: b + 1, complete: true },
          ],
          markers: [],
        },
      ])[0]!;
    const groups = groupRetakes(records, [pair(0, 1), pair(1, 2)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.attempts).toHaveLength(3);
  });
  it("offers bounded cuts for interrupted repeats without treating wording as a verdict", () => {
    const text =
      "HTTP requests and requests [UH] responses. JSON is a JSON is common. Should I post a post? Call it seat field seat num or seat.";
    const w = retakeWindows(retakeRecords(speech(text)))[0]!;
    const hypotheses = semanticHypotheses(w);
    const words = w.records.map((r) => r.text.toLowerCase());
    for (const anchor of ["requests", "json"])
      expect(
        hypotheses.some(
          (h) => h.kind === "interrupted-restart" && words[h.attempts[0]!.start] === anchor,
        ),
      ).toBe(true);
    for (const anchor of ["post", "seat"])
      expect(
        hypotheses.some(
          (h) => h.kind === "interrupted-restart" && words[h.attempts[0]!.start] === anchor,
        ),
      ).toBe(false);
    const requests = hypotheses.find(
      (h) => h.kind === "interrupted-restart" && words[h.attempts[0]!.start] === "requests",
    )!;
    expect(hypothesisOptions(requests)).toHaveLength(1);
    const json = hypotheses.find(
      (h) => h.kind === "interrupted-restart" && words[h.attempts[0]!.start] === "json",
    )!;
    expect(
      hypothesisOptions(json).map((o) =>
        o.attempts.map((a) =>
          w.records
            .slice(a.start, a.end)
            .map((r) => r.text)
            .join(" "),
        ),
      ),
    ).toEqual([
      ["JSON is", "JSON is common."],
      ["JSON is a", "JSON is common."],
      ["JSON is a", "JSON is"],
    ]);
    expect(hypotheses.every((h) => hypothesisOptions(h).length <= 3)).toBe(true);
  });
  it("keeps a narrow verified restart when a broad sentence proposal overlaps it", () => {
    const records = retakeRecords(speech("HTTP requests and requests responses. More."));
    const w = { id: "w", records };
    const narrow = validateRetakeGroups(w, [
      {
        kind: "interrupted-restart",
        attempts: [
          { start: 1, end: 2, complete: false },
          { start: 3, end: 4, complete: false },
        ],
        markers: [],
      },
    ])[0]!;
    const broad = validateRetakeGroups(w, [
      {
        kind: "abandoned-start",
        attempts: [
          { start: 0, end: 5, complete: false },
          { start: 5, end: 6, complete: true },
        ],
        markers: [],
      },
    ])[0]!;
    expect(groupRetakes(records, [broad, narrow])).toEqual([narrow]);
  });
});
