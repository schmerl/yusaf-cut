import { fillerCandidates } from "@/lib/fillerReview";
import { buildFillerCutProposal, removeFillerText, replaceFillerText } from "@/lib/fillerActions";
import { buildOffScriptCut, scriptReviewAction } from "@/lib/scriptReviewActions";
import { locateScriptRecord } from "@/lib/scriptLifecycle";
import { estimateFillerBoundaries } from "@/lib/ipc";
import * as ipc from "@/lib/ipc";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
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
  vi.spyOn(ipc, "estimateFillerBoundaries").mockResolvedValue({
    start: null,
    end: null,
    reason: "Synthetic uncertain",
    limitedByNeighbor: false,
  });
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
  await act(async () => {});
});
afterEach(async () => {
  cleanup();
  useFillerAuditionStore.getState().stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await act(async () => {});
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
it("does not advance when a decision fails to commit", async () => {
  render(<TranscriptEditor />);
  clickMarker("first");
  vi.spyOn(useProjectStore.getState(), "commitTranscript").mockImplementation(() => {
    throw new Error("Simulated stale project");
  });
  fireEvent.click(popup().getByRole("button", { name: "Accept" }));
  expect(popup().getByText("bad")).toBeTruthy();
  expect(popup().getByRole("alert")).toHaveTextContent("stale project");
  await act(async () => {});
});
it.each(["Keep speech", "Cut speech"])("%s advances an off-script decision", async (action) => {
  const original = useProjectStore.getState().project;
  replaceProjectBaseline({
    ...original,
    scriptAssistance: {
      ...original.scriptAssistance!,
      records: original.scriptAssistance!.records.map((record) =>
        record.id === "first"
          ? { ...record, kind: "off-script", status: "off-script", afterText: record.beforeText }
          : record,
      ),
    },
  });
  render(<TranscriptEditor />);
  clickMarker("first");
  fireEvent.click(popup().getByRole("button", { name: action }));
  expect(popup().getByText("[UH]")).toBeTruthy();
  expect(popup().queryByRole("alert")).toBeNull();
  await waitFor(() => expect(popup().getByRole("button", { name: "Preview cut" })).toBeEnabled());
});
it.each(["Keep", "Revert"])("%s advances an applied correction", async (action) => {
  const original = useProjectStore.getState().project;
  const accepted = scriptReviewAction(original, "first", "accept");
  replaceProjectBaseline({
    ...accepted,
    scriptAssistance: {
      ...accepted.scriptAssistance!,
      records: accepted.scriptAssistance!.records.map((record) =>
        record.id === "first" ? { ...record, status: "applied" } : record,
      ),
    },
  });
  render(<TranscriptEditor />);
  clickMarker("first");
  fireEvent.click(popup().getByRole("button", { name: action }));
  expect(popup().getByText("[UH]")).toBeTruthy();
  expect(popup().queryByRole("alert")).toBeNull();
  await waitFor(() => expect(popup().getByRole("button", { name: "Preview cut" })).toBeEnabled());
});
it("Accept advances through fillers and preserves the adjacent unchanged suggestion; Dismiss advances too", async () => {
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
  await act(async () => {});
});
it("shows persisted decisions and reopens a dismissed item from the log", async () => {
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
  await act(async () => {});
});
it("reverts an unchanged accepted replacement without reverting an unrelated rename", async () => {
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
  await act(async () => {});
});
it("logs filler cuts in the same transaction and offers Undo latest decision", async () => {
  render(<TranscriptEditor />);
  const before = useProjectStore.getState().project;
  fireEvent.click(document.querySelector("[data-filler-id]")!);
  await waitFor(() => expect(popup().getByRole("button", { name: "Preview cut" })).toBeEnabled());
  fireEvent.click(popup().getByRole("button", { name: "Preview cut" }));
  const preview = useFillerAuditionStore.getState().request!.timeline;
  expect(useProjectStore.getState().project).toBe(before);
  fireEvent.click(popup().getByRole("button", { name: "Cut speech" }));
  expect(useProjectStore.getState().project).toBe(preview);
  const history = log();
  expect(history.getByRole("article", { name: "Cut speech: [UM]" })).toBeTruthy();
  fireEvent.click(history.getByRole("button", { name: "Undo latest decision" }));
  expect(useProjectStore.getState().project).toBe(before);
  await act(async () => {});
});

it("keeps independent script suggestions after cutting an earlier filler in the same paragraph", async () => {
  render(<TranscriptEditor />);
  const before = useProjectStore.getState().project;
  fireEvent.click(document.querySelector("[data-filler-id]")!);
  await waitFor(() => expect(popup().getByRole("button", { name: "Preview cut" })).toBeEnabled());
  expect(estimateFillerBoundaries).toHaveBeenCalledTimes(1);
  fireEvent.click(popup().getByRole("button", { name: "Cut speech" }));
  const after = useProjectStore.getState().project;
  for (const id of ["first", "second"]) {
    const old = before.scriptAssistance!.records.find((r) => r.id === id)!,
      record = after.scriptAssistance!.records.find((r) => r.id === id)!;
    expect(record.historicalReason).toBeUndefined();
    expect(record.anchorIds).toEqual(old.anchorIds);
    expect(record.evidence).toEqual(old.evidence);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[data-script-record]")).some(
        (el) => el.dataset.scriptRecord === id,
      ),
    ).toBe(true);
  }
  clickMarker("first");
  fireEvent.click(popup().getByRole("button", { name: "Accept" }));
  expect(
    projectTranscript(useProjectStore.getState().project)
      .map((b) => b.text)
      .join(" "),
  ).toContain("good");
  await act(async () => {});
});

