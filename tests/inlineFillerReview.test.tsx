import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { addMediaWithTranscript, newProject, totalDuration } from "@/lib/edl";
import { estimateFillerBoundaries } from "@/lib/ipc";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import source from "./fixtures/transcript-corrections.json";
vi.mock("@/lib/ipc", () => ({ estimateFillerBoundaries: vi.fn() }));
beforeEach(() => {
  const p = addMediaWithTranscript(
    newProject("Inline filler test"),
    source.media.m1,
    ["Hello", "[UM]", "there", "[UH]", "world."].map((text, i) => ({
      id: `word-${i}`,
      text,
      start: i * 0.5,
      end: i * 0.5 + 0.3,
      confidence: 1,
    })),
  );
  replaceProjectBaseline(p);
  vi.mocked(estimateFillerBoundaries)
    .mockReset()
    .mockResolvedValue({
      start: null,
      end: null,
      reason: "Synthetic uncertain bounds",
      limitedByNeighbor: false,
    });
});
afterEach(() => {
  cleanup();
  useFillerAuditionStore.getState().stop();
});
function popup() {
  return within(screen.getByRole("dialog", { name: "Review suggestion" }));
}
async function open(index = 0) {
  fireEvent.click(document.querySelectorAll("[data-filler-id]")[index]!);
  await waitFor(() => expect(popup().getByRole("button", { name: "Preview cut" })).toBeEnabled());
}
it("clicks a filler in place, previews and commits the same cut, then Undo → Keep works", async () => {
  render(<TranscriptEditor />);
  const before = useProjectStore.getState().project;
  await open();
  expect(popup().getByText("[UM]")).toBeTruthy();
  fireEvent.click(popup().getByRole("button", { name: "Preview cut" }));
  const preview = useFillerAuditionStore.getState().request!.timeline;
  expect(useProjectStore.getState().project).toBe(before);
  fireEvent.click(popup().getByRole("button", { name: "Cut speech" }));
  expect(useProjectStore.getState().project).toBe(preview);
  expect(totalDuration(preview)).toBeLessThan(totalDuration(before));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  fireEvent.click(popup().getByRole("button", { name: "Keep speech" }));
  expect(totalDuration(useProjectStore.getState().project)).toBe(totalDuration(before));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(popup().getByRole("button", { name: "Next" }));
  expect(popup().getByText("[UH]")).toBeTruthy();
  await waitFor(() => expect(popup().getByRole("button", { name: "Preview cut" })).toBeEnabled());
});
it("offers text-only removal on demand without changing duration", async () => {
  render(<TranscriptEditor />);
  const duration = totalDuration(useProjectStore.getState().project);
  await open();
  fireEvent.click(popup().getByText("Adjust cut"));
  fireEvent.click(popup().getByRole("button", { name: "Remove text only" }));
  expect(screen.getByRole("textbox", { name: "Editable transcript" }).textContent).not.toContain(
    "[UM]",
  );
  expect(totalDuration(useProjectStore.getState().project)).toBe(duration);
});
it("ignores an automatic boundary estimate arriving after navigation to a different filler", async () => {
  const resolve: ((value: Awaited<ReturnType<typeof estimateFillerBoundaries>>) => void)[] = [];
  vi.mocked(estimateFillerBoundaries).mockImplementation(() => new Promise((r) => resolve.push(r)));
  render(<TranscriptEditor />);
  fireEvent.click(document.querySelector("[data-filler-id]")!);
  expect(estimateFillerBoundaries).toHaveBeenCalledTimes(1);
  fireEvent.click(popup().getByRole("button", { name: "Next" }));
  expect(estimateFillerBoundaries).toHaveBeenCalledTimes(2);
  await act(async () =>
    resolve[0]!({ start: 0.4, end: 0.9, reason: "Synthetic", limitedByNeighbor: false }),
  );
  fireEvent.click(popup().getByText("Adjust cut"));
  expect(popup().getByRole("spinbutton", { name: "Cut start offset" })).toHaveValue(0);
  expect(popup().getByRole("spinbutton", { name: "Cut end offset" })).toHaveValue(0);
  expect(popup().getByText("[UH]")).toBeTruthy();
  await act(async () =>
    resolve[1]!({
      start: null,
      end: null,
      reason: "Synthetic uncertain",
      limitedByNeighbor: false,
    }),
  );
});
it("automatically estimates once per visited filler, without editing the project", async () => {
  vi.mocked(estimateFillerBoundaries)
    .mockResolvedValueOnce({
      start: 0.45,
      end: 0.85,
      reason: "Synthetic",
      limitedByNeighbor: false,
    })
    .mockResolvedValueOnce({
      start: 1.45,
      end: 1.85,
      reason: "Synthetic",
      limitedByNeighbor: false,
    });
  render(<TranscriptEditor />);
  const before = useProjectStore.getState().project;
  await open();
  expect(estimateFillerBoundaries).toHaveBeenCalledTimes(1);
  fireEvent.click(popup().getByText("Adjust cut"));
  expect(popup().getByRole("spinbutton", { name: "Cut start offset" })).toHaveValue(-50);
  expect(popup().getByRole("spinbutton", { name: "Cut end offset" })).toHaveValue(50);
  fireEvent.change(popup().getByRole("spinbutton", { name: "Cut start offset" }), {
    target: { value: "-20" },
  });
  expect(estimateFillerBoundaries).toHaveBeenCalledTimes(1);
  expect(useProjectStore.getState().project).toBe(before);
  fireEvent.click(popup().getByRole("button", { name: "Next" }));
  await waitFor(() => expect(popup().getByRole("button", { name: "Preview cut" })).toBeEnabled());
  expect(estimateFillerBoundaries).toHaveBeenCalledTimes(2);
  expect(popup().getByRole("spinbutton", { name: "Cut start offset" })).toHaveValue(-50);
  expect(useProjectStore.getState().project).toBe(before);
});
it("does not overwrite manual timing when an automatic estimate arrives late", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof estimateFillerBoundaries>>) => void;
  vi.mocked(estimateFillerBoundaries).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<TranscriptEditor />);
  fireEvent.click(document.querySelector("[data-filler-id]")!);
  fireEvent.click(popup().getByText("Adjust cut"));
  fireEvent.change(popup().getByRole("spinbutton", { name: "Cut start offset" }), {
    target: { value: "-20" },
  });
  await act(async () =>
    resolve({ start: 0.4, end: 0.9, reason: "Synthetic", limitedByNeighbor: false }),
  );
  expect(popup().getByRole("spinbutton", { name: "Cut start offset" })).toHaveValue(-20);
  expect(popup().getByRole("spinbutton", { name: "Cut end offset" })).toHaveValue(0);
});
