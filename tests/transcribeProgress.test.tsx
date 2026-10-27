import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTranscribeProgress } from "@/hooks/useTranscribeProgress";
import { onTranscribeProgress } from "@/lib/ipc";
import { useUIStore } from "@/stores/uiStore";
vi.mock("@/lib/ipc", () => ({
  onTranscribeProgress: vi.fn(async () => () => undefined),
  onExportProgress: vi.fn(async () => () => undefined),
  onModelDownloadProgress: vi.fn(async () => () => undefined),
}));
afterEach(cleanup);
it("keeps per-clip completion visible until workflow commit and ignores late progress after completion", () => {
  useUIStore.setState({ transcribeProgress: 0 });
  renderHook(() => useTranscribeProgress());
  const progress = vi.mocked(onTranscribeProgress).mock.calls[0]![0];
  act(() => progress({ mediaId: "first", progress: 1, currentTime: 3 }));
  expect(useUIStore.getState().transcribeProgress).toBe(1);
  act(() => progress({ mediaId: "second", progress: 0.2, currentTime: 0.6 }));
  expect(useUIStore.getState().transcribeProgress).toBe(0.2);
  act(() => useUIStore.getState().setTranscribeProgress(null));
  act(() => progress({ mediaId: "second", progress: 1, currentTime: 3 }));
  expect(useUIStore.getState().transcribeProgress).toBeNull();
});