it.each(["hide", "replace"])("keeps a neighboring suggestion after filler text %s", (mode) => {
  const before = useProjectStore.getState().project,
    filler = fillerCandidates(before)[0]!;
  const next =
    mode === "hide"
      ? removeFillerText(before, filler)
      : replaceFillerText(before, filler, "a pause");
  const record = next.scriptAssistance!.records.find((r) => r.id === "first")!;
  expect(record.historicalReason).toBeUndefined();
  expect(locateScriptRecord(next, record)).not.toBeNull();
});
it("preserves an independent later suggestion after an off-script cut", () => {
  const original = useProjectStore.getState().project;
  const before = {
    ...original,
    scriptAssistance: {
      ...original.scriptAssistance!,
      records: original.scriptAssistance!.records.map((r) =>
        r.id === "first"
          ? {
              ...r,
              kind: "off-script" as const,
              status: "off-script" as const,
              afterText: r.beforeText,
            }
          : r,
      ),
    },
  };
  const next = buildOffScriptCut(before, "first").result;
  const record = next.scriptAssistance!.records.find((r) => r.id === "second")!;
  expect(record.historicalReason).toBeUndefined();
  expect(locateScriptRecord(next, record)).not.toBeNull();
});
it("does not revive a script record whose target was removed by the filler cut", () => {
  const original = useProjectStore.getState().project,
    filler = fillerCandidates(original)[0]!;
  const b = projectTranscript(original)[0]!,
    template = original.scriptAssistance!.records[0]!;
  const overlap = {
    ...template,
    id: "removed-target",
    beforeText: filler.text,
    afterText: "now",
    anchorIds: filler.anchorIds,
    sourceIn: filler.sourceStart,
    sourceOut: filler.sourceEnd,
    contextBefore: b.text.slice(Math.max(0, filler.from - 48), filler.from),
    contextAfter: b.text.slice(filler.to, filler.to + 48),
  };
  const before = {
    ...original,
    scriptAssistance: {
      ...original.scriptAssistance!,
      records: [...original.scriptAssistance!.records, overlap],
    },
  };
  const next = buildFillerCutProposal(before, filler, { startMs: 0, endMs: 0 }).result;
  expect(
    next.scriptAssistance!.records.find((r) => r.id === "removed-target")!.historicalReason,
  ).toBeTruthy();
});
