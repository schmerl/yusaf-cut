import { describe, expect, it } from "vitest";
import { addMediaWithTranscript, newProject, type Project, type SourceMedia } from "@/lib/edl";
import {
  buildCues,
  buildSrt,
  buildVtt,
  buildUntimedTranscript,
  flattenWordsInOutputTime,
} from "@/lib/captions";
import { captionSectionStarts } from "@/lib/captionSections";
import { normalizeProjectTranscripts, projectTranscript } from "@/lib/transcript";
import {
  cutTranscriptRanges,
  replaceTranscriptText,
  splitTranscriptBlock,
} from "@/lib/transcriptEdits";
import { parseScript } from "@/lib/scriptMarkdown";

const a = "First we discuss the meaning of shared HTTP methods.";
const b = "Now consider how schemas describe the shape of messages.";
const c = "Finally we examine errors returned by the payment service.";
const markdown = `# Lecture\n\n## Slide\n\n${a}\n\n## Slide\n\n${b}\n\n## Last\n\n${c}`;
function project(text = `${a} ${b} ${c}`, script: string | null = markdown): Project {
  const media: SourceMedia = {
    id: "m",
    path: "/tmp/lecture.mp4",
    duration: 90,
    fps: 30,
    width: 1920,
    height: 1080,
    audioSampleRate: 48000,
    sha256: "test",
  };
  let p = addMediaWithTranscript(
    newProject("captions"),
    media,
    text.split(/\s+/u).map((text, i) => ({
      id: `w${i}`,
      text,
      start: i * 0.2,
      end: i * 0.2 + 0.18,
      confidence: 1,
    })),
  );
  if (script)
    p = {
      ...p,
      scriptAssistance: {
        version: 1,
        activeRevision: "a".repeat(64),
        records: [],
        scripts: [{ revision: "a".repeat(64), name: "lecture.md", markdown: script }],
      },
    };
  return p;
}
const normalize = (s: string) => s.replace(/\s+/gu, " ").trim();
const starts = (p: Project) => Array.from(captionSectionStarts(p, flattenWordsInOutputTime(p)));

