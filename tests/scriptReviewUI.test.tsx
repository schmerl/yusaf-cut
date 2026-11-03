import type { Editor } from "@tiptap/core";
import { dispatchCommand } from "@/lib/appCommands";
import * as workflow from "@/lib/scriptWorkflow";
import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
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
  vi.restoreAllMocks();
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
  it.each(["toolbar", "native menu"])(
    "retains a blurred passage for %s even if WebKit collapses the live selection",
    async (route) => {
      const run = vi
        .spyOn(workflow, "runScriptReconciliation")
        .mockResolvedValue({ applied: 0, pending: 1, offScript: 0, unsupported: 0 });
      open();
      const dom = screen.getByRole("textbox", { name: "Editable transcript" }) as HTMLElement & {
        editor: Editor;
      };
      act(() => dom.editor.commands.setTextSelection({ from: 2, to: 8 }));
      const check = screen.getByRole("button", { name: "Check selection" });
      fireEvent.mouseDown(check);
      fireEvent.blur(dom);
      act(() => dom.editor.commands.setTextSelection(1));
      expect(screen.getByRole("button", { name: "Check selection" })).toBeEnabled();
      expect(document.querySelector(".is-passage-selected")?.textContent).toBe(
        projectTranscript(useProjectStore.getState().project)[0]!.text.slice(1, 7),
      );
      if (route === "toolbar") fireEvent.click(check);
      else act(() => dispatchCommand("review-selected"));
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(run.mock.calls[0]![1]).toEqual([
        { segmentId: "s1", blockId: "block-1", from: 1, to: 7 },
      ]);
    },
  );
  it("returns whole/selected analysis to the combined chain including fillers", async () => {
    vi.spyOn(workflow, "runScriptReconciliation").mockResolvedValue({
      applied: 0,
      pending: 0,
      offScript: 0,
      unsupported: 0,
    });
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Review category" }), {
      target: { value: "script" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find differences" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Review category" })).toHaveValue("all"),
    );
  });
  it("offers editable wording and an explanation when no replacement was inferred", () => {
    const p = structuredClone(fixture) as Project;
    const record = p.scriptAssistance!.records.find((r) => r.id === "pending-example")!;
    record.afterText = record.beforeText;
    record.kind = "uncertain";
    replaceProjectBaseline(p);
    open();
    const popover = marker(".is-script-pending");
    expect(popover.getByText("Needs review")).toBeTruthy();
    expect(popover.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(popover.getByText(/No replacement was inferred/)).toBeTruthy();
    fireEvent.click(popover.getByText("Edit text"));
    fireEvent.change(popover.getByRole("textbox", { name: "Your replacement" }), {
      target: { value: "service." },
    });
    fireEvent.click(popover.getByRole("button", { name: "Save text" }));
    expect(projectTranscript(useProjectStore.getState().project)[0]!.text).toContain("service.");
  });
  it("adjusts off-script cut buffers in the popover and shares the adjusted preview with commit", () => {
    open();
    const popover = marker(".is-script-off-script");
    fireEvent.click(popover.getByText("Adjust cut"));
    fireEvent.change(popover.getByRole("spinbutton", { name: "Cut buffer before" }), {
      target: { value: "100" },
    });
    fireEvent.click(popover.getByRole("button", { name: "Preview cut" }));
    const preview = useFillerAuditionStore.getState().request!.timeline;
    expect(popover.getByLabelText("Proposed cut duration")).toHaveTextContent("0.400 seconds");
    expect(popover.getByLabelText("Retained following text")).toHaveTextContent("serveur.");
    fireEvent.click(popover.getByRole("button", { name: "Cut speech" }));
    expect(useProjectStore.getState().project).toBe(preview);
    expect(
      projectTranscript(preview)
        .map((b) => b.text)
        .join(" "),
    ).toContain("serveur.");
  });
  it("keeps a saved passage through metadata changes but clears it for a new project session", () => {
    open();
    const dom = screen.getByRole("textbox", { name: "Editable transcript" }) as HTMLElement & {
      editor: Editor;
    };
    act(() => dom.editor.commands.setTextSelection({ from: 2, to: 8 }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Check selection" }));
    fireEvent.blur(dom);
    act(() => dom.editor.commands.setTextSelection(1));
    act(() => useProjectStore.getState().rename("Metadata change"));
    expect(screen.getByRole("button", { name: "Check selection" })).toBeEnabled();
    // Exercise document capture; jsdom has no geometry for ProseMirror's later
    // caret hit-test, which is independent of the retained-scope behavior.
    dom.addEventListener("mousedown", (event) => event.stopImmediatePropagation(), {
      capture: true,
      once: true,
    });
    fireEvent.mouseDown(dom);
    expect(screen.queryByRole("button", { name: "Check selection" })).toBeNull();
    act(() => dom.editor.commands.setTextSelection({ from: 2, to: 8 }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Check selection" }));
    act(() => replaceProjectBaseline(useProjectStore.getState().project));
    expect(screen.queryByRole("button", { name: "Check selection" })).toBeNull();
    expect(document.querySelector(".is-passage-selected")).toBeNull();
  });
  it("explains missing script setup instead of silently disabling selection review", () => {
    const p = structuredClone(fixture) as Project;
    delete p.scriptAssistance;
    replaceProjectBaseline(p);
    open();
    const dom = screen.getByRole("textbox", { name: "Editable transcript" }) as HTMLElement & {
      editor: Editor;
    };
    act(() => dom.editor.commands.setTextSelection({ from: 2, to: 8 }));
    const command = vi.fn();
    window.addEventListener("yusafcut:command", command);
    fireEvent.click(screen.getByRole("button", { name: "Add script to check selection…" }));
    expect(command.mock.calls[0]![0].detail).toBe("script");
    expect(screen.getByRole("status")).toHaveTextContent(/selection is retained/);
    window.removeEventListener("yusafcut:command", command);
  });
  it("labels the marked phrase with its actual before → replacement context", () => {
    open();
    const marker = document.querySelector<HTMLElement>(".is-script-pending")!;
    expect(marker.title).toBe("serveur. → server.");
    expect(marker.getAttribute("aria-label")).toBe(marker.title);
    fireEvent.click(marker);
    expect(screen.getByRole("dialog", { name: "Review suggestion" })).toHaveTextContent(
      /serveur.*server/s,
    );
  });
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
    marker(".is-script-off-script");
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
