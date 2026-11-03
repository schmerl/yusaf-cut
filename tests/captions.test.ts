import { describe, it, expect } from "vitest";
import { projectTranscript } from "@/lib/transcript";
import { replaceTranscriptText } from "@/lib/transcriptEdits";
import {
  buildCues,
  buildSrt,
  buildVtt,
  formatSrtTimestamp,
  formatVttTimestamp,
} from "@/lib/captions";
import {
  addMediaWithTranscript,
  deleteWords,
  newProject,
  type SourceMedia,
  type Word,
} from "@/lib/edl";

function media(): SourceMedia {
  return {
    id: "m1",
    path: "/tmp/x.mp4",
    duration: 60,
    fps: 30,
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    sha256: "abc",
  };
}

function words(spec: Array<[string, number, number]>): Word[] {
  return spec.map(([text, start, end], i) => ({
    id: `w${i}`,
    text,
    start,
    end,
    confidence: 0.99,
  }));
}

describe("captions: timestamps", () => {
  it("formats SRT timestamps with comma separator", () => {
    expect(formatSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatSrtTimestamp(1.234)).toBe("00:00:01,234");
    expect(formatSrtTimestamp(3661.5)).toBe("01:01:01,500");
  });

  it("formats VTT timestamps with dot separator", () => {
    expect(formatVttTimestamp(0)).toBe("00:00:00.000");
    expect(formatVttTimestamp(1.234)).toBe("00:00:01.234");
  });

  it("rounds millis half-up", () => {
    expect(formatSrtTimestamp(0.0009)).toBe("00:00:00,001");
  });
});

describe("captions: cue grouping", () => {
  it("groups contiguous words into a single cue", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["hello", 0, 0.5],
        ["world", 0.55, 1.0],
        ["again", 1.05, 1.4],
      ]),
    );
    const cues = buildCues(proj);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("hello world again");
    expect(cues[0]!.start).toBeCloseTo(0, 5);
    expect(cues[0]!.end).toBeCloseTo(1.4, 5);
  });

  it("starts a new cue after a long silence", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["first", 0, 0.5],
        ["clause", 0.55, 1.0],
        // A long silence remains a hard boundary.
        ["second", 3.5, 4.0],
        ["clause", 4.05, 4.4],
      ]),
    );
    const cues = buildCues(proj);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe("first clause");
    expect(cues[1]!.text).toBe("second clause");
    expect(cues[1]!.index).toBe(2);
  });

  it("splits a cue when it would exceed 7 seconds", () => {
    const longSpeech = Array.from({ length: 30 }, (_, i): [string, number, number] => [
      `word${i}`,
      i * 0.4,
      i * 0.4 + 0.35,
    ]);
    const proj = addMediaWithTranscript(newProject("p"), media(), words(longSpeech));
    const cues = buildCues(proj);
    expect(cues.length).toBeGreaterThan(1);
    for (const cue of cues) {
      expect(cue.end - cue.start).toBeLessThanOrEqual(7);
    }
  });

  it("reflects deleted words in output-time", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["keep", 0, 0.5],
        ["delete-me", 0.55, 1.0],
        ["keep-too", 1.05, 1.4],
      ]),
    );
    const trimmed = deleteWords(proj, new Set(["w1"]));
    const cues = buildCues(trimmed);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).not.toContain("delete-me");
    // Output time of the second kept word lands much closer to the first than
    // its source-time position (1.05s). With 80ms padding around the cut the
    // second word lands near 0.66s in output-time; we just need to confirm the
    // gap collapsed below the unedited 1.05s.
    expect(cues[0]!.end).toBeLessThan(1.05);
  });
});

describe("captions: serialisation", () => {
  it("produces a valid SRT with index, arrow, blank line", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["hello", 0, 0.5],
        ["world", 0.55, 1.0],
      ]),
    );
    const srt = buildSrt(proj);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,000\nhello world\n");
  });

  it("produces a VTT with WEBVTT header and dot timestamps", () => {
    const proj = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["hello", 0, 0.5],
        ["world", 0.55, 1.0],
      ]),
    );
    const vtt = buildVtt(proj);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.000\nhello world\n");
  });

  it("returns an empty SRT for an empty project", () => {
    const proj = newProject("p");
    expect(buildSrt(proj)).toBe("");
    expect(buildVtt(proj)).toBe("WEBVTT\n\n");
  });
});

