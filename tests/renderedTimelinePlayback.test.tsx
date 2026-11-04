import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoPreview } from "@/components/VideoPreview/VideoPreview";
import { prepareFillerAudition, releaseFillerAudition } from "@/lib/ipc";
import { addMediaWithTranscript, newProject, type Project } from "@/lib/edl";
import { projectTranscript } from "@/lib/transcript";
import { buildTranscriptCut } from "@/lib/transcriptCut";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { startReviewAudition, useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { usePlayerStore } from "@/stores/playerStore";
import fixture from "./fixtures/transcript-corrections.json";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/lib/ipc", () => ({ prepareFillerAudition: vi.fn(), releaseFillerAudition: vi.fn() }));
vi.mock("@/hooks/useVideoFrameClock", () => ({ useVideoFrameClock: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.mocked(prepareFillerAudition)
    .mockReset()
    .mockImplementation(async (_p, from, to, id) => ({
      path: `/tmp/${id}.mp4`,
      duration: to - from,
    }));
  vi.mocked(releaseFillerAudition).mockReset().mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  usePlayerStore.getState().reset();
  useFillerAuditionStore.getState().stop();
});
afterEach(() => {
  cleanup();
  useFillerAuditionStore.getState().stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function play(time = 0) {
  await act(async () =>
    window.dispatchEvent(new CustomEvent("yusafcut:seek-output", { detail: { time, play: true } })),
  );
  return screen.getByLabelText("Edited timeline playback").querySelector("video")!;
}
function cutProject() {
  const p = addMediaWithTranscript(
    newProject("ex- existing"),
    { ...fixture.media.m1, duration: 3 },
    [
      { id: "previous", text: "the", start: 0, end: 0.4, confidence: 1 },
      { id: "stumble", text: "ex-", start: 0.4, end: 0.42, confidence: 1 },
      { id: "next", text: "existing", start: 0.9, end: 1.4, confidence: 1 },
      { id: "last", text: "interfaces.", start: 1.4, end: 2, confidence: 1 },
    ],
  );
  const b = projectTranscript(p)[0]!,
    run = b.runs.find((r) => r.text === "ex-")!;
  const ranges = [{ segmentId: b.segmentId, blockId: b.id, from: run.from, to: run.to }];
  expect(buildTranscriptCut(p, ranges).offsets.endMs).toBeCloseTo(400);
  return { p, proposal: buildTranscriptCut(p, ranges, { startMs: 0, endMs: 180 }) };
}

it("plays the committed adjusted ex- cut through the same renderer as its preview, without source seeks or leaked native audio", async () => {
  const { p, proposal } = cutProject();
  replaceProjectBaseline(p);
  const view = render(<VideoPreview />),
    source = view.container.querySelector("video")!;
  await act(async () =>
    startReviewAudition({
      expected: p,
      timeline: proposal.result,
      occurrenceId: "stumble",
      mode: "preview",
      from: proposal.joinOutput,
      to: proposal.joinOutput,
      before: 2,
      after: 2,
      loop: false,
    }),
  );
  const previewProject = vi.mocked(prepareFillerAudition).mock.calls[0]![0];
  expect(previewProject).toBe(proposal.result);
  act(() => useProjectStore.getState().commitTranscript(proposal.result, p));
  vi.mocked(HTMLMediaElement.prototype.play).mockClear();
  const edited = await play();
  expect(prepareFillerAudition).toHaveBeenLastCalledWith(
    previewProject,
    0,
    2.8,
    expect.any(String),
  );
  expect(
    vi.mocked(HTMLMediaElement.prototype.play).mock.contexts.every((el) => el !== source),
  ).toBe(true);
  edited.currentTime = 0.45;
  fireEvent.timeUpdate(edited);
  expect(usePlayerStore.getState().currentTime).toBeCloseTo(0.45);
  // The old player noticed the cut only after this frame, allowing the first
  // part of the stumble to escape. Native-source events must now be inert.
  source.currentTime = 0.5;
  fireEvent.timeUpdate(source);
  fireEvent.play(source);
  fireEvent.pause(source);
  expect(usePlayerStore.getState().currentTime).toBeCloseTo(0.45);
  expect(usePlayerStore.getState().playing).toBe(true);
  expect(edited.currentTime).toBe(0.45);
  expect(source.muted).toBe(true);
  expect(edited.getAttribute("src")).toMatch(/^\/tmp\//);
  expect(useProjectStore.getState().project).toBe(previewProject);
});

it("renders long recordings in bounded windows, prefetches only the next window and releases played files", async () => {
  const listeners = vi.spyOn(HTMLMediaElement.prototype, "addEventListener");
  const { proposal } = cutProject();
  const p: Project = {
    ...proposal.result,
    media: { m1: { ...fixture.media.m1, duration: 60 } },
    segments: [
      {
        ...proposal.result.segments[0]!,
        sourceOut: 50,
        words: [],
        transcript: undefined,
        precise: true,
      },
    ],
  };
  replaceProjectBaseline(p);
  render(<VideoPreview />);
  const edited = await play();
  const oldEnded = listeners.mock.calls.find(
    (call, index) => call[0] === "ended" && listeners.mock.contexts[index] === edited,
  )![1] as EventListener;
  expect(vi.mocked(prepareFillerAudition).mock.calls.map((c) => c.slice(1, 3))).toEqual([
    [0, 20],
    [20, 40],
  ]);
  const first = vi.mocked(prepareFillerAudition).mock.calls[0]![3];
  await act(async () => fireEvent.ended(edited));
  expect(prepareFillerAudition).toHaveBeenLastCalledWith(p, 40, 50, expect.any(String));
  expect(releaseFillerAudition).toHaveBeenCalledWith(first);
  edited.currentTime = 0.25;
  fireEvent.timeUpdate(edited);
  expect(usePlayerStore.getState().currentTime).toBeCloseTo(20.25);
  expect(usePlayerStore.getState().playing).toBe(true);
  act(() => oldEnded.call(edited, new Event("ended")));
  expect(usePlayerStore.getState().currentTime).toBeCloseTo(20.25);
  expect(prepareFillerAudition).toHaveBeenCalledTimes(3);
});

it("respects markers and pause/resume during rendered playback", async () => {
  const { proposal } = cutProject();
  replaceProjectBaseline(proposal.result);
  render(<VideoPreview />);
  act(() => usePlayerStore.getState().setTimelineRange(0.2, 1.2));
  const edited = await play(0.2);
  expect(prepareFillerAudition).toHaveBeenLastCalledWith(
    proposal.result,
    0.2,
    1.2,
    expect.any(String),
  );
  act(() => window.dispatchEvent(new CustomEvent("yusafcut:pause")));
  expect(usePlayerStore.getState().playing).toBe(false);
  await act(async () => window.dispatchEvent(new CustomEvent("yusafcut:play")));
  expect(usePlayerStore.getState().playing).toBe(true);
  expect(prepareFillerAudition).toHaveBeenCalledTimes(1);
  fireEvent.ended(edited);
  expect(usePlayerStore.getState().currentTime).toBe(1.2);
  expect(usePlayerStore.getState().playing).toBe(false);
});

it("cancels stale preparation on project changes and never plays its completed file", async () => {
  let finish!: (clip: { path: string; duration: number }) => void;
  vi.mocked(prepareFillerAudition).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { proposal } = cutProject();
  replaceProjectBaseline(proposal.result);
  render(<VideoPreview />);
  await play();
  const id = vi.mocked(prepareFillerAudition).mock.calls[0]![3];
  act(() => useProjectStore.getState().rename("Changed while rendering"));
  await act(async () => finish({ path: "/tmp/stale.mp4", duration: 2.8 }));
  expect(releaseFillerAudition).toHaveBeenCalledWith(id);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Edited timeline playback")).toBeNull();
});

it("reports a render failure without falling back to the uncut source, and permits retry", async () => {
  vi.mocked(prepareFillerAudition).mockRejectedValueOnce(new Error("Synthetic render failure"));
  const { proposal } = cutProject();
  replaceProjectBaseline(proposal.result);
  render(<VideoPreview />);
  await play();
  expect(screen.getByRole("alert")).toHaveTextContent("Synthetic render failure");
  expect(usePlayerStore.getState().playing).toBe(false);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  await act(async () => window.dispatchEvent(new CustomEvent("yusafcut:play")));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(usePlayerStore.getState().playing).toBe(true);
});
