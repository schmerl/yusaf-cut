import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPeaks } from "@/lib/audioPeaks";
import { Waveform } from "@/components/Waveform/Waveform";
import { listModels, transcribeTimelineAudio, cancelScriptAnalysis } from "@/lib/ipc";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { normalizeProjectTranscripts, projectTranscript } from "@/lib/transcript";
import type { Project } from "@/lib/edl";
import fixture from "./fixtures/transcript-corrections.json";

vi.mock("@/lib/ipc", () => ({
  listModels: vi.fn(),
  transcribeTimelineAudio: vi.fn(),
  cancelScriptAnalysis: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audioPeaks", () => ({
  loadPeaks: vi.fn(async () => {
    const peaks = Array(300).fill(0);
    peaks.fill(0.3, 25, 75);
    peaks.fill(0.3, 225, 275);
    return peaks;
  }),
}));
beforeEach(() => {
  vi.mocked(cancelScriptAnalysis).mockResolvedValue(undefined);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  const project = structuredClone(fixture) as Project;
  project.media.m1!.duration = 6;
  project.segments = [
    {
      ...project.segments[0]!,
      sourceOut: 6,
      transcript: undefined,
      words: [{ id: "known", text: "Known sentence.", start: 2, end: 4, confidence: 1 }],
    },
  ];
  replaceProjectBaseline(normalizeProjectTranscripts(project));
  usePlayerStore.getState().reset();
  vi.mocked(listModels).mockResolvedValue([
    { engine: "whisper-cpp", name: "base", sizeMb: 142, installed: true },
  ]);
  vi.mocked(transcribeTimelineAudio).mockImplementation(async (_project, windows) => ({
    windows: windows.map((window) => ({
      ...window,
      text: "Missing speech.",
      words: [{ id: "new", text: "Missing speech.", start: 0.46, end: 1.54, confidence: 0.9 }],
    })),
  }));
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function analyze() {
  render(<Waveform />);
  fireEvent.click(screen.getByRole("button", { name: "Analyze timeline" }));
  return screen.findAllByRole("button", { name: /Audio without words at/ });
}
async function selectGap(index = 0) {
  const gaps = await analyze();
  fireEvent.click(gaps[index]!);
  return gaps[index]!;
}
async function transcribe() {
  fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Transcribe speech" })).toBeEnabled(),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Transcribe speech" }));
  });
}
it("marks waveform gaps directly without a dialog, model lookup, or recognition", async () => {
  const expected = useProjectStore.getState().project;
  const gaps = await analyze();
  expect(gaps).toHaveLength(2);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(listModels).not.toHaveBeenCalled();
  expect(transcribeTimelineAudio).not.toHaveBeenCalled();
  expect(useProjectStore.getState().project).toBe(expected);
});
it("opens actions on a mouse click and listens to the exact range", async () => {
  const gaps = await analyze();
  const seek = vi.fn();
  window.addEventListener("yusafcut:seek-output", seek);
  fireEvent.mouseDown(gaps[0]!, { clientX: 50, button: 0 });
  fireEvent.mouseUp(gaps[0]!, { clientX: 50, button: 0 });
  expect(screen.getByRole("dialog", { name: "Unattributed audio actions" })).toBeInTheDocument();
  expect(seek).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Extend previous sentence" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Extend next sentence" })).toBeEnabled();
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  expect((seek.mock.calls[0]![0] as CustomEvent).detail).toEqual({ time: 0.46, play: true });
  expect(usePlayerStore.getState().timelineMarkOut).toBe(1.54);
  window.removeEventListener("yusafcut:seek-output", seek);
});
it("keeps dragging across a highlighted gap as an audio selection", async () => {
  const gaps = await analyze();
  fireEvent.mouseDown(gaps[0]!, { clientX: 50, button: 0 });
  fireEvent.mouseMove(gaps[0]!, { clientX: 100 });
  fireEvent.mouseUp(gaps[0]!, { clientX: 100, button: 0 });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(usePlayerStore.getState().timelineMarkIn).toBe(0.5);
  expect(usePlayerStore.getState().timelineMarkOut).toBe(1);
});
it("previews bounded recognition only after explicitly choosing Transcribe and supports Undo", async () => {
  const expected = useProjectStore.getState().project;
  await selectGap();
  await transcribe();
  await screen.findByRole("button", { name: "Add to transcript" });
  expect(transcribeTimelineAudio).toHaveBeenCalledWith(
    expected,
    [{ segmentId: "s1", sourceIn: 0.46, sourceOut: 1.54 }],
    expect.any(String),
    "base",
  );
  expect(useProjectStore.getState().project).toBe(expected);
  fireEvent.click(screen.getByRole("button", { name: "Add to transcript" }));
  expect(projectTranscript(useProjectStore.getState().project).map((b) => b.text)).toEqual([
    "Missing speech.",
    "Known sentence.",
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => useProjectStore.temporal.getState().undo());
  expect(useProjectStore.getState().project).toBe(expected);
});
it.each(["next", "previous"])(
  "extends the %s sentence's timing without changing text or transcribing",
  async (direction) => {
    const expected = useProjectStore.getState().project;
    await selectGap(direction === "next" ? 0 : 1);
    fireEvent.click(screen.getByRole("button", { name: `Extend ${direction} sentence` }));
    const blocks = projectTranscript(useProjectStore.getState().project);
    expect(blocks[0]!.text).toBe("Known sentence.");
    expect(blocks[0]!.runs[0]![direction === "next" ? "sourceStart" : "sourceEnd"]).toBe(
      direction === "next" ? 0.46 : 5.54,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(listModels).not.toHaveBeenCalled();
    expect(transcribeTimelineAudio).not.toHaveBeenCalled();
    act(() => useProjectStore.temporal.getState().undo());
    expect(useProjectStore.getState().project).toBe(expected);
  },
);
it("rejects recognition after project edits, including an undo to the initial state", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof transcribeTimelineAudio>>) => void;
  vi.mocked(transcribeTimelineAudio).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await selectGap();
  const expected = useProjectStore.getState().project;
  await transcribe();
  act(() => {
    useProjectStore.getState().rename("Changed");
    useProjectStore.temporal.getState().undo();
  });
  await act(async () =>
    resolve({
      windows: [{ segmentId: "s1", sourceIn: 0.46, sourceOut: 1.54, text: "Late", words: [] }],
    }),
  );
  expect(
    screen
      .getAllByRole("alert")
      .some((element) => /project changed/i.test(element.textContent ?? "")),
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Add to transcript" })).toBeNull();
  expect(useProjectStore.getState().project).toBe(expected);
  expect(cancelScriptAnalysis).toHaveBeenCalled();
});
it("cancels recognition when closing gap actions and ignores a late response", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof transcribeTimelineAudio>>) => void;
  vi.mocked(transcribeTimelineAudio).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await selectGap();
  const expected = useProjectStore.getState().project;
  await transcribe();
  fireEvent.click(screen.getByRole("button", { name: "Close gap actions" }));
  await act(async () => resolve({ windows: [] }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useProjectStore.getState().project).toBe(expected);
  expect(cancelScriptAnalysis).toHaveBeenCalled();
});
it("dismisses a gap without changing the project", async () => {
  const expected = useProjectStore.getState().project;
  await selectGap();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.getAllByRole("button", { name: /Audio without words at/ })).toHaveLength(1);
  expect(useProjectStore.getState().project).toBe(expected);
});

