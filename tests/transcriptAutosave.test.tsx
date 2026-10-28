import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import fixture from "./fixtures/transcript-corrections.json";
import type { Project } from "@/lib/edl";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { useAutoSave } from "@/hooks/useAutoSave";
import { saveProject } from "@/lib/ipc";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { projectTranscript } from "@/lib/transcript";
vi.mock("@/lib/ipc", () => ({ saveProject: vi.fn() }));
function Harness() {
  useAutoSave();
  return <TranscriptEditor />;
}
const editor = () => (screen.getByRole("textbox") as HTMLElement & { editor: Editor }).editor;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(saveProject).mockResolvedValue();
  replaceProjectBaseline(globalThis.structuredClone(fixture) as Project, {
    filePath: "/tmp/test.scribe",
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("autosaves the validated correction without resetting the editor caret", async () => {
  render(<Harness />);
  const e = editor();
  act(() => e.view.dispatch(e.state.tr.insertText("REST ", 1)));
  const valid = useProjectStore.getState().project,
    caret = e.state.selection.from;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(saveProject).toHaveBeenCalledWith(valid, "/tmp/test.scribe");
  expect(useProjectStore.getState().dirty).toBe(false);
  expect(e.state.selection.from).toBe(caret);
});
it("autosave during an invalid composition writes only the previous valid revision", async () => {
  render(<Harness />);
  const e = editor();
  act(() => useProjectStore.getState().rename("a valid edit"));
  const valid = useProjectStore.getState().project;
  fireEvent.compositionStart(screen.getByRole("textbox"));
  act(() => e.view.dispatch(e.state.tr.delete(1, 1 + projectTranscript(valid)[0]!.text.length)));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(saveProject).toHaveBeenCalledWith(valid, "/tmp/test.scribe");
  expect(projectTranscript(vi.mocked(saveProject).mock.calls[0]![0])[0]!.text).not.toBe("");
  fireEvent.compositionEnd(screen.getByRole("textbox"));
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  expect(e.state.doc.firstChild!.textContent).toBe(projectTranscript(valid)[0]!.text);
});
