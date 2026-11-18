import { expect, it } from "vitest";
import {
  findUnattributedSpeech,
  insertGapTranscript,
  extendSentenceStart,
  extendSentenceEnd,
} from "@/lib/timelineAnalysis";
import { totalDuration, type Project, type Word } from "@/lib/edl";
import {
  normalizeProjectTranscripts,
  projectTranscript,
  validateProjectTranscripts,
} from "@/lib/transcript";
import { cutOutputSpeech } from "@/lib/transcriptEdits";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import fixture from "./fixtures/transcript-corrections.json";

function setup() {
  const project = structuredClone(fixture) as Project;
  project.media.m1!.duration = 6;
  project.segments = [
    {
      ...project.segments[0]!,
      sourceIn: 0,
      sourceOut: 6,
      words: [{ id: "known", text: "Known sentence.", start: 2, end: 4, confidence: 1 }],
      transcript: undefined,
    },
  ];
  const peaks = { m1: Array(300).fill(0) as number[] };
  peaks.m1.fill(0.3, 25, 75); // untranscribed leading speech
  peaks.m1.fill(0.3, 100, 200); // known speech
  peaks.m1.fill(0.3, 225, 275); // untranscribed trailing speech
  return { project: normalizeProjectTranscripts(project), peaks };
}
function recognized(start: number, end: number, text = "Recovered speech."): Word[] {
  return [{ id: "recognizer", start, end, text, confidence: 0.9 }];
}
it("detects leading and trailing speech activity while leaving silence and known speech alone", () => {
  const { project, peaks } = setup();
  const findings = findUnattributedSpeech(project, peaks);
  expect(findings).toHaveLength(2);
  expect(findings[0]).toMatchObject({
    sourceIn: 0.46,
    sourceOut: 1.54,
    outputStart: 0.46,
    nextSentence: "Known sentence.",
  });
  expect(findings[1]!.nextBlockId).toBeUndefined();
  expect(findUnattributedSpeech(project, { m1: Array(300).fill(0) })).toEqual([]);
});
it("maps repeated audio occurrences to their own output times and excludes removed audio", () => {
  const { project, peaks } = setup();
  const repeated = {
    ...project,
    segments: [
      project.segments[0]!,
      { ...project.segments[0]!, id: "repeat", transcript: undefined },
    ],
  };
  const findings = findUnattributedSpeech(repeated, peaks);
  expect(findings).toHaveLength(4);
  expect(findings[2]!.outputStart).toBeCloseTo(6.46);
  expect(findings[2]!.segmentId).toBe("repeat");
  const trimmed = {
    ...project,
    segments: [{ ...project.segments[0]!, sourceIn: 2, sourceOut: 4 }],
  };
  expect(findUnattributedSpeech(trimmed, peaks)).toHaveLength(0);
});
it("does not restore hidden words or flag gaps inside a corrected phrase", () => {
  const project = normalizeProjectTranscripts(structuredClone(fixture) as Project);
  const findings = findUnattributedSpeech(project, { m1: Array(400).fill(0.3) });
  for (const finding of findings) {
    const segment = project.segments.find((s) => s.id === finding.segmentId)!;
    expect(segment.words.some((w) => w.start < finding.sourceOut && w.end > finding.sourceIn)).toBe(
      false,
    );
  }
});
it("extends timing without changing sentence text, original anchors, audio, or duration and supports Undo", () => {
  const { project, peaks } = setup();
  const finding = findUnattributedSpeech(project, peaks)[0]!;
  replaceProjectBaseline(project);
  const next = extendSentenceStart(project, finding);
  expect(projectTranscript(next)[0]!.text).toBe(projectTranscript(project)[0]!.text);
  expect(projectTranscript(next)[0]!.runs[0]!.sourceStart).toBe(finding.sourceIn);
  expect(next.segments[0]!.words.find((w) => w.id === "known")).toEqual(
    project.segments[0]!.words[0],
  );
  expect(next.segments[0]!.sourceIn).toBe(0);
  expect(next.segments[0]!.sourceOut).toBe(6);
  expect(totalDuration(next)).toBe(totalDuration(project));
  validateProjectTranscripts(next);
  useProjectStore.getState().commitTranscript(next, project);
  useProjectStore.temporal.getState().undo();
  expect(useProjectStore.getState().project).toBe(project);
  expect(() => extendSentenceStart(project, findUnattributedSpeech(project, peaks)[1]!)).toThrow(
    /no following sentence/,
  );
});
it("adds bounded recognition without replacing corrections, other occurrences, or audio", () => {
  const { project, peaks } = setup();
  const finding = findUnattributedSpeech(project, peaks)[0]!;
  const next = insertGapTranscript(project, finding, recognized(-5, 9));
  const added = next.segments[0]!.words.find((w) => w.id !== "known")!;
  expect(added.start).toBe(finding.sourceIn);
  expect(added.end).toBe(finding.sourceOut);
  expect(next.segments[0]!.transcript!.blocks[1]).toEqual(
    project.segments[0]!.transcript!.blocks[0],
  );
  expect(totalDuration(next)).toBe(totalDuration(project));
  expect(() => insertGapTranscript(next, finding, recognized(0.5, 1.5))).toThrow(
    /already attributed/,
  );
  expect(() => insertGapTranscript(project, finding, [])).toThrow(/No speech/);
  validateProjectTranscripts(next);
});
it("inserts words inside a paragraph in anchor order and permits later transcript cuts", () => {
  const { project, peaks } = setup();
  const segment = project.segments[0]!;
  const internal = normalizeProjectTranscripts({
    ...project,
    segments: [
      {
        ...segment,
        transcript: undefined,
        words: [
          { id: "a", text: "First", start: 0, end: 0.4, confidence: 1 },
          { id: "b", text: "last.", start: 2, end: 3, confidence: 1 },
        ],
      },
    ],
  });
  const finding = findUnattributedSpeech(internal, peaks)[0]!;
  const next = insertGapTranscript(internal, finding, recognized(0.5, 1.5, "missing"));
  expect(projectTranscript(next).map((b) => b.text)).toEqual(["First", "missing", "last."]);
  validateProjectTranscripts(next);
  expect(() => cutOutputSpeech(next, 0.5, 1.5)).not.toThrow();
});
it("splits long wordless audio into bounded recognition windows and rejects missing sources", () => {
  const { project } = setup();
  const long = {
    ...project,
    media: { m1: { ...project.media.m1!, duration: 70 } },
    segments: [{ ...project.segments[0]!, sourceOut: 70, words: [], transcript: undefined }],
  };
  const findings = findUnattributedSpeech(long, { m1: Array(3500).fill(0.3) });
  expect(findings).toHaveLength(3);
  expect(findings.every((f) => f.sourceOut - f.sourceIn <= 30)).toBe(true);
  expect(() => findUnattributedSpeech(project, {})).toThrow(/incomplete/);
});
it("extends into an adjacent wordless segment only when its source audio is contiguous", () => {
  const { project, peaks } = setup();
  const split = {
    ...project,
    segments: [
      { id: "loose", mediaId: "m1", sourceIn: 0, sourceOut: 2, words: [] },
      { ...project.segments[0]!, sourceIn: 2 },
    ],
  };
  const finding = findUnattributedSpeech(split, peaks)[0]!;
  expect(finding.nextSegmentId).toBe(project.segments[0]!.id);
  const next = extendSentenceStart(split, finding);
  expect(totalDuration(next)).toBe(totalDuration(split));
  expect(projectTranscript(next)[0]!.text).toBe("Known sentence.");
  expect(projectTranscript(next)[0]!.runs[0]!.sourceStart).toBe(0.46);
  validateProjectTranscripts(next);
  const discontinuous = {
    ...split,
    segments: [{ ...split.segments[0]!, sourceOut: 1.8 }, split.segments[1]!],
  };
  expect(findUnattributedSpeech(discontinuous, peaks)[0]!.nextBlockId).toBeUndefined();
  expect(() => extendSentenceStart(discontinuous, finding)).toThrow(/audio cut/);
});
it("preserves corrected and hidden transcript runs when adding newly recognized speech", () => {
  const baseline = normalizeProjectTranscripts(structuredClone(fixture) as Project);
  const project = { ...baseline, segments: [{ ...baseline.segments[0]!, sourceOut: 4 }] };
  const peaks = { m1: Array(200).fill(0) };
  peaks.m1.fill(0.3, 160, 190);
  const finding = findUnattributedSpeech(project, peaks)[0]!;
  const next = insertGapTranscript(project, finding, recognized(3.2, 3.8));
  const previous = project.segments[0]!.transcript!;
  expect(next.segments[0]!.transcript!.blocks.slice(0, previous.blocks.length)).toEqual(
    previous.blocks,
  );
  const reopened = JSON.parse(JSON.stringify(next)) as Project;
  validateProjectTranscripts(reopened);
  expect(projectTranscript(reopened)[0]!.text).toBe(projectTranscript(project)[0]!.text);
});

