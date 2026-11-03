import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { Waveform } from "@/components/Waveform/Waveform";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { dispatchCommand } from "@/lib/appCommands";
import { totalDuration, type Project } from "@/lib/edl";
import { normalizeProjectTranscripts } from "@/lib/transcript";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { useUIStore } from "@/stores/uiStore";
import fixture from "./fixtures/transcript-corrections.json";

function Harness() {
  useKeyboardShortcuts();
  return (
    <>
      <TranscriptEditor />
      <Waveform />
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  replaceProjectBaseline(normalizeProjectTranscripts(structuredClone(fixture) as Project));
  usePlayerStore.getState().reset();
  useUIStore.setState({ toasts: [], isProcessingEdit: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function selectTimeline(from = 0, to = 100) {
  const rail = screen.getByLabelText("Timeline selection");
  fireEvent.mouseDown(rail, { clientX: from, button: 0 });
  fireEvent.mouseMove(rail, { clientX: to });
  fireEvent.mouseUp(rail, { clientX: to });
  return rail;
}
it.each(["shortcut", "native command", "button"])(
  "cuts a waveform selection through the %s after editing the transcript",
  (route) => {
    render(<Harness />);
    const editor = (screen.getByRole("textbox") as HTMLElement & { editor: Editor }).editor;
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 12 });
      editor.view.focus();
    });
    expect(screen.getByRole("textbox")).toHaveFocus();
    const before = useProjectStore.getState().project;
    const rail = selectTimeline();
    expect(rail).toHaveFocus();
    expect(usePlayerStore.getState().timelineMarkIn).toBe(0);
    expect(usePlayerStore.getState().timelineMarkOut).toBe(1);
    act(() => usePlayerStore.getState().setPlaying(true));
    if (route === "shortcut") fireEvent.keyDown(rail, { key: "X", metaKey: true, shiftKey: true });
    else if (route === "native command") act(() => dispatchCommand("cut-speech"));
    else fireEvent.click(screen.getByRole("button", { name: "Cut selection" }));
    const after = useProjectStore.getState().project;
    expect(after).not.toBe(before);
    expect(totalDuration(after)).toBeLessThan(6);
    expect(after.segments.at(-1)).toEqual(before.segments.at(-1));
    expect(screen.queryByRole("dialog", { name: "Cut selected speech" })).toBeNull();
    expect(usePlayerStore.getState().timelineMarkIn).toBeNull();
    expect(usePlayerStore.getState().playing).toBe(false);
    expect(useUIStore.getState().toasts).toEqual([]);
    act(() => useProjectStore.temporal.getState().undo());
    expect(useProjectStore.getState().project).toBe(before);
  },
);
it("accepts I/O marks while the waveform has focus", () => {
  render(<Harness />);
  const rail = screen.getByLabelText("Timeline selection");
  act(() => {
    rail.focus();
    usePlayerStore.getState().setCurrentTime(0);
  });
  fireEvent.keyDown(rail, { key: "i" });
  act(() => usePlayerStore.getState().setCurrentTime(1));
  fireEvent.keyDown(rail, { key: "o" });
  fireEvent.keyDown(rail, { key: "X", metaKey: true, shiftKey: true });
  expect(totalDuration(useProjectStore.getState().project)).toBeLessThan(6);
});
it("keeps a rejected selection and reports the error instead of silently clearing it", () => {
  render(<Harness />);
  const before = useProjectStore.getState().project;
  const rail = selectTimeline(10, 50);
  fireEvent.keyDown(rail, { key: "X", metaKey: true, shiftKey: true });
  expect(useProjectStore.getState().project).toBe(before);
  expect(usePlayerStore.getState().timelineMarkIn).toBeCloseTo(0.1);
  expect(useUIStore.getState().toasts.at(-1)).toMatchObject({ title: "Cannot cut speech" });
  expect(useUIStore.getState().toasts.at(-1)!.description).toMatch(/corrected phrase/);
});
it("cuts ordinary wordless audio from the timeline and supports Undo", () => {
  const p = useProjectStore.getState().project;
  replaceProjectBaseline({
    ...p,
    segments: [
      p.segments[0]!,
      { id: "untranscribed", mediaId: "m1", sourceIn: 3, sourceOut: 4, words: [] },
      p.segments[1]!,
    ],
  });
  render(<Harness />);
  const before = useProjectStore.getState().project;
  act(() => usePlayerStore.getState().setTimelineRange(3.2, 3.6));
  fireEvent.click(screen.getByRole("button", { name: "Cut selection" }));
  const after = useProjectStore.getState().project;
  expect(totalDuration(before) - totalDuration(after)).toBeCloseTo(0.4);
  expect(after.segments.flatMap((s) => s.words)).toEqual(before.segments.flatMap((s) => s.words));
  expect(useUIStore.getState().toasts).toEqual([]);
  act(() => useProjectStore.temporal.getState().undo());
  expect(useProjectStore.getState().project).toBe(before);
});
it("adjusts markers by dragging, numeric input and arrow keys without editing the project", () => {
  render(<Harness />);
  const before = useProjectStore.getState().project;
  selectTimeline(100, 200);
  const out = screen.getByRole("slider", { name: "Out marker" });
  fireEvent.mouseDown(out, { clientX: 200, button: 0 });
  fireEvent.mouseMove(window, { clientX: 250 });
  fireEvent.mouseUp(window);
  expect(usePlayerStore.getState().timelineMarkIn).toBe(1);
  expect(usePlayerStore.getState().timelineMarkOut).toBe(2.5);
  fireEvent.keyDown(out, { key: "ArrowLeft", shiftKey: true });
  expect(usePlayerStore.getState().timelineMarkOut).toBeCloseTo(2.4);
  fireEvent.change(screen.getByRole("spinbutton", { name: "Timeline in time" }), {
    target: { value: "1.25" },
  });
  expect(usePlayerStore.getState().timelineMarkIn).toBe(1.25);
  const play = vi.fn();
  window.addEventListener("yusafcut:seek-output", play);
  fireEvent.click(screen.getByRole("button", { name: "Play selection" }));
  expect((play.mock.calls[0]![0] as CustomEvent).detail).toEqual({ time: 1.25, play: true });
  window.removeEventListener("yusafcut:seek-output", play);
  expect(useProjectStore.getState().project).toBe(before);
});
