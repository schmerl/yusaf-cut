import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { projectTranscript } from "@/lib/transcript";
import { totalDuration, type Project } from "@/lib/edl";
import fixture from "./fixtures/transcript-corrections.json";

function Harness() {
  useKeyboardShortcuts();
  return <TranscriptEditor />;
}
function editor(): Editor {
  return (screen.getByRole("textbox") as HTMLElement & { editor: Editor }).editor;
}
const text = () => projectTranscript(useProjectStore.getState().project)[0]!.text;
beforeEach(() => {
  replaceProjectBaseline(globalThis.structuredClone(fixture) as Project);
  usePlayerStore.getState().reset();
});
afterEach(cleanup);

describe("editable transcript with real ProseMirror transactions", () => {
  it("is editable by default and commits typing without losing the caret or cutting audio", async () => {
    render(<Harness />);
    expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("true");
    const e = editor();
    act(() => {
      e.commands.setTextSelection(1);
      e.view.dispatch(e.state.tr.insertText("REST "));
    });
    await waitFor(() => expect(text()).toBe("REST idempotency are not the serveur."));
    expect(e.state.selection.from).toBe(6);
    expect(totalDuration(useProjectStore.getState().project)).toBe(6);
    const selection = e.state.selection.from;
    act(() => useProjectStore.getState().markSaved("/tmp/test.scribe"));
    expect(e.state.selection.from).toBe(selection);
  });
  it("rejects clearing a spoken paragraph, including text cut, and keeps the valid project", () => {
    render(<Harness />);
    const e = editor(),
      before = useProjectStore.getState().project;
    act(() => e.view.dispatch(e.state.tr.delete(1, 1 + text().length)));
    expect(useProjectStore.getState().project).toBe(before);
    expect(screen.getByRole("alert").textContent).toMatch(/retain text/);
    expect(e.state.doc.firstChild!.textContent).toBe(text());
  });
  it("paste uses only plain text and does not accept executable markup or node attributes", () => {
    render(<Harness />);
    const e = editor();
    act(() => e.commands.setTextSelection(1));
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        getData: (format: string) =>
          format === "text/plain" ? "POST\nAPI " : '<img src=x onerror="alert(1)">',
      },
    });
    expect(text().startsWith("POST API ")).toBe(true);
    expect(screen.getByRole("textbox").querySelector("img")).toBeNull();
  });
  it("Cmd-click seeks the corrected group without toggling playback; ordinary clicks do not seek", () => {
    render(<Harness />);
    const listener = vi.fn();
    window.addEventListener("yusafcut:seek-output", listener);
    const word = screen.getByRole("textbox").querySelector<HTMLElement>("[data-run-id=r1]")!;
    fireEvent.click(word);
    expect(listener).not.toHaveBeenCalled();
    fireEvent.click(word, { metaKey: true });
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({ time: 0, play: false });
    window.removeEventListener("yusafcut:seek-output", listener);
  });
  it("Delete is text-only while partial Cut speech is rejected and whole-group cut is undoable", () => {
    render(<Harness />);
    const e = editor();
    act(() => e.commands.setTextSelection({ from: 1, to: 5 }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "x", metaKey: true, shiftKey: true });
    expect(totalDuration(useProjectStore.getState().project)).toBe(6);
    expect(screen.getByRole("alert").textContent).toMatch(/whole/);
    act(() => e.commands.setTextSelection({ from: 1, to: 12 }));
    fireEvent.click(screen.getByRole("button", { name: /Cut speech/ }));
    expect(totalDuration(useProjectStore.getState().project)).toBeLessThan(6);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(totalDuration(useProjectStore.getState().project)).toBe(6);
    expect(editor().state.doc.firstChild!.textContent).toBe(text());
  });
  it("typing keys never invoke global playback/cut actions", () => {
    render(<Harness />);
    const toggle = vi.fn();
    window.addEventListener("yusafcut:toggle-play", toggle);
    const before = useProjectStore.getState().project;
    for (const key of [" ", "j", "k", "l", "i", "o", "b", "x", "Delete", "Backspace"]) {
      fireEvent.keyDown(screen.getByRole("textbox"), { key });
    }
    expect(toggle).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project).toBe(before);
    window.removeEventListener("yusafcut:toggle-play", toggle);
  });
  it("composition drafts do not enter the saved project until composition ends", async () => {
    render(<Harness />);
    const e = editor();
    const before = useProjectStore.getState().project;
    fireEvent.compositionStart(screen.getByRole("textbox"));
    act(() => e.view.dispatch(e.state.tr.insertText("語", 1)));
    expect(useProjectStore.getState().project).toBe(before);
    fireEvent.compositionEnd(screen.getByRole("textbox"));
    await waitFor(() => expect(text().startsWith("語")).toBe(true));
    expect(totalDuration(useProjectStore.getState().project)).toBe(6);
  });
  it("splits at a timing boundary, moves the caret to the new paragraph and joins with Backspace", async () => {
    render(<Harness />);
    const e = editor();
    act(() => e.commands.setTextSelection(12));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() =>
      expect(projectTranscript(useProjectStore.getState().project)).toHaveLength(3),
    );
    expect(editor().state.selection.$from.parentOffset).toBe(0);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Backspace" });
    await waitFor(() =>
      expect(projectTranscript(useProjectStore.getState().project)).toHaveLength(2),
    );
    expect(editor().state.selection.$from.parentOffset).toBe(11);
  });
  it("does not commit an invalid IME draft and recovers after an external project switch", async () => {
    render(<Harness />);
    const e = editor();
    const old = text();
    fireEvent.compositionStart(screen.getByRole("textbox"));
    act(() => e.view.dispatch(e.state.tr.delete(1, 1 + old.length)));
    fireEvent.compositionEnd(screen.getByRole("textbox"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/retain text/));
    expect(editor().state.doc.firstChild!.textContent).toBe(old);
    fireEvent.compositionStart(screen.getByRole("textbox"));
    act(() => e.view.dispatch(e.state.tr.insertText("draft", 1)));
    const next = globalThis.structuredClone(fixture) as Project;
    next.id = "another";
    act(() => replaceProjectBaseline(next));
    fireEvent.compositionEnd(screen.getByRole("textbox"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/project changed/));
    expect(useProjectStore.getState().project.id).toBe("another");
    expect(editor().state.doc.firstChild!.textContent).toBe(old);
  });
  it("undo and redo synchronize the editor, not just the store", async () => {
    render(<Harness />);
    const e = editor();
    const old = text();
    act(() => e.view.dispatch(e.state.tr.insertText("REST ", 1)));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", metaKey: true });
    await waitFor(() => expect(editor().state.doc.firstChild!.textContent).toBe(old));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "z", metaKey: true, shiftKey: true });
    await waitFor(() => expect(editor().state.doc.firstChild!.textContent).toBe(`REST ${old}`));
  });
});

