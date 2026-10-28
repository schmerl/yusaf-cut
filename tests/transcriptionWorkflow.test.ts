import { beforeEach, describe, expect, it, vi } from "vitest";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { createSnapshot, saveProject, transcribe } from "@/lib/ipc";
import {
  captureTranscription,
  correctedOccurrences,
  runTranscription,
  snapshotBeforeTranscription,
} from "@/lib/transcriptionWorkflow";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { cutTranscriptRanges, editBlockText, restoreTranscriptBlock } from "@/lib/transcriptEdits";
import {
  normalizeTranscript,
  projectTranscript,
  validateProjectTranscripts,
} from "@/lib/transcript";
import { readTranscriptCache, writeTranscriptCache } from "@/lib/transcriptCache";
import { computeTimeline, type Project, type Word } from "@/lib/edl";
import fixture from "./fixtures/transcript-corrections.json";
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@/lib/ipc", () => ({
  createSnapshot: vi.fn(),
  saveProject: vi.fn(),
  transcribe: vi.fn(),
}));
const settings = { modelName: "base" as const };
const words: Word[] = [
  { id: "fresh1", text: "New", start: 0, end: 1, confidence: 0.9 },
  { id: "fresh2", text: "originals.", start: 1.1, end: 2.9, confidence: 0.9 },
];
function twoMedia() {
  const p = structuredClone(fixture) as Project;
  p.media.m2 = { ...p.media.m1!, id: "m2", path: "/tmp/other.mp4", sha256: "second-hash" };
  const segment = { ...p.segments[1]!, id: "s3", mediaId: "m2", transcript: undefined };
  p.segments.push({ ...segment, transcript: normalizeTranscript(segment) });
  return editBlockText(p, "s3", "transcript:s3:block:0", "Unrelated correction.");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  replaceProjectBaseline(structuredClone(fixture) as Project, {
    filePath: "/tmp/test.scribe",
    dirty: true,
  });
  vi.mocked(saveProject).mockResolvedValue();
  vi.mocked(createSnapshot).mockResolvedValue({
    id: "snap",
    label: "Before",
    createdAt: "now",
    durationSec: 6,
    segments: 2,
  });
  vi.mocked(transcribe).mockImplementation(async ({ mediaId }) => ({
    mediaId,
    words,
    engine: "whisper-cpp",
  }));
});