describe("issue 17: readable cue boundaries", () => {
  it("balances the reported 140ms 'it.' tail into a phrase", () => {
    const p = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["[UH]", 11.48, 11.5],
        ["including", 11.62, 12.03],
        ["those", 12.03, 12.28],
        ["designed", 12.28, 12.77],
        ["around", 12.77, 13],
        ["REST,", 13.18, 13.28],
        ["though", 13.74, 13.92],
        ["neither", 13.92, 14.32],
        ["HTTP", 14.32, 14.6],
        ["nor", 15.1, 15.39],
        ["REST", 15.39, 15.82],
        ["actually", 15.94, 16.34],
        ["require", 16.34, 16.86],
        ["it.", 16.86, 17],
      ]),
    );
    const cues = buildCues(p);
    expect(cues).toHaveLength(2);
    expect(
      cues
        .map((c) => c.text)
        .join(" ")
        .replace(/\s+/gu, " "),
    ).toBe(
      "[UH] including those designed around REST, though neither HTTP nor REST actually require it.",
    );
    for (const cue of cues) {
      expect(cue.text.split(/\s+/).length).toBeGreaterThan(1);
      expect(cue.end - cue.start).toBeLessThanOrEqual(7);
      expect(cue.end - cue.start).toBeGreaterThan(1.2);
    }
  });

  it("balances a word-limit tail and counts words inside edited timing groups", () => {
    const p = addMediaWithTranscript(
      newProject("p"),
      media(),
      words(Array.from({ length: 15 }, (_, i) => [`word${i}`, i * 0.2, i * 0.2 + 0.15])),
    );
    const cues = buildCues(p);
    expect(cues).toHaveLength(2);
    expect(cues.every((c) => c.text.split(" ").length >= 2)).toBe(true);
    expect(
      cues
        .map((c) => c.text)
        .join(" ")
        .replace(/\s+/gu, " "),
    ).toBe(p.segments[0]!.words.map((w) => w.text).join(" "));

    // A replacement can contain many words but has just one timing range.
    const expanded = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["one two three four five six seven eight nine ten eleven twelve thirteen fourteen", 0, 2],
        ["another", 2.1, 2.3],
        ["phrase", 2.3, 2.5],
      ]),
    );
    expect(buildCues(expanded).map((c) => c.text.replace(/\s+/gu, " "))).toEqual([
      "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
      "another phrase",
    ]);
  });

  it("retains a meaningful one-word utterance separated by pauses", () => {
    const p = addMediaWithTranscript(
      newProject("p"),
      media(),
      words([
        ["Yes.", 0, 0.4],
        ["Next", 2.5, 2.8],
        ["topic.", 2.8, 3.2],
      ]),
    );
    expect(buildCues(p).map((c) => c.text)).toEqual(["Yes.", "Next topic."]);
  });
});

it("exports HTTP/JSON corrections and hidden fillers without changing raw recognition", () => {
  let p = addMediaWithTranscript(
    newProject("p"),
    media(),
    words([
      ["HDTP", 0, 0.4],
      ["[UH]", 0.5, 0.6],
      ["sends", 0.7, 1],
      ["Jason.", 1.1, 1.5],
    ]),
  );
  const original = structuredClone(p.segments[0]!.words);
  for (const [before, after] of [
    ["HDTP", "HTTP"],
    ["Jason", "JSON"],
    ["[UH]", ""],
  ]) {
    const block = projectTranscript(p)[0]!;
    const from = block.text.indexOf(before!);
    p = replaceTranscriptText(p, {
      segmentId: block.segmentId,
      blockId: block.id,
      from,
      to: from + before!.length,
      text: after!,
    });
  }
  const reopened = JSON.parse(JSON.stringify(p));
  for (const content of [buildSrt(reopened), buildVtt(reopened)]) {
    expect(content).toContain("HTTP sends JSON.");
    expect(content).not.toMatch(/HDTP|Jason|\[UH\]/);
    expect(content).toContain("00:00:00");
  }
  expect(reopened.segments[0].words).toEqual(original);
});
