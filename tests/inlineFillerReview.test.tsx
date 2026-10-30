import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  vi.mocked(estimateFillerBoundaries).mockReset();
});
afterEach(() => {
  cleanup();
  useFillerAuditionStore.getState().stop();
});
function popup() {
  return within(screen.getByRole("dialog", { name: "Review suggestion" }));
}
function open(index = 0) {
  fireEvent.click(document.querySelectorAll("[data-filler-id]")[index]!);
}
it("clicks a filler in place, previews and commits the same cut, then Undo → Keep works", () => {
  render(<TranscriptEditor />);
  const before = useProjectStore.getState().project;
  open();
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
});
it("offers text-only removal on demand without changing duration", () => {
  render(<TranscriptEditor />);
  const duration = totalDuration(useProjectStore.getState().project);
  open();
  fireEvent.click(popup().getByText("Adjust cut"));
  fireEvent.click(popup().getByRole("button", { name: "Remove text only" }));
  expect(screen.getByRole("textbox", { name: "Editable transcript" }).textContent).not.toContain(
    "[UM]",
  );
  expect(totalDuration(useProjectStore.getState().project)).toBe(duration);
});
it("ignores an audio boundary estimate arriving after navigation to a different filler", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof estimateFillerBoundaries>>) => void;
  vi.mocked(estimateFillerBoundaries).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<TranscriptEditor />);
  open();
  fireEvent.click(popup().getByText("Adjust cut"));
  fireEvent.click(popup().getByRole("button", { name: "Estimate from audio" }));
  fireEvent.click(popup().getByRole("button", { name: "Next" }));
  await act(async () =>
    resolve({ start: 0.4, end: 0.9, reason: "Synthetic", limitedByNeighbor: false }),
  );
  fireEvent.click(popup().getByText("Adjust cut"));
  expect(popup().getByRole("spinbutton", { name: "Cut start offset" })).toHaveValue(0);
  expect(popup().getByRole("spinbutton", { name: "Cut end offset" })).toHaveValue(0);
  expect(popup().getByText("[UH]")).toBeTruthy();
});
