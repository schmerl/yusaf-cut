import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Editor } from "@tiptap/core";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { projectTranscript } from "@/lib/transcript";
import { editBlockText } from "@/lib/transcriptEdits";
import { totalDuration, type Project } from "@/lib/edl";
import fixture from "./fixtures/transcript-corrections.json";
const text = () => projectTranscript(useProjectStore.getState().project)[0]!.text;
const editor = () =>
  (screen.getByRole("textbox", { name: "Editable transcript" }) as HTMLElement & { editor: Editor })
    .editor;
const search = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText("Find in transcript"), { target: { value } });
const replacement = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText("Replace with…"), { target: { value } });
beforeEach(() => replaceProjectBaseline(structuredClone(fixture) as Project));
afterEach(cleanup);

it("navigates contextual matches, replaces current only, and keeps counts/highlights live through undo", () => {
  const p = useProjectStore.getState().project;
  replaceProjectBaseline(editBlockText(p, "s1", "block-1", "post POST post."));
  render(<TranscriptEditor findOpen />);
  search("post");
  replacement("PUT");
  expect(screen.getByText("1 / 3")).toBeTruthy();
  expect(document.querySelectorAll(".is-match")).toHaveLength(3);
  fireEvent.click(screen.getByTitle("Next (Enter)"));
  expect(document.querySelector(".is-current-match")!.textContent).toBe("POST");
  fireEvent.click(screen.getByRole("button", { name: "Replace current" }));
  expect(text()).toBe("post PUT post.");
  expect(screen.getByText("2 / 2")).toBeTruthy();
  expect(totalDuration(useProjectStore.getState().project)).toBe(6);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(text()).toBe("post POST post.");
  expect(screen.getByText("2 / 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
  expect(text()).toBe("PUT PUT PUT.");
  expect(screen.getByText("0 / 0")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(text()).toBe("post POST post.");
});

it("highlights phrases across timing groups and clears decorations on closing search", () => {
  const view = render(<TranscriptEditor findOpen />);
  search("idempotency are not");
  expect(screen.getByText("1 / 1")).toBeTruthy();
  expect(
    Array.from(document.querySelectorAll(".is-current-match"))
      .map((e) => e.textContent)
      .join(""),
  ).toBe("idempotency are not");
  view.rerender(<TranscriptEditor />);
  expect(document.querySelector(".is-match")).toBeNull();
});

it("restores only the inspected groups, supports paragraph hidden-word recovery and one-step undo", () => {
  render(<TranscriptEditor />);
  act(() => editor().commands.setTextSelection({ from: 3, to: 5 }));
  fireEvent.click(screen.getByRole("button", { name: "View original selection" }));
  expect(screen.getByText("item potency")).toBeTruthy();
  expect(screen.getByText(/Includes the whole corrected timing group/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restore original text" }));
  expect(text()).toBe("item potency are not the serveur.");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(text()).toBe("idempotency are not the serveur.");
  act(() => editor().commands.setTextSelection(1));
  fireEvent.click(screen.getByRole("button", { name: "View paragraph original" }));
  fireEvent.click(screen.getByRole("button", { name: "Restore original text" }));
  expect(text()).toBe("item potency aren’t the old server.");
  expect(totalDuration(useProjectStore.getState().project)).toBe(6);
});

it("invalidates inspected ranges after editing or switching projects", () => {
  render(<TranscriptEditor />);
  fireEvent.click(screen.getByRole("button", { name: "View paragraph original" }));
  act(() => editor().view.dispatch(editor().state.tr.insertText("NEW ", 1)));
  expect(screen.queryByRole("button", { name: "Restore original text" })).toBeNull();
  expect(screen.getByText(/transcript changed/)).toBeTruthy();
  act(() => replaceProjectBaseline(structuredClone(fixture) as Project));
  expect(screen.queryByRole("button", { name: "Restore original text" })).toBeNull();
});

it("applies search options, previous navigation, and rejects an invalid Replace all atomically", () => {
  const p = useProjectStore.getState().project;
  replaceProjectBaseline(editBlockText(p, "s1", "block-1", "post POST posting"));
  render(<TranscriptEditor findOpen />);
  search("post");
  fireEvent.click(screen.getByRole("checkbox", { name: "Whole word" }));
  fireEvent.click(screen.getByTitle("Previous (Shift+Enter)"));
  expect(screen.getByText("2 / 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Case sensitive" }));
  expect(screen.getByText("1 / 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: "Whole word" }));
  expect(screen.getByText("1 / 2")).toBeTruthy();
  search("post POST posting");
  replacement("");
  const before = useProjectStore.getState().project;
  fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
  expect(useProjectStore.getState().project).toBe(before);
  expect(text()).toBe("post POST posting");
});

it("keeps editor focus while searching and editing with the panel open", () => {
  render(<TranscriptEditor findOpen />);
  search("idempotency");
  const e = editor();
  act(() => {
    e.view.focus();
    e.commands.setTextSelection(1);
  });
  expect(document.activeElement).toBe(e.view.dom);
  act(() => e.view.dispatch(e.state.tr.insertText("new ", 1)));
  expect(document.activeElement).toBe(e.view.dom);
  expect(screen.getByText("1 / 1")).toBeTruthy();
});

it("defaults to partial matching, shades the whole token and replaces only the exact substring", () => {
  const p = useProjectStore.getState().project;
  replaceProjectBaseline(
    editBlockText(
      editBlockText(p, "s1", "block-1", "POST posting."),
      "s2",
      "transcript:s2:block:0",
      "other speech.",
    ),
  );
  render(<TranscriptEditor findOpen />);
  search("po");
  expect(screen.getByText("1 / 2")).toBeTruthy();
  expect(document.querySelector(".is-current-match")!.textContent).toBe("PO");
  const contextText = Array.from(document.querySelectorAll(".is-match-context"))
    .map((e) => e.textContent)
    .join("");
  expect(contextText).toBe("POSTposting");
  expect(document.querySelector(".is-current-match")!.textContent).not.toContain("ST");
  replacement("RE");
  fireEvent.click(screen.getByRole("button", { name: "Replace current" }));
  expect(text()).toBe("REST posting.");
  fireEvent.click(screen.getByRole("checkbox", { name: "Whole word" }));
  expect(screen.getByText("0 / 0")).toBeTruthy();
  expect(document.querySelector(".is-match-context")).toBeNull();
});