it.each(["Escape", "Close"])("restores focus to the gap after %s", async (action) => {
  const gap = await selectGap();
  expect(screen.getByRole("dialog")).toHaveFocus();
  if (action === "Escape") fireEvent.keyDown(document, { key: "Escape" });
  else fireEvent.click(screen.getByRole("button", { name: "Close gap actions" }));
  expect(gap).toHaveFocus();
});
it.each(["Dismiss", "Extend next sentence", "Add to transcript"])(
  "returns focus to analysis when %s removes the gap",
  async (action) => {
    await selectGap();
    if (action === "Add to transcript") await transcribe();
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(screen.getByRole("button", { name: /Analyze timeline/ })).toHaveFocus();
  },
);
it("skips extraction for video-only clips in waveform rendering and analysis", async () => {
  const project = structuredClone(useProjectStore.getState().project);
  project.media.video = {
    ...project.media.m1!,
    id: "video",
    path: "/silent.mp4",
    audioSampleRate: 0,
  };
  project.segments.push({ id: "video", mediaId: "video", sourceIn: 0, sourceOut: 6, words: [] });
  replaceProjectBaseline(project);
  const gaps = await analyze();
  expect(gaps).toHaveLength(2);
  expect(vi.mocked(loadPeaks).mock.calls.every((call) => call[1] !== "/silent.mp4")).toBe(true);
  expect(screen.queryByText("Waveform unavailable for some media")).toBeNull();
});
it("reports extraction errors for sources with audio", async () => {
  vi.mocked(loadPeaks).mockRejectedValueOnce(new Error("Audio decode failed"));
  render(<Waveform />);
  await screen.findByText("Waveform unavailable for some media");
  vi.mocked(loadPeaks).mockRejectedValueOnce(new Error("Audio decode failed"));
  fireEvent.click(screen.getByRole("button", { name: "Analyze timeline" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Audio decode failed");
});
