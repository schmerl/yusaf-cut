import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { addMediaWithTranscript, newProject, totalDuration } from "@/lib/edl";
import {
  prepareScript,
  replaceStoredScript,
  type ScriptReviewRecord,
} from "@/lib/scriptAssistance";
import { projectTranscript, normalizeProjectTranscripts } from "@/lib/transcript";
import { dispatchCommand } from "@/lib/appCommands";
import { useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { useUIStore } from "@/stores/uiStore";
import fixture from "./fixtures/script-assistance.json";
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const media = { ...fixture.media.m1, duration: 30 };
  let p = replaceStoredScript(
    normalizeProjectTranscripts(
      addMediaWithTranscript(
        newProject("Review chain"),
        media,
        "Alpha [UM] bad [UH] wrong finish.".split(" ").map((text, i) => ({
          id: `word-${i}`,
          text,
          start: 1 + i * 0.5,
          end: 1.3 + i * 0.5,
          confidence: 1,
        })),
      ),
    ),
    await prepareScript("Alpha good correct finish.", "synthetic.md"),
  );
  const b = projectTranscript(p)[0]!,
    script = p.scriptAssistance!.scripts[0]!;
  const record = (word: string, afterText: string, id: string): ScriptReviewRecord => {
    const run = b.runs.find((r) => r.text === word)!;
    return {
      id,
      policy: "synthetic-chain",
      scriptRevision: script.revision,
      mediaId: b.mediaId,
      occurrenceLineage: p.segments[0]!.transcript!.occurrenceId,
      anchorIds: run.anchorIds,
      beforeText: word,
      afterText,
      contextBefore: b.text.slice(Math.max(0, run.from - 48), run.from),
      contextAfter: b.text.slice(run.to, run.to + 48),
      sourceIn: run.sourceStart,
      sourceOut: run.sourceEnd,
      scriptFrom: 0,
      scriptTo: script.markdown.length,
      kind: "wording",
      status: "suggested",
      reason: "Synthetic review test",
      evidence: { engine: "synthetic", model: "none", policy: "synthetic", unprompted: "" },
    };
  };
  p = {
    ...p,
    scriptAssistance: {
      ...p.scriptAssistance!,
      records: [record("bad", "good", "first"), record("wrong", "correct", "second")],
    },
  };
  replaceProjectBaseline(p);
  useUIStore.getState().setFillerReviewOpen(false);
});
afterEach(() => {
  cleanup();
  useFillerAuditionStore.getState().stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const popup = () => within(screen.getByRole("dialog", { name: "Review suggestion" }));
function clickMarker(id: string) {
  fireEvent.click(
    Array.from(document.querySelectorAll<HTMLElement>("[data-script-record]")).find(
      (el) => el.dataset.scriptRecord === id,
    )!,
  );
}
function log() {
  act(() => dispatchCommand("review-log"));
  return within(screen.getByRole("dialog", { name: "Review log" }));
}
it("does not advance when a decision fails to commit", () => {
  render(<TranscriptEditor />);
  clickMarker("first");
  vi.spyOn(useProjectStore.getState(), "commitTranscript").mockImplementation(() => {
    throw new Error("Simulated stale project");
  });
  fireEvent.click(popup().getByRole("button", { name: "Accept" }));
  expect(popup().getByText("bad")).toBeTruthy();
  expect(popup().getByRole("alert")).toHaveTextContent("stale project");
});
it("Accept advances through fillers and preserves the adjacent unchanged suggestion; Dismiss advances too", () => {
  render(<TranscriptEditor />);
  clickMarker("first");
  fireEvent.click(popup().getByRole("button", { name: "Accept" }));
  expect(popup().getByText("Filler")).toBeTruthy();
  expect(popup().getByText("[UH]")).toBeTruthy();
  expect(
    useProjectStore.getState().project.scriptAssistance!.records.find((r) => r.id === "second")!
      .historicalReason,
  ).toBeUndefined();
  fireEvent.click(popup().getByRole("button", { name: "Next" }));
  expect(popup().getByText("wrong")).toBeTruthy();
  fireEvent.click(popup().getByRole("button", { name: "Dismiss" }));
  expect(popup().getByText("[UM]")).toBeTruthy();
  expect(useProjectStore.getState().project.reviewLog!.entries.map((e) => e.action)).toEqual([
    "accept",
    "dismiss",
  ]);
});
it("shows persisted decisions and reopens a dismissed item from the log", () => {
  render(<TranscriptEditor />);
  clickMarker("second");
  fireEvent.click(popup().getByRole("button", { name: "Dismiss" }));
  const saved = structuredClone(useProjectStore.getState().project);
  act(() => replaceProjectBaseline(saved));
  const history = log();
  expect(history.queryByRole("button", { name: "Undo latest decision" })).toBeNull();
  const row = within(history.getByRole("article", { name: "Dismissed: wrong" }));
  fireEvent.click(row.getByRole("button", { name: "Review again" }));
  expect(popup().getByText("wrong")).toBeTruthy();
  expect(popup().getByRole("button", { name: "Accept" })).toBeEnabled();
});
it("reverts an unchanged accepted replacement without reverting an unrelated rename", () => {
  render(<TranscriptEditor />);
  clickMarker("first");
  const duration = totalDuration(useProjectStore.getState().project);
  fireEvent.click(popup().getByRole("button", { name: "Accept" }));
  act(() => useProjectStore.getState().rename("Keep this rename"));
  const history = log(),
    row = within(history.getByRole("article", { name: "Accepted: bad" }));
  fireEvent.click(row.getByRole("button", { name: "Revert text" }));
  const p = useProjectStore.getState().project;
  expect(projectTranscript(p)[0]!.text).toContain("bad");
  expect(p.name).toBe("Keep this rename");
  expect(totalDuration(p)).toBe(duration);
});
it("logs filler cuts in the same transaction and offers Undo latest decision", () => {
  render(<TranscriptEditor />);
  const before = useProjectStore.getState().project;
  fireEvent.click(document.querySelector("[data-filler-id]")!);
  fireEvent.click(popup().getByRole("button", { name: "Preview cut" }));
  const preview = useFillerAuditionStore.getState().request!.timeline;
  expect(useProjectStore.getState().project).toBe(before);
  fireEvent.click(popup().getByRole("button", { name: "Cut speech" }));
  expect(useProjectStore.getState().project).toBe(preview);
  const history = log();
  expect(history.getByRole("article", { name: "Cut speech: [UM]" })).toBeTruthy();
  fireEvent.click(history.getByRole("button", { name: "Undo latest decision" }));
  expect(useProjectStore.getState().project).toBe(before);
});