it("extends the previous sentence to trailing speech while preserving anchors, wording, and Undo", () => {
  const { project, peaks } = setup();
  const finding = findUnattributedSpeech(project, peaks)[1]!;
  expect(finding.previousSentence).toBe("Known sentence.");
  const next = extendSentenceEnd(project, finding);
  expect(projectTranscript(next)[0]!.text).toBe(projectTranscript(project)[0]!.text);
  expect(projectTranscript(next)[0]!.runs.at(-1)!.sourceEnd).toBe(finding.sourceOut);
  expect(next.segments[0]!.words.find((w) => w.id === "known")).toEqual(
    project.segments[0]!.words[0],
  );
  expect(totalDuration(next)).toBe(totalDuration(project));
  validateProjectTranscripts(next);
  validateProjectTranscripts(JSON.parse(JSON.stringify(next)) as Project);
  replaceProjectBaseline(project);
  useProjectStore.getState().commitTranscript(next, project);
  useProjectStore.temporal.getState().undo();
  expect(useProjectStore.getState().project).toBe(project);
  expect(() => extendSentenceEnd(project, findUnattributedSpeech(project, peaks)[0]!)).toThrow(
    /no preceding sentence/,
  );
});
it("extends the previous sentence into a contiguous wordless segment and rejects a cut boundary", () => {
  const { project, peaks } = setup();
  const split = {
    ...project,
    segments: [
      { ...project.segments[0]!, sourceOut: 4 },
      { id: "loose", mediaId: "m1", sourceIn: 4, sourceOut: 6, words: [] },
    ],
  };
  const finding = findUnattributedSpeech(split, peaks)[1]!;
  expect(finding.previousSegmentId).toBe(project.segments[0]!.id);
  const next = extendSentenceEnd(split, finding);
  expect(totalDuration(next)).toBe(totalDuration(split));
  expect(projectTranscript(next)[0]!.runs[0]!.sourceEnd).toBe(5.54);
  expect(projectTranscript(next)[0]!.text).toBe("Known sentence.");
  validateProjectTranscripts(next);
  const cut = {
    ...split,
    segments: [split.segments[0]!, { ...split.segments[1]!, sourceIn: 4.1 }],
  };
  expect(findUnattributedSpeech(cut, peaks)[1]!.previousBlockId).toBeUndefined();
  expect(() => extendSentenceEnd(cut, finding)).toThrow(/audio cut/);
});
it("keeps timing extensions visible when edge words have intentionally hidden text", () => {
  const { project, peaks } = setup();
  const segment = project.segments[0]!;
  const before = { id: "hidden-before", text: "hidden", start: 1.8, end: 2, confidence: 1 };
  const after = { id: "hidden-after", text: "hidden", start: 4, end: 4.2, confidence: 1 };
  const metadata = segment.transcript!;
  const edged = {
    ...project,
    segments: [
      {
        ...segment,
        words: [before, ...segment.words, after],
        transcript: {
          ...metadata,
          originals: [before, ...metadata.originals, after],
          blocks: [
            {
              ...metadata.blocks[0]!,
              runs: [
                { id: "hidden-run-before", text: "", separatorBefore: "", anchorIds: [before.id] },
                ...metadata.blocks[0]!.runs,
                { id: "hidden-run-after", text: "", separatorBefore: "", anchorIds: [after.id] },
              ],
            },
          ],
        },
      },
    ],
  };
  validateProjectTranscripts(edged);
  const started = extendSentenceStart(edged, findUnattributedSpeech(edged, peaks)[0]!);
  const extended = extendSentenceEnd(started, findUnattributedSpeech(started, peaks)[0]!);
  const visible = projectTranscript(extended)[0]!.runs.filter((run) => run.text.trim());
  expect(visible).toHaveLength(1);
  expect(visible[0]).toMatchObject({ text: "Known sentence.", sourceStart: 0.46, sourceEnd: 5.54 });
  validateProjectTranscripts(extended);
});
