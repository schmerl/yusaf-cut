import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPreview } from "@/components/VideoPreview/VideoPreview";
import { prepareFillerAudition, releaseFillerAudition } from "@/lib/ipc";
import { useFillerAuditionStore, startFillerAudition } from "@/stores/fillerAuditionStore";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import type { Project } from "@/lib/edl";
import edges from "./fixtures/filler-retained-edges.json";
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/lib/ipc", () => ({
  prepareFillerAudition: vi.fn(),
  releaseFillerAudition: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/hooks/useVideoFrameClock", () => ({ useVideoFrameClock: vi.fn() }));
let p: Project;
beforeEach(() => {
  p = structuredClone(edges) as Project;
  replaceProjectBaseline(p);
  usePlayerStore.getState().reset();
  useFillerAuditionStore.getState().stop();
  vi.clearAllMocks();
  vi.mocked(releaseFillerAudition).mockResolvedValue(undefined);
  vi.mocked(prepareFillerAudition).mockImplementation(async (_project, from, to) => ({
    path: "/tmp/rendered.mp4",
    duration: to - from,
  }));
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
});
afterEach(() => {
  cleanup();
  useFillerAuditionStore.getState().stop();
  vi.restoreAllMocks();
});
async function start(
  options: { from?: number; to?: number; before?: number; after?: number; loop?: boolean } = {},
) {
  await act(async () =>
    startFillerAudition({
      expected: p,
      timeline: p,
      occurrenceId: "test",
      mode: "preview",
      from: 0.55,
      to: 0.55,
      before: 0.25,
      after: 0.25,
      loop: false,
      ...options,
    }),
  );
  return screen.getByLabelText("Filler audition").querySelector("video")!;
}
function tick(el: HTMLVideoElement, time: number) {
  el.currentTime = time;
  fireEvent.timeUpdate(el);
}