describe("script slide caption boundaries", () => {
  it("uses heading identity, not heading wording, and never exports headings", () => {
    const p = project();
    const before = JSON.stringify(p);
    expect(starts(p)).toEqual([0, 9, 18]);
    expect(buildUntimedTranscript(p)).toBe(`${a}\n\n${b}\n\n${c}\n`);
    for (const content of [buildSrt(p), buildVtt(p)]) {
      expect(content).not.toContain("Slide");
      expect(content).not.toContain("Lecture");
    }
    const cues = buildCues(p);
    expect(cues.map((c) => normalize(c.text))).toEqual([a, b, c]);
    expect(cues[1]!.start).toBeCloseTo(1.8);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("handles small recognition differences and ignores unspoken markup", () => {
    const p = project(
      `${a} Now consider how schemas define the shape of messages. ${c}`,
      markdown.replace(b, `<press> ${b}\n\n<!-- unspoken -->`),
    );
    expect(starts(p)).toEqual([0, 9, 18]);
    expect(buildUntimedTranscript(p).split("\n\n")[1]).toContain("schemas define");
  });

  it("falls back for absent, short, ambiguous and repeated script openers", () => {
    expect(buildUntimedTranscript(project(undefined, null))).toBe(`${a} ${b} ${c}\n`);
    expect(starts(project(undefined, "# Slide\n\nYes."))).toEqual([]);
    expect(starts(project(`${a} ${b}`, `## One\n\n${a}\n\n## Two\n\n${a}`))).toEqual([]);
    expect(starts(project(undefined, `## Bad\n\n<broken\n${b}`))).toEqual([]);
    expect(buildUntimedTranscript(newProject("empty"))).toBe("");
  });

  it("does not force a break where two sections have similarly plausible openers", () => {
    const p = project(b, `## One\n\n${b}\n\n## Two\n\n${b.replace("shape", "form")}`);
    expect(starts(p)).toEqual([]);
  });

  it("maps reordered and reused clips in output order without losing text", () => {
    const p = normalizeProjectTranscripts(project());
    const segment = p.segments[0]!;
    const duplicate = structuredClone(segment);
    duplicate.id = "reuse";
    duplicate.transcript!.occurrenceId = "reuse";
    const repeated = { ...p, segments: [duplicate, segment] };
    expect(buildUntimedTranscript(repeated)).toBe(`${a}\n\n${b}\n\n${c}\n\n${a}\n\n${b}\n\n${c}\n`);
    expect(starts(repeated)).toEqual([0, 27, 9, 36, 18, 45]);
  });

  it("does not invent a slide boundary inside a merged timing group", () => {
    let p = project();
    const block = projectTranscript(p)[0]!;
    const next = projectTranscript(p)[1]!;
    // Merge the next section opener into a group preceded by spoken context.
    p = replaceTranscriptText(p, {
      segmentId: next.segmentId,
      blockId: next.id,
      from: 0,
      to: next.text.length,
      text: `Aside. ${next.text}`,
    });
    expect(starts(p)).toEqual([0, 10]); // next section starts at the final run after the merge
    expect(normalize(buildUntimedTranscript(p))).toContain(`Aside. ${b}`);
    expect(block.text).toBe(a);
  });

  it("keeps breaks through paragraph splits, text edits, hidden words and cuts", () => {
    let p = normalizeProjectTranscripts(project());
    const first = projectTranscript(p)[0]!;
    p = splitTranscriptBlock(p, first.segmentId, first.id, first.runs[4]!.from);
    // A paragraph split alone must not introduce a blank line.
    expect(buildUntimedTranscript(p)).toBe(`${a}\n\n${b}\n\n${c}\n`);
    const block = projectTranscript(p)[0]!;
    p = cutTranscriptRanges(p, [
      {
        segmentId: block.segmentId,
        blockId: block.id,
        from: block.runs[1]!.from,
        to: block.runs[1]!.to,
      },
    ]);
    const roundtrip = JSON.parse(JSON.stringify(p)) as Project;
    const text = buildUntimedTranscript(roundtrip);
    expect(text).not.toContain("First we discuss");
    expect(text).toContain(`\n\n${b}\n\n${c}`);
    expect(buildCues(roundtrip).find((c) => normalize(c.text) === b)!.start).toBeLessThan(2);
  });

  it("ignores arbitrary transcript paragraphs and ordinary pauses when grouping", () => {
    const p = project("This is short. So is this. Together they form one readable caption.", null);
    expect(projectTranscript(p).length).toBeGreaterThan(1);
    expect(buildCues(p)).toHaveLength(1);
    expect(buildUntimedTranscript(p)).not.toContain("\n\n");
    expect(buildCues(p)[0]!.text.split("\n")).toHaveLength(2);
    for (const line of buildCues(p)[0]!.text.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(42);
      expect(line.split(" ").length).toBeGreaterThan(1);
    }
  });

  it("retains separate identities for consecutive identical heading titles", () => {
    const parsed = parseScript(markdown);
    expect(parsed.passages[0]!.section).toEqual(parsed.passages[1]!.section);
    expect(parsed.passages[0]!.sectionFrom).not.toBe(parsed.passages[1]!.sectionFrom);
  });
});

it("keeps an ad-libbed lead-in with the next slide", () => {
  const p = project(`${a} So ${b} ${c}`);
  expect(buildUntimedTranscript(p)).toBe(`${a}\n\nSo ${b}\n\n${c}\n`);
  expect(buildCues(p).some((c) => c.text === "So")).toBe(false);
});

it("handles omitted and reordered sections without assuming script order", () => {
  const p = project(`${c} ${a}`);
  expect(buildUntimedTranscript(p)).toBe(`${c}\n\n${a}\n`);
  expect(buildCues(p).map((c) => normalize(c.text))).toEqual([c, a]);
});

it("merges across ordinary pauses but keeps a long silence out of timed cues", () => {
  const p = project("Here is one short phrase continuing after a brief pause.", null);
  const words = p.segments[0]!.words;
  for (let i = 5; i < words.length; i++) {
    words[i]!.start += 0.9;
    words[i]!.end += 0.9;
  }
  expect(buildCues(p)).toHaveLength(1);
  for (let i = 5; i < words.length; i++) {
    words[i]!.start += 2;
    words[i]!.end += 2;
  }
  const cues = buildCues(p);
  expect(cues).toHaveLength(2);
  expect(cues[0]!.end).toBeLessThan(cues[1]!.start - 2);
  expect(buildUntimedTranscript(p)).not.toContain("\n\n");
});