describe("snapshot-first preflight", () => {
  it("saves and snapshots the current in-memory corrections, including edits newer than disk", async () => {
    useProjectStore.getState().rename("newer than disk");
    const request = captureTranscription(true);
    expect(await snapshotBeforeTranscription(request)).toBe(true);
    expect(saveProject).toHaveBeenCalledWith(request.project, "/tmp/test.scribe");
    expect(createSnapshot).toHaveBeenCalledWith(
      request.project,
      "/tmp/test.scribe",
      "Before re-transcription",
    );
    expect(vi.mocked(saveProject).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(createSnapshot).mock.invocationCallOrder[0]!,
    );
    expect(transcribe).not.toHaveBeenCalled();
  });
  it("routes an unsaved project through Save before snapshot", async () => {
    useProjectStore.setState({ filePath: null });
    vi.mocked(saveDialog).mockResolvedValue("/tmp/new.scribe");
    const request = captureTranscription(true);
    expect(await snapshotBeforeTranscription(request)).toBe(true);
    expect(saveDialog).toHaveBeenCalledOnce();
    expect(useProjectStore.getState().filePath).toBe("/tmp/new.scribe");
    expect(createSnapshot).toHaveBeenCalledWith(
      request.project,
      "/tmp/new.scribe",
      "Before re-transcription",
    );
  });
  it("Save cancellation preserves corrections and never snapshots or recognizes", async () => {
    useProjectStore.setState({ filePath: null });
    vi.mocked(saveDialog).mockResolvedValue(null);
    const request = captureTranscription(true);
    expect(await snapshotBeforeTranscription(request)).toBe(false);
    expect(useProjectStore.getState().project).toBe(request.project);
    expect(saveProject).not.toHaveBeenCalled();
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
  });
  it.each(["save", "snapshot"])(
    "surfaces %s failure without replacing corrections",
    async (step) => {
      if (step === "save") vi.mocked(saveProject).mockRejectedValue(new Error("disk full"));
      else vi.mocked(createSnapshot).mockRejectedValue(new Error("snapshot failed"));
      const request = captureTranscription(true);
      await expect(snapshotBeforeTranscription(request)).rejects.toThrow(
        step === "save" ? "disk full" : "snapshot failed",
      );
      expect(useProjectStore.getState().project).toBe(request.project);
      expect(transcribe).not.toHaveBeenCalled();
      if (step === "save") expect(createSnapshot).not.toHaveBeenCalled();
    },
  );
  it.each(["save", "snapshot"])("rejects edits made during %s", async (step) => {
    const pending = deferred<void>();
    if (step === "save") vi.mocked(saveProject).mockImplementationOnce(() => pending.promise);
    else
      vi.mocked(createSnapshot).mockImplementationOnce(async () => {
        await pending.promise;
        return { id: "s", label: "s", createdAt: "now", durationSec: 6, segments: 2 };
      });
    const request = captureTranscription(true);
    const task = snapshotBeforeTranscription(request);
    await vi.waitFor(() =>
      expect(step === "save" ? saveProject : createSnapshot).toHaveBeenCalled(),
    );
    useProjectStore.getState().rename("concurrent edit");
    pending.resolve();
    await expect(task).rejects.toThrow(/project changed/);
    expect(useProjectStore.getState().project.name).toBe("concurrent edit");
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("transactional recognition", () => {
  it("passes CrisperWhisper settings through and keeps filler words in the project", async () => {
    const filler: Word = { id: "filler", text: "[UM]", start: 0.1, end: 0.3, confidence: 1 };
    vi.mocked(transcribe).mockImplementationOnce(async ({ mediaId }) => ({
      mediaId,
      words: [filler, { ...words[0]!, start: 0.35 }, words[1]!],
      engine: "crisper-whisper",
    }));
    const options = {
      engine: "crisper-whisper" as const,
      modelName: "medium" as const,
      pythonPath: "/tmp/crisper-bench/bin/python",
      language: "en",
    };
    const result = await runTranscription(captureTranscription(true), options);
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining(options));
    expect(projectTranscript(result.project)[0]!.text).toContain("[UM]");
  });
  it("detects occurrence corrections, not merely normalized metadata", () => {
    expect(correctedOccurrences(captureTranscription(true))).toBe(1);
    const p = structuredClone(fixture) as Project;
    p.segments = p.segments.map((s) => {
      const raw = { ...s, transcript: undefined };
      return { ...raw, transcript: normalizeTranscript(raw) };
    });
    replaceProjectBaseline(p);
    expect(correctedOccurrences(captureTranscription(true))).toBe(0);
  });
  it("bypasses cached recognition, commits new originals once and retains output cuts and source metadata", async () => {
    const request = captureTranscription(true);
    writeTranscriptCache(request.project.media.m1!, request.project.segments[0]!.words);
    const result = await runTranscription(request, settings);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(projectTranscript(result.project).map((b) => b.text)).toEqual([
      "New originals.",
      "New originals.",
    ]);
    expect(computeTimeline(result.project)).toEqual(computeTimeline(request.project));
    expect(result.project.media).toBe(request.project.media);
    expect(readTranscriptCache(request.project.media.m1!)).toEqual(words);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    expect(useProjectStore.getState().dirty).toBe(true);
    const edited = editBlockText(result.project, "s1", "transcript:s1:block:0", "Edited.");
    expect(
      projectTranscript(restoreTranscriptBlock(edited, "s1", "transcript:s1:block:0"))[0]!.text,
    ).toBe("New originals.");
    validateProjectTranscripts(result.project);
  });
  it("stages both clips and preserves all corrections/cache/history if the second fails", async () => {
    replaceProjectBaseline(twoMedia());
    useProjectStore.getState().rename("typed");
    const request = captureTranscription(true);
    const history = useProjectStore.temporal.getState().pastStates;
    vi.mocked(transcribe)
      .mockResolvedValueOnce({ mediaId: "m1", words, engine: "whisper-cpp" })
      .mockRejectedValueOnce(new Error("second clip failed"));
    await expect(runTranscription(request, settings)).rejects.toThrow("second clip failed");
    expect(useProjectStore.getState().project).toBe(request.project);
    expect(useProjectStore.temporal.getState().pastStates).toBe(history);
    expect(readTranscriptCache(request.project.media.m1!)).toBeNull();
  });
  it.each(["edit", "switch", "same object reopened"])(
    "rejects stale recognition after %s",
    async (action) => {
      const pending = deferred<Awaited<ReturnType<typeof transcribe>>>();
      vi.mocked(transcribe).mockImplementationOnce(() => pending.promise);
      const request = captureTranscription(true);
      const task = runTranscription(request, settings);
      if (action === "edit") useProjectStore.getState().rename("edited during recognition");
      else replaceProjectBaseline(action === "switch" ? twoMedia() : request.project);
      const current = useProjectStore.getState().project;
      pending.resolve({ mediaId: "m1", words, engine: "whisper-cpp" });
      await expect(task).rejects.toThrow(/project changed/);
      expect(useProjectStore.getState().project).toBe(current);
      expect(readTranscriptCache(request.project.media.m1!)).toBeNull();
    },
  );
  it("preserves corrections for unaffected media, and clamps new originals to surviving source ranges", async () => {
    replaceProjectBaseline(twoMedia());
    const request = captureTranscription(true, ["m1"]);
    const other = request.project.segments[2];
    const result = await runTranscription(request, settings);
    expect(result.project.segments[2]).toBe(other);
    expect(projectTranscript(result.project).at(-1)!.text).toBe("Unrelated correction.");
    expect(computeTimeline(result.project)).toEqual(computeTimeline(request.project));
  });
  it("fills an empty occurrence without overwriting another corrected occurrence of that source", async () => {
    const p = structuredClone(fixture) as Project;
    p.segments[1] = { ...p.segments[1]!, words: [], transcript: undefined };
    replaceProjectBaseline(p);
    const request = captureTranscription(false);
    const result = await runTranscription(request, settings);
    expect(result.project.segments[0]).toBe(p.segments[0]);
    expect(projectTranscript(result.project)[0]!.text).toBe("idempotency are not the serveur.");
    expect(projectTranscript(result.project)[1]!.text).toBe("New originals.");
  });
  it("does not reset history or dirty state when all requested clips already have transcripts", async () => {
    const request = captureTranscription(false);
    const result = await runTranscription(request, settings);
    expect(result.project).toBe(request.project);
    expect(transcribe).not.toHaveBeenCalled();
  });
  it("rejects the wrong media result or malformed mappings before any commit/cache write", async () => {
    const request = captureTranscription(true);
    vi.mocked(transcribe).mockResolvedValueOnce({ mediaId: "wrong", words, engine: "whisper-cpp" });
    await expect(runTranscription(request, settings)).rejects.toThrow(/different clip/);
    vi.mocked(transcribe).mockResolvedValueOnce({
      mediaId: "m1",
      words: [words[0]!, { ...words[1]!, id: words[0]!.id }],
      engine: "whisper-cpp",
    });
    await expect(runTranscription(request, settings)).rejects.toThrow(/duplicate/);
    expect(useProjectStore.getState().project).toBe(request.project);
    expect(readTranscriptCache(request.project.media.m1!)).toBeNull();
  });
});

it("uses only raw cache data for an untranscribed occurrence without invoking recognition", async () => {
  const p = structuredClone(fixture) as Project;
  p.segments[1] = { ...p.segments[1]!, words: [], transcript: undefined };
  replaceProjectBaseline(p);
  writeTranscriptCache(p.media.m1!, words);
  const result = await runTranscription(captureTranscription(false), settings);
  expect(transcribe).not.toHaveBeenCalled();
  expect(result.project.segments[0]).toBe(p.segments[0]);
  expect(projectTranscript(result.project)[1]!.text).toBe("New originals.");
});

it("does not reuse or replace the legacy Whisper cache for CrisperWhisper", async () => {
  const p = structuredClone(fixture) as Project;
  p.segments[1] = { ...p.segments[1]!, words: [], transcript: undefined };
  replaceProjectBaseline(p);
  writeTranscriptCache(p.media.m1!, words);
  const filler: Word = { id: "filler", text: "[UM]", start: 0.1, end: 0.3, confidence: 1 };
  vi.mocked(transcribe).mockImplementationOnce(async ({ mediaId }) => ({
    mediaId,
    words: [filler],
    engine: "crisper-whisper",
  }));
  const result = await runTranscription(captureTranscription(false), {
    engine: "crisper-whisper",
    modelName: "medium",
    pythonPath: "/tmp/crisper-bench/bin/python",
  });
  expect(transcribe).toHaveBeenCalledOnce();
  expect(projectTranscript(result.project)[1]!.text).toBe("[UM]");
  expect(readTranscriptCache(p.media.m1!)).toEqual(words);
});

it("rejects a project switch during the unsaved Save dialog without writing anything", async () => {
  useProjectStore.setState({ filePath: null });
  const pending = deferred<string | null>();
  vi.mocked(saveDialog).mockImplementationOnce(() => pending.promise);
  const request = captureTranscription(true);
  const task = snapshotBeforeTranscription(request);
  replaceProjectBaseline(twoMedia());
  const current = useProjectStore.getState().project;
  pending.resolve("/tmp/old.scribe");
  await expect(task).rejects.toThrow(/project changed/);
  expect(saveProject).not.toHaveBeenCalled();
  expect(createSnapshot).not.toHaveBeenCalled();
  expect(useProjectStore.getState().project).toBe(current);
});

it("rebuilds originals only for anchors surviving an existing explicit cut", async () => {
  const original = useProjectStore.getState().project;
  const cut = cutTranscriptRanges(original, [
    { segmentId: "s1", blockId: "block-1", from: 0, to: 11 },
  ]);
  replaceProjectBaseline(cut);
  const result = await runTranscription(captureTranscription(true), settings);
  expect(computeTimeline(result.project)).toEqual(computeTimeline(cut));
  expect(result.project.segments[0]!.transcript!.originals.map((w) => w.id)).toEqual(["fresh2"]);
  expect(projectTranscript(result.project)[0]!.text).toBe("originals.");
  const block = projectTranscript(result.project)[0]!;
  const restored = restoreTranscriptBlock(result.project, block.segmentId, block.id);
  expect(projectTranscript(restored)[0]!.text).toBe("originals.");
  expect(computeTimeline(restored)).toEqual(computeTimeline(cut));
});

it("does not count an invisible leading separator retained by a speech cut as a correction", () => {
  const restored = restoreTranscriptBlock(useProjectStore.getState().project, "s1", "block-1");
  const cut = cutTranscriptRanges(restored, [
    { segmentId: "s1", blockId: "block-1", from: 0, to: 4 },
  ]);
  replaceProjectBaseline(cut);
  expect(correctedOccurrences(captureTranscription(true))).toBe(0);
});
