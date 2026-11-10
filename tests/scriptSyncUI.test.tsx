import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScriptSyncPanel } from "@/components/TranscriptEditor/ScriptSyncPanel";
import { ScriptPanel } from "@/components/TranscriptEditor/ScriptPanel";
import { addMediaWithTranscript, newProject, computeTimeline } from "@/lib/edl";
import { prepareScript, replaceStoredScript } from "@/lib/scriptAssistance";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { projectTranscript } from "@/lib/transcript";
import { usePlayerStore } from "@/stores/playerStore";
import { scriptSections, setScriptSync } from "@/lib/scriptSync";
import { cutTranscriptRanges } from "@/lib/transcriptEdits";
import fixture from "./fixtures/transcript-corrections.json";

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  usePlayerStore.getState().reset();
  const p = addMediaWithTranscript(
    newProject("Sync UI"),
    fixture.media.m1,
    "Alpha bravo charly delta. Later words here.".split(" ").map((text, i) => ({
      id: `word-${i}`,
      text,
      start: i * 0.2,
      end: i * 0.2 + 0.18,
      confidence: 1,
    })),
  );
  replaceProjectBaseline(
    replaceStoredScript(
      p,
      await prepareScript(
        "## One\n\nAlpha bravo Charlie delta.\n\n## Two\n\nAlpha bravo cherry delta.\n\nLater words here.",
        "script.md",
      ),
    ),
  );
});
afterEach(() => {
  cleanup();
  useFillerAuditionStore.getState().stop();
  vi.unstubAllGlobals();
});

