import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPreview } from "@/components/VideoPreview/VideoPreview";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import type { Project } from "@/lib/edl";
import fixture from "./fixtures/transcript-corrections.json";
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/hooks/useVideoFrameClock", () => ({ useVideoFrameClock: vi.fn() }));

beforeEach(() => {
  replaceProjectBaseline(globalThis.structuredClone(fixture) as Project);
  usePlayerStore.getState().reset();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function seek(time: number, play = false) {
  act(() =>
    window.dispatchEvent(new CustomEvent("yusafcut:seek-output", { detail: { time, play } })),
  );
}
function tick(video: HTMLVideoElement, sourceTime: number) {
  video.currentTime = sourceTime;
  fireEvent.timeUpdate(video);
}

describe("VideoPreview retains the selected source occurrence", () => {
  it("Cmd-click on the second aren't stays at 4.1s after native timeupdate", () => {
    const { container } = render(
      <>
        <VideoPreview />
        <TranscriptEditor />
      </>,
    );
    const video = container.querySelector("video")!;
    const phrase = Array.from(
      screen.getByRole("textbox").querySelectorAll<HTMLElement>("[data-run-id]"),
    ).find((el) => el.textContent === "aren’t")!;
    fireEvent.click(phrase, { metaKey: true });
    expect(video.currentTime).toBeCloseTo(1.1);
    expect(usePlayerStore.getState().currentTime).toBeCloseTo(4.1);
    fireEvent.timeUpdate(video);
    expect(usePlayerStore.getState().currentTime).toBeCloseTo(4.1);
    expect(screen.getByRole("textbox").querySelector(".is-playing")!.textContent).toBe("aren’t");
    expect(usePlayerStore.getState().playing).toBe(false);
  });

  it("keeps first and second occurrences distinct during playback and repeated seeks", () => {
    const { container } = render(<VideoPreview />);
    const video = container.querySelector("video")!;
    seek(4.1, true);
    tick(video, 1.5);
    expect(usePlayerStore.getState().currentTime).toBeCloseTo(4.5);
    expect(usePlayerStore.getState().playing).toBe(true);
    seek(1.1);
    tick(video, 1.5);
    expect(usePlayerStore.getState().currentTime).toBeCloseTo(1.5);
    seek(4.1);
    tick(video, 1.5);
    expect(usePlayerStore.getState().currentTime).toBeCloseTo(4.5);
  });

  it("advances through repeated source ranges at the native media end, then stops at output end", () => {
    const { container } = render(<VideoPreview />);
    const video = container.querySelector("video")!;
    seek(2.9, true);
    video.currentTime = 3;
    fireEvent.ended(video);
    expect(video.currentTime).toBe(0);
    expect(usePlayerStore.getState().currentTime).toBe(3);
    expect(usePlayerStore.getState().playing).toBe(true);
    tick(video, 1.1);
    expect(usePlayerStore.getState().currentTime).toBeCloseTo(4.1);
    tick(video, 3);
    expect(usePlayerStore.getState().currentTime).toBe(6);
    expect(usePlayerStore.getState().playing).toBe(false);
  });

  it("still skips a removed source prefix when a trimmed project starts playing", () => {
    const p = globalThis.structuredClone(fixture) as Project;
    delete p.segments[0]!.transcript;
    p.segments[0]!.sourceIn = 1;
    replaceProjectBaseline(p);
    const { container } = render(<VideoPreview />);
    const video = container.querySelector("video")!;
    act(() => usePlayerStore.getState().setPlaying(true));
    tick(video, 0);
    expect(video.currentTime).toBe(1);
    expect(usePlayerStore.getState().currentTime).toBe(0);
    expect(usePlayerStore.getState().playing).toBe(true);
  });

  it("uses output order for reordered overlapping ranges of the same media", () => {
    const p = globalThis.structuredClone(fixture) as Project;
    delete p.segments[0]!.transcript;
    p.segments[0]!.sourceIn = 1;
    p.segments[0]!.sourceOut = 3;
    replaceProjectBaseline(p);
    const { container } = render(<VideoPreview />);
    const video = container.querySelector("video")!;
    seek(3.5);
    tick(video, 1.75);
    expect(usePlayerStore.getState().currentTime).toBe(3.75);
    seek(0.5);
    tick(video, 1.75);
    expect(usePlayerStore.getState().currentTime).toBe(0.75);
    expect(useProjectStore.getState().project).toBe(p);
  });
});
