import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useVideoFrameClock } from "@/hooks/useVideoFrameClock";
function Clock({ tick, source = "first" }: { tick: (time: number) => void; source?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useVideoFrameClock(ref, tick, true, source);
  return <video key={source} ref={ref} />;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("uses rAF for audio-only media even when the element exposes video frame callbacks", () => {
  const videoFrame = vi.fn();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 17),
  );
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(0);
  const previous = Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype,
    "requestVideoFrameCallback",
  );
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
    configurable: true,
    value: videoFrame,
  });
  try {
    const result = render(<Clock tick={vi.fn()} />);
    expect(videoFrame).not.toHaveBeenCalled();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    result.unmount();
    expect(cancel).toHaveBeenCalledWith(17);
  } finally {
    if (previous)
      Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", previous);
    else Reflect.deleteProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback");
  }
});

it("rebinds the clock to a replaced media element while playback stays enabled", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((frame: FrameRequestCallback) => {
      frames.push(frame);
      return frames.length;
    }),
  );
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const tick = vi.fn();
  const view = render(<Clock tick={tick} source="before" />);
  const old = view.container.querySelector("video")!;
  old.currentTime = 3;
  view.rerender(<Clock tick={tick} source="preview" />);
  const current = view.container.querySelector("video")!;
  current.currentTime = 0.25;
  expect(current).not.toBe(old);
  expect(cancel).toHaveBeenCalledWith(1);
  frames[0]!(0);
  expect(tick).not.toHaveBeenCalled();
  frames[1]!(0);
  expect(tick).toHaveBeenCalledWith(0.25);
});