describe("rendered continuous audition playback", () => {
  it("plays one rendered passage without source seeks at the cut, project changes or normal playhead changes", async () => {
    render(<VideoPreview />);
    act(() => usePlayerStore.getState().setCurrentTime(2));
    const el = await start();
    expect(vi.mocked(prepareFillerAudition).mock.calls[0]![0]).toBe(p);
    expect(vi.mocked(prepareFillerAudition).mock.calls[0]![1]).toBeCloseTo(0.3);
    expect(vi.mocked(prepareFillerAudition).mock.calls[0]![2]).toBeCloseTo(0.8);
    expect(el.getAttribute("src")).toBe("/tmp/rendered.mp4");
    tick(el, 0.25); // the join is .25 seconds into this continuous file
    expect(el.currentTime).toBe(0.25);
    tick(el, 0.4);
    expect(el.currentTime).toBe(0.4);
    expect(prepareFillerAudition).toHaveBeenCalledTimes(1);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    tick(el, 0.5);
    expect(screen.getByText(/Finished/)).toBeInTheDocument();
    expect(useProjectStore.getState().project).toBe(p);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    expect(usePlayerStore.getState().currentTime).toBe(2);
    expect(usePlayerStore.getState().playing).toBe(false);
  });
  it("does not restart original media when a delayed native play event arrives during an audition", async () => {
    const view = render(<VideoPreview />);
    const source = view.container.querySelector("video")!;
    await start();
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    fireEvent.play(source);
    expect(usePlayerStore.getState().playing).toBe(false);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it("isolates the preview from a late before-play promise and its old media element", async () => {
    let finishBefore!: () => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishBefore = resolve;
        }),
    );
    render(<VideoPreview />);
    await act(async () =>
      startFillerAudition({
        expected: p,
        timeline: p,
        occurrenceId: "test",
        mode: "before",
        from: 0.3,
        to: 0.8,
        before: 0,
        after: 0,
        loop: false,
      }),
    );
    const before = screen.getByLabelText("Filler audition").querySelector("video")!;
    const preview = await start();
    expect(preview).not.toBe(before);
    expect(before.isConnected).toBe(false);
    vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
    await act(async () => finishBefore());
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).toContain(before);
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).not.toContain(preview);
  });
  it("loops the prepared file only when enabled and clamps context to output boundaries", async () => {
    render(<VideoPreview />);
    const el = await start({ from: 0, to: 0.3, before: 2, after: 0, loop: true });
    tick(el, 0.31);
    expect(el.currentTime).toBe(0);
    expect(prepareFillerAudition).toHaveBeenCalledTimes(1);
    act(() => useFillerAuditionStore.getState().stop());
    await start({ from: 4.7, to: 4.7, before: 0, after: 2 });
    expect(useFillerAuditionStore.getState().request!.end).toBeCloseTo(4.8);
  });
  it("passes repeated placements and multiple media to the renderer without swapping sources during playback", async () => {
    const first = p.segments[0]!;
    p = {
      ...p,
      media: { ...p.media, m2: { ...p.media.m1!, id: "m2", path: "/tmp/second.mp4" } },
      segments: [
        first,
        { ...first, id: "repeat", occurrenceLineage: "repeat", transcript: undefined },
        { ...first, id: "other", mediaId: "m2", occurrenceLineage: "other", transcript: undefined },
      ],
    };
    replaceProjectBaseline(p);
    render(<VideoPreview />);
    const el = await start({ from: 0.4, to: 0.4, before: 0, after: 1 });
    tick(el, 0.2);
    tick(el, 0.7);
    expect(el.getAttribute("src")).toBe("/tmp/rendered.mp4");
    expect(prepareFillerAudition).toHaveBeenCalledTimes(1);
    expect(prepareFillerAudition).toHaveBeenCalledWith(p, 0.4, 1.4, expect.any(String));
  });
  it("cancels preparation on Stop and never plays a stale completed render", async () => {
    let resolve!: (clip: { path: string; duration: number }) => void;
    vi.mocked(prepareFillerAudition).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(<VideoPreview />);
    await start();
    expect(screen.getByText(/Preparing continuous playback/)).toBeInTheDocument();
    act(() => useFillerAuditionStore.getState().stop());
    await act(async () => resolve({ path: "/tmp/stale.mp4", duration: 0.5 }));
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(releaseFillerAudition).toHaveBeenCalledWith(expect.any(String));
  });
  it("cancels on ordinary transport, project edits, baseline replacement and unmount", async () => {
    const view = render(<VideoPreview />);
    for (const event of [
      "yusafcut:seek-output",
      "yusafcut:play",
      "yusafcut:toggle-play",
      "yusafcut:pause",
    ]) {
      await start();
      act(() => window.dispatchEvent(new CustomEvent(event, { detail: { time: 0, play: false } })));
      expect(useFillerAuditionStore.getState().request).toBeNull();
    }
    await start();
    act(() => useProjectStore.getState().rename("external"));
    expect(useFillerAuditionStore.getState().request).toBeNull();
    p = useProjectStore.getState().project;
    await start();
    act(() => replaceProjectBaseline(structuredClone(p)));
    expect(useFillerAuditionStore.getState().request).toBeNull();
    p = useProjectStore.getState().project;
    await start();
    view.unmount();
    expect(useFillerAuditionStore.getState().request).toBeNull();
  });
  it("does not resume a pending play promise after Stop", async () => {
    let resolve!: () => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    render(<VideoPreview />);
    const el = await start();
    act(() => useFillerAuditionStore.getState().stop());
    await act(async () => resolve());
    fireEvent.canPlay(el);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(useFillerAuditionStore.getState().request).toBeNull();
  });
  it("surfaces render/load failures without autoplay", async () => {
    render(<VideoPreview />);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    vi.mocked(prepareFillerAudition).mockRejectedValueOnce(new Error("render failed"));
    await start();
    expect(screen.getByRole("alert")).toHaveTextContent("render failed");
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    act(() => useFillerAuditionStore.getState().stop());
    const el = await start();
    fireEvent.error(el);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded/);
  });
});