it("paragraph timestamp and highlighting identify output occurrences, not shared source-word IDs", () => {
  render(<Harness />);
  act(() => usePlayerStore.getState().setCurrentTime(3.2));
  const box = screen.getByRole("textbox");
  const playing = box.querySelectorAll(".is-playing");
  expect(playing).toHaveLength(1);
  expect(playing[0]!.textContent).toBe("item");
  act(() => usePlayerStore.getState().setTimelineRange(0, 1));
  expect(box.querySelectorAll(".is-selected")).toHaveLength(1);
  expect(box.querySelector(".is-selected")!.textContent).toBe("idempotency");
  const seek = vi.fn();
  window.addEventListener("yusafcut:seek-output", seek);
  fireEvent.click(screen.getAllByRole("button", { name: "Seek to paragraph" })[1]!);
  expect((seek.mock.calls[0]![0] as CustomEvent).detail.time).toBe(3);
  window.removeEventListener("yusafcut:seek-output", seek);
});

it("a selection across paragraphs cannot bypass the nonempty rule through automatic joining", () => {
  render(<Harness />);
  const e = editor();
  const before = useProjectStore.getState().project;
  act(() => e.commands.setTextSelection({ from: 1, to: 3 + text().length }));
  act(() => e.commands.insertContent("replacement"));
  expect(useProjectStore.getState().project).toBe(before);
  expect(screen.getByRole("alert").textContent).toMatch(/one paragraph/);
});

it("ordinary editor deleteSelection removes text rather than source audio", () => {
  render(<Harness />);
  const e = editor();
  act(() => e.commands.setTextSelection({ from: 1, to: 5 }));
  act(() => e.commands.deleteSelection());
  expect(text()).toBe("potency are not the serveur.");
  expect(totalDuration(useProjectStore.getState().project)).toBe(6);
});
