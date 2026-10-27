import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelinePlayer } from "@/components/VideoPreview/TimelinePlayer";
import { VideoPreview } from "@/components/VideoPreview/VideoPreview";
import { createPlayerStore, usePlayerStore } from "@/stores/playerStore";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { speech } from "./helpers/retakeProject";
import { lexicalRetakes, retakeRecords, retakeWindows } from "@/lib/retakes";
import { planRetakeCut } from "@/lib/retakeCuts";
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));
vi.mock("@/hooks/useVideoFrameClock", () => ({ useVideoFrameClock: vi.fn() }));
beforeEach(() => {
  usePlayerStore.getState().reset();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const seek = (scope: string, time: number, play = false) =>
  act(() =>
    window.dispatchEvent(new CustomEvent(`${scope}:seek-output`, { detail: { time, play } })),
  );
describe("isolated original and proposed audition", () => {
  it("uses the proposed EDL without publishing preview time or edits to the main project", () => {
    const p = speech("The the server responds.");
    replaceProjectBaseline(p);
    const candidate = lexicalRetakes(retakeWindows(retakeRecords(p))[0]!)[0]!;
    const plan = planRetakeCut(p, candidate, candidate.attempts[1]!.id);
    const audition = createPlayerStore();
    const { container } = render(
      <>
        <VideoPreview />
        <TimelinePlayer
          project={plan.nextProject}
          playerStore={audition}
          eventScope="audition"
          auditionRange={plan.editedAudition}
          label="Proposed cut"
        />
      </>,
    );
    seek("yusafcut", 5);
    seek("audition", 0, true);
    const video = container.querySelector(
      '[data-timeline-player="audition"] video',
    ) as HTMLVideoElement;
    expect(video.currentTime).toBeCloseTo(plan.nextProject.segments[0]!.sourceIn);
    video.currentTime = 0.5;
    fireEvent.timeUpdate(video);
    expect(audition.getState().currentTime).toBeCloseTo(
      0.5 - plan.nextProject.segments[0]!.sourceIn,
    );
    expect(usePlayerStore.getState().currentTime).toBe(5);
    expect(useProjectStore.getState().project).toBe(p);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
  });
  it("clamps seeking and stops at the original context endpoint", () => {
    const p = speech("One two three four five.");
    const audition = createPlayerStore();
    const { container, unmount } = render(
      <TimelinePlayer
        project={p}
        playerStore={audition}
        eventScope="audition"
        auditionRange={{ start: 0.4, end: 1.4 }}
        label="Original"
      />,
    );
    const video = container.querySelector("video")!;
    seek("audition", 0, true);
    expect(video.currentTime).toBeCloseTo(0.4);
    video.currentTime = 1.5;
    fireEvent.timeUpdate(video);
    expect(audition.getState().currentTime).toBeCloseTo(1.4);
    expect(audition.getState().playing).toBe(false);
    seek("audition", 100);
    expect(video.currentTime).toBeCloseTo(1.4);
    unmount();
    expect(audition.getState().playing).toBe(false);
  });
});