it("opens a side-by-side helper from script management and links without changing text or audio", () => {
  render(<ScriptPanel onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Sync transcript…" }));
  expect(screen.getByRole("region", { name: "Sync script and transcript" })).toBeTruthy();
  const before = useProjectStore.getState().project;
  fireEvent.click(within(screen.getByLabelText("Script sections")).getAllByRole("button")[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Link selected paragraphs to slide" }));
  const next = useProjectStore.getState().project;
  expect(next.scriptAssistance!.syncLinks).toHaveLength(1);
  expect(next.segments).toBe(before.segments);
  expect(computeTimeline(next)).toEqual(computeTimeline(before));
  act(() => useProjectStore.temporal.getState().undo());
  expect(useProjectStore.getState().project).toBe(before);
});

it("links a chosen script section, checks only the selected transcript and leaves decisions pending", async () => {
  render(<ScriptSyncPanel />);
  fireEvent.click(within(screen.getByLabelText("Script sections")).getAllByRole("button")[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Link and find differences" }));
  await screen.findByText(/Linked and checked:/);
  const p = useProjectStore.getState().project;
  expect(
    p.scriptAssistance!.records.some((r) => r.afterText === "Charlie" && r.status === "suggested"),
  ).toBe(true);
  expect(projectTranscript(p)[0]!.text).toBe("Alpha bravo charly delta.");
  fireEvent.click(screen.getByRole("button", { name: "Remove link" }));
  expect(useProjectStore.getState().project.scriptAssistance!.syncLinks).toEqual([]);
  expect(
    useProjectStore
      .getState()
      .project.scriptAssistance!.records.every(
        (r) => r.status !== "suggested" || !!r.historicalReason,
      ),
  ).toBe(true);
});

it("supports passage playback, range selection and reports stale links after audio removal", () => {
  render(<ScriptSyncPanel />);
  const before = useProjectStore.getState().project;
  fireEvent.click(screen.getByRole("button", { name: "Play selected passage" }));
  expect(useFillerAuditionStore.getState().request).toMatchObject({
    expected: before,
    mode: "before",
    start: 0,
    end: 0.78,
  });
  const choices = within(screen.getByLabelText("Transcript paragraphs")).getAllByRole("button");
  fireEvent.click(choices[1]!, { shiftKey: true });
  expect(choices[0]).toHaveAttribute("aria-pressed", "true");
  expect(choices[1]).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(screen.getByLabelText("Script sections")).getAllByRole("button")[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Link selected paragraphs to slide" }));
  const p = useProjectStore.getState().project,
    b = projectTranscript(p)[0]!,
    word = b.runs[1]!;
  act(() =>
    useProjectStore
      .getState()
      .commitTranscript(
        cutTranscriptRanges(p, [
          { segmentId: b.segmentId, blockId: b.id, from: word.from, to: word.to },
        ]),
        p,
      ),
  );
  expect(screen.getByText(/Passage changed — relink/)).toBeTruthy();
});
it("starts near the playhead and searches either side without changing the selected paragraph identities", () => {
  usePlayerStore.getState().setCurrentTime(1);
  render(<ScriptSyncPanel />);
  const p = useProjectStore.getState().project;
  const b = projectTranscript(p)[1]!;
  expect(screen.getByRole("combobox", { name: "Transcript range start" })).toHaveValue(
    JSON.stringify([b.segmentId, b.id]),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Search transcript paragraphs" }), {
    target: { value: "Later" },
  });
  expect(
    within(screen.getByLabelText("Transcript paragraphs")).getAllByRole("button"),
  ).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox", { name: "Search script sections" }), {
    target: { value: "Two" },
  });
  fireEvent.click(within(screen.getByLabelText("Script sections")).getByRole("button"));
  fireEvent.click(screen.getByRole("button", { name: "Link selected paragraphs to slide" }));
  expect(useProjectStore.getState().project.scriptAssistance!.syncLinks![0]).toMatchObject({
    anchorIds: b.runs.flatMap((r) => r.anchorIds),
    scriptFrom: scriptSections(p)[1]!.from,
  });
});

it("commits the selected paragraph sequence to the selected slide with the explicit link action", () => {
  render(<ScriptSyncPanel />);
  const before = useProjectStore.getState().project;
  const blocks = projectTranscript(before);
  const paragraphs = within(screen.getByLabelText("Transcript paragraphs")).getAllByRole("button");
  fireEvent.click(paragraphs[0]!);
  fireEvent.click(paragraphs[1]!, { shiftKey: true });
  fireEvent.click(within(screen.getByLabelText("Script sections")).getAllByRole("button")[1]!);
  expect(screen.getByLabelText("Selected script link")).toHaveTextContent(
    "2 transcript paragraphs",
  );
  expect(screen.getByLabelText("Selected script link")).toHaveTextContent("Slide 2: Two");
  fireEvent.click(screen.getByRole("button", { name: "Link selected paragraphs to slide" }));
  const after = useProjectStore.getState().project;
  expect(after.scriptAssistance!.syncLinks).toHaveLength(1);
  expect(after.scriptAssistance!.syncLinks![0]).toMatchObject({
    anchorIds: blocks.flatMap((b) => b.runs.flatMap((r) => r.anchorIds)),
    scriptFrom: scriptSections(before)[1]!.from,
    scriptTo: scriptSections(before)[1]!.to,
  });
  expect(screen.getByRole("status")).toHaveTextContent("Link saved.");
  expect(after.segments).toBe(before.segments);
});

it("reveals saved links in both directions without changing the project", () => {
  const original = useProjectStore.getState().project;
  const blocks = projectTranscript(original);
  const sections = scriptSections(original);
  const range = (i: number) => [
    {
      segmentId: blocks[i]!.segmentId,
      blockId: blocks[i]!.id,
      from: 0,
      to: blocks[i]!.text.length,
    },
  ];
  const linked = setScriptSync(
    setScriptSync(original, range(0), sections[0]!),
    range(1),
    sections[1]!,
  );
  replaceProjectBaseline(linked);
  render(<ScriptSyncPanel />);
  const scriptChoices = () =>
    within(screen.getByLabelText("Script sections")).getAllByRole("button");
  const transcriptChoices = () =>
    within(screen.getByLabelText("Transcript paragraphs")).getAllByRole("button");
  fireEvent.change(screen.getByRole("textbox", { name: "Search transcript paragraphs" }), {
    target: { value: "Alpha" },
  });
  fireEvent.click(scriptChoices()[1]!);
  expect(screen.getByRole("textbox", { name: "Search transcript paragraphs" })).toHaveValue("");
  expect(transcriptChoices()[0]).toHaveAttribute("aria-pressed", "false");
  expect(transcriptChoices()[1]).toHaveAttribute("aria-pressed", "true");
  fireEvent.change(screen.getByRole("textbox", { name: "Search script sections" }), {
    target: { value: "Two" },
  });
  fireEvent.click(transcriptChoices()[0]!);
  expect(screen.getByRole("textbox", { name: "Search script sections" })).toHaveValue("");
  expect(scriptChoices()[0]).toHaveAttribute("aria-pressed", "true");
  expect(scriptChoices()[1]).toHaveAttribute("aria-pressed", "false");
  expect(useProjectStore.getState().project).toBe(linked);
});

it("selects an entire saved transcript sequence from its slide and preserves manual pairing for unlinked slides", () => {
  const original = useProjectStore.getState().project;
  const blocks = projectTranscript(original);
  const sections = scriptSections(original);
  const linked = setScriptSync(
    original,
    blocks.map((b) => ({ segmentId: b.segmentId, blockId: b.id, from: 0, to: b.text.length })),
    sections[1]!,
  );
  replaceProjectBaseline(linked);
  render(<ScriptSyncPanel />);
  const transcriptChoices = () =>
    within(screen.getByLabelText("Transcript paragraphs")).getAllByRole("button");
  const scriptChoices = within(screen.getByLabelText("Script sections")).getAllByRole("button");
  // Opening near a linked paragraph also selects its saved slide.
  expect(scriptChoices[1]).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(transcriptChoices()[1]!);
  fireEvent.click(scriptChoices[1]!);
  expect(transcriptChoices().every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);
  expect(screen.getByLabelText("Selected script link")).toHaveTextContent(
    "2 transcript paragraphs",
  );
  fireEvent.click(scriptChoices[0]!);
  expect(transcriptChoices().every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);
  expect(scriptChoices[0]).toHaveAttribute("aria-pressed", "true");
  expect(useProjectStore.getState().project).toBe(linked);
});

it("automatically matches on opening the dialog and navigates inferred pairings without saving them", async () => {
  const original = useProjectStore.getState().project;
  const p = replaceStoredScript(
    original,
    await prepareScript(
      `## First

Alpha bravo Charlie delta.

## Later

Later words here.`,
      "unique.md",
    ),
  );
  replaceProjectBaseline(p);
  usePlayerStore.getState().setCurrentTime(1);
  render(<ScriptSyncPanel />);
  await screen.findByText(/2 paragraphs automatically matched/);
  const slides = within(screen.getByLabelText("Script sections")).getAllByRole("button");
  expect(slides[1]).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(slides[0]!);
  const paragraphs = within(screen.getByLabelText("Transcript paragraphs")).getAllByRole("button");
  expect(paragraphs[0]).toHaveAttribute("aria-pressed", "true");
  expect(paragraphs[1]).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(paragraphs[1]!);
  expect(slides[1]).toHaveAttribute("aria-pressed", "true");
  expect(useProjectStore.getState().project).toBe(p);
  expect(p.scriptAssistance!.syncLinks).toBeUndefined();
});
