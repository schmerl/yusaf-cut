import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  fireEvent.click(screen.getByRole("button", { name: "Script" }));
}
describe("real transcript script review controls", () => {
  it("lets form controls and details use Space/letters without global playback shortcuts", () => {
    open();
    const playback = vi.fn();
    window.addEventListener("yusafcut:toggle-play", playback);
    window.addEventListener("yusafcut:play", playback);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Reconciliation audio model" }), {
      key: "l",
    });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Reconciliation scope" }), { key: " " });
    fireEvent.keyDown(screen.getByRole("button", { name: "Reconcile script" }), { key: " " });
    fireEvent.keyDown(screen.getByText("Spoken script preview"), { key: " " });
    expect(playback).not.toHaveBeenCalled();
    window.removeEventListener("yusafcut:toggle-play", playback);
    window.removeEventListener("yusafcut:play", playback);
  });
  it("shows distinct model decorations and resolves a marker with Keep and Undo", () => {
    open();
    const before = useProjectStore.getState().project;
    expect(document.querySelector(".is-script-applied")).not.toBeNull();
    expect(document.querySelector(".is-script-pending")).not.toBeNull();
    expect(document.querySelector(".is-script-off-script")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep correction" }));
    expect(document.querySelector(".is-script-applied")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(useProjectStore.getState().project).toBe(before);
    expect(document.querySelector(".is-script-applied")).not.toBeNull();
  });
  it("navigation/listening does not resolve or dirty the project", () => {
    open();
    const p = useProjectStore.getState().project;
    fireEvent.click(screen.getByRole("button", { name: "Listen" }));
    expect(useFillerAuditionStore.getState().request).toMatchObject({
      expected: p,
      mode: "before",
      reviewLabel: "Script review playback",
    });
    fireEvent.click(screen.getByRole("button", { name: "Next item" }));
    expect(useProjectStore.getState().project).toBe(p);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(p.scriptAssistance!.records[0]!.status).toBe("applied");
  });
  it("accepts a pending correction into captions without changing duration or inserting review text", () => {
    open();
    const before = useProjectStore.getState().project;
    fireEvent.change(screen.getByRole("combobox", { name: "Script review filter" }), {
      target: { value: "Suggestions" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept suggestion" }));
    const after = useProjectStore.getState().project;
    expect(projectTranscript(after)[0]!.text).toBe("idempotency are not the server.");
    expect(totalDuration(after)).toBe(totalDuration(before));
    const captions = buildCues(after)
      .map((cue) => cue.text)
      .join(" ");
    expect(captions).toContain("server.");
    expect(captions).not.toMatch(/Pending|suggestion|synthetic-fixture/);
  });
  it("previews an off-script cut without editing and commits that same proposal with one undo", () => {
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Script review filter" }), {
      target: { value: "Off-script" },
    });
    const before = useProjectStore.getState().project;
    fireEvent.click(screen.getByRole("button", { name: "Preview cut" }));
    const audition = useFillerAuditionStore.getState().request!;
    expect(audition.mode).toBe("preview");
    expect(useProjectStore.getState().project).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Cut speech (audio/video)" }));
    expect(useProjectStore.getState().project).toBe(audition.timeline);
    expect(totalDuration(audition.timeline)).toBeLessThan(totalDuration(before));
    act(() => useProjectStore.temporal.getState().undo());
    expect(useProjectStore.getState().project).toBe(before);
  });
  it("rejects a stale cut preview after an unrelated project change until explicit refresh", () => {
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Script review filter" }), {
      target: { value: "Off-script" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview cut" }));
    act(() => useProjectStore.getState().rename("Changed while previewing"));
    const changed = useProjectStore.getState().project;
    fireEvent.click(screen.getByRole("button", { name: "Cut speech (audio/video)" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/project changed/);
    expect(useProjectStore.getState().project).toBe(changed);
    fireEvent.click(screen.getByRole("button", { name: "Refresh review" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview cut" }));
    const currentPreview = useFillerAuditionStore.getState().request!.timeline;
    fireEvent.click(screen.getByRole("button", { name: "Cut speech (audio/video)" }));
    expect(useProjectStore.getState().project).toBe(currentPreview);
  });
});
