import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { useUIStore } from "@/stores/uiStore";
import { buildCues } from "@/lib/captions";
import { totalDuration, type Project } from "@/lib/edl";
import fixture from "./fixtures/script-assistance.json";
import { projectTranscript } from "@/lib/transcript";
import { selectReviewTarget } from "@/components/TranscriptEditor/InlineReview";

beforeEach(() => {
  replaceProjectBaseline(structuredClone(fixture) as Project);
  useUIStore.getState().setFillerReviewOpen(false);
  useFillerAuditionStore.getState().stop();
});
afterEach(() => {
  cleanup();
  useFillerAuditionStore.getState().stop();
});
function Harness() {
  useKeyboardShortcuts();
  return <TranscriptEditor />;
}
function open() {
  render(<Harness />);
}
function marker(className: string) {
  fireEvent.click(document.querySelector(className)!);
  return within(screen.getByRole("dialog", { name: "Review suggestion" }));
}

describe("inline transcript review", () => {
  it("lets form controls and buttons use Space/letters without global playback shortcuts", () => {
    open();
    const playback = vi.fn();
    window.addEventListener("yusafcut:toggle-play", playback);
    window.addEventListener("yusafcut:play", playback);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Review category" }), { key: "l" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Find differences" }), { key: " " });
    fireEvent.keyDown(screen.getByText("Options"), { key: " " });
    expect(playback).not.toHaveBeenCalled();
    window.removeEventListener("yusafcut:toggle-play", playback);
    window.removeEventListener("yusafcut:play", playback);
  });
  it("opens only the clicked marker, resolves Keep and supports visible Undo/Redo", () => {
    open();
    const before = useProjectStore.getState().project;
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".is-script-pending")).not.toBeNull();
    expect(document.querySelector(".is-script-off-script")).not.toBeNull();
    const popover = marker(".is-script-applied");
    fireEvent.click(popover.getByRole("button", { name: "Keep" }));
    const kept = useProjectStore.getState().project;
    expect(document.querySelector(".is-script-applied")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(useProjectStore.getState().project).toBe(before);
    expect(document.querySelector(".is-script-applied")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(useProjectStore.getState().project).toBe(kept);
  });
  it("navigation/playback leaves project clean and decisions unchanged", () => {
    open();
    const before = useProjectStore.getState().project;
    const popover = marker(".is-script-pending");
    fireEvent.click(popover.getByRole("button", { name: "Play" }));
    expect(useFillerAuditionStore.getState().request).toMatchObject({
      expected: before,
      mode: "before",
      reviewLabel: "Review playback",
    });
    fireEvent.click(popover.getByRole("button", { name: "Next" }));
    expect(useProjectStore.getState().project).toBe(before);
    expect(useProjectStore.getState().dirty).toBe(false);
  });
  it("accepts a correction into captions without changing duration", () => {
    open();
    const before = useProjectStore.getState().project;
    fireEvent.click(marker(".is-script-pending").getByRole("button", { name: "Accept" }));
    const after = useProjectStore.getState().project;
    expect(projectTranscript(after)[0]!.text).toBe("idempotency are not the server.");
    expect(totalDuration(after)).toBe(totalDuration(before));
    expect(
      buildCues(after)
        .map((c) => c.text)
        .join(" "),
    ).toContain("server.");
    expect(
      buildCues(after)
        .map((c) => c.text)
        .join(" "),
    ).not.toMatch(/Pending|suggestion|synthetic-fixture/);
  });
  it("shares preview/commit, preserves transcript scroll, then Undo → Keep needs no refresh", () => {
    open();
    const before = useProjectStore.getState().project;
    const popover = marker(".is-script-off-script");
    const scroll = document.querySelector(".transcript-scroll")!;
    scroll.scrollTop = 350;
    fireEvent.click(popover.getByRole("button", { name: "Preview cut" }));
    const audition = useFillerAuditionStore.getState().request!;
    expect(audition.mode).toBe("preview");
    expect(useProjectStore.getState().project).toBe(before);
    fireEvent.click(popover.getByRole("button", { name: "Cut speech" }));
    expect(useProjectStore.getState().project).toBe(audition.timeline);
    expect(scroll.scrollTop).toBe(350);
    expect(totalDuration(audition.timeline)).toBeLessThan(totalDuration(before));
    // Native menu history does not move focus or dismiss the popover.
    act(() => useProjectStore.temporal.getState().undo());
    expect(useProjectStore.getState().project).toBe(before);
    fireEvent.click(popover.getByRole("button", { name: "Keep speech" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      useProjectStore.getState().project.scriptAssistance!.records.find((r) => r.status === "kept"),
    ).toBeTruthy();
    expect(totalDuration(useProjectStore.getState().project)).toBe(totalDuration(before));
  });
  it("discards old previews on project changes and builds the cut against current state", () => {
    open();
    const popover = marker(".is-script-off-script");
    fireEvent.click(popover.getByRole("button", { name: "Preview cut" }));
    const oldPreview = useFillerAuditionStore.getState().request!.timeline;
    act(() => useProjectStore.getState().rename("Changed while previewing"));
    fireEvent.click(popover.getByRole("button", { name: "Cut speech" }));
    expect(useProjectStore.getState().project).not.toBe(oldPreview);
    expect(useProjectStore.getState().project.name).toBe("Changed while previewing");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("refuses a decision when the marked passage has changed", () => {
    open();
    const popover = marker(".is-script-pending");
    const record = useProjectStore
      .getState()
      .project.scriptAssistance!.records.find(
        (r) => r.status === "suggested" && !r.historicalReason,
      )!;
    act(() =>
      useProjectStore.getState().commitTranscript(
        {
          ...useProjectStore.getState().project,
          scriptAssistance: {
            ...useProjectStore.getState().project.scriptAssistance!,
            records: useProjectStore
              .getState()
              .project.scriptAssistance!.records.filter((r) => r.id !== record.id),
          },
        },
        useProjectStore.getState().project,
      ),
    );
    expect(popover.queryByRole("button", { name: "Accept" })).toBeNull();
    act(() => selectReviewTarget({ kind: "script", id: record.id }));
    expect(popover.getByText(/resolved or its passage changed/)).toBeTruthy();
  });
});
