import { beforeEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/transcript-corrections.json";
import { readTranscriptCache, writeTranscriptCache } from "@/lib/transcriptCache";
import { openSavedProject } from "@/lib/openProject";
import { loadProject } from "@/lib/ipc";
import type { Project } from "@/lib/edl";

vi.mock("@/lib/ipc", () => ({ loadProject: vi.fn() }));
const media = fixture.media.m1;
const words = fixture.segments[0]!.words;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it("does not reuse v1 caches possibly polluted with corrected or partial project text", () => {
  localStorage.setItem(`yusafcut.transcript.v1.${media.sha256}`, JSON.stringify({ words }));
  expect(readTranscriptCache(media)).toBeNull();
});

it("roundtrips raw recognition in the new namespace and checks the source hash", () => {
  writeTranscriptCache(media, words);
  expect(readTranscriptCache(media)).toEqual(words);
  expect(readTranscriptCache({ ...media, sha256: "another" })).toBeNull();
});

it("opening a corrected project leaves the raw cache untouched", async () => {
  writeTranscriptCache(media, words);
  const before = localStorage.getItem(`yusafcut.recognition.v2.${media.sha256}`);
  vi.mocked(loadProject).mockResolvedValue(globalThis.structuredClone(fixture) as Project);
  await openSavedProject("/tmp/corrected.scribe");
  expect(localStorage.getItem(`yusafcut.recognition.v2.${media.sha256}`)).toBe(before);
  expect(readTranscriptCache(media)).toEqual(words);
});

it("opening a legacy project never seeds a raw-recognition cache with its unverified text", async () => {
  const project = globalThis.structuredClone(fixture) as Project;
  delete project.segments[0]!.transcript;
  vi.mocked(loadProject).mockResolvedValue(project);
  await openSavedProject("/tmp/legacy.scribe");
  expect(readTranscriptCache(media)).toBeNull();
});
