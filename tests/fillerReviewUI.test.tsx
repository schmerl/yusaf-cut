import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateFillerBoundaries, prepareFillerAudition, releaseFillerAudition } from "@/lib/ipc";
import { TranscriptEditor } from "@/components/TranscriptEditor/TranscriptEditor";
import { VideoPreview } from "@/components/VideoPreview/VideoPreview";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { useUIStore } from "@/stores/uiStore";
import { useFillerAuditionStore } from "@/stores/fillerAuditionStore";
import { addMediaWithTranscript, newProject, totalDuration } from "@/lib/edl";
import { projectTranscript } from "@/lib/transcript";
import { replaceTranscriptText } from "@/lib/transcriptEdits";
import { fillerCandidates } from "@/lib/fillerReview";
import source from "./fixtures/transcript-corrections.json";
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => path }));
vi.mock("@/lib/ipc", () => ({
  estimateFillerBoundaries: vi.fn(),
  prepareFillerAudition: vi.fn(() => new Promise(() => {})),
  releaseFillerAudition: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/hooks/useVideoFrameClock", () => ({ useVideoFrameClock: vi.fn() }));
function setup(text = "Hello [UM], [UH] like world.") {
  const project = addMediaWithTranscript(
    newProject("Review"),
    structuredClone(source.media.m1),
    text
      .split(" ")
      .map((text, i) => ({ id: `w${i}`, text, start: i * 0.5, end: i * 0.5 + 0.3, confidence: 1 })),
  );
  replaceProjectBaseline(project);
  const result = render(
    <>
      <VideoPreview />
      <TranscriptEditor />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review fillers" }));
  return {
    ...result,
    project,
    panel: () => within(screen.getByRole("complementary", { name: "Filler review" })),
  };
}
beforeEach(() => {
  vi.mocked(estimateFillerBoundaries).mockResolvedValue({
    start: null,
    end: null,
    reason: "No clear boundary in this fixture.",
    limitedByNeighbor: false,
  });
  vi.mocked(prepareFillerAudition).mockImplementation(() => new Promise(() => {}));
  vi.mocked(releaseFillerAudition).mockResolvedValue(undefined);
  usePlayerStore.getState().reset();
  useUIStore.getState().setFillerReviewOpen(false);
  useFillerAuditionStore.getState().stop();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function filter(name: string) {
  fireEvent.change(screen.getByRole("combobox", { name: "Review filter" }), {
    target: { value: name },
  });
}

describe("filler review workflow", () => {
  it("highlights bracketed vocals by default and opens without dirty state, history, or playback", () => {
    const { project, panel } = setup();
    const highlighted = screen
      .getByRole("textbox", { name: "Editable transcript" })
      .querySelectorAll(".is-filler");
    expect(Array.from(highlighted, (el) => el.textContent)).toEqual(["[UM]", "[UH]"]);
    expect(panel().getByText("1 of 2")).toBeInTheDocument();
    expect(useProjectStore.getState().project).toBe(project);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it("keeps playback above initially collapsed boundary controls and reports exact duration reduction", () => {
    const { panel } = setup();
    const summary = panel().getByText("Adjust cut boundaries");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    const play = panel().getByRole("button", { name: "Play before" });
    expect(play.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel().getByLabelText("Cut duration change")).toHaveTextContent("0.300 s removed");
    fireEvent.click(panel().getByRole("button", { name: "Cut filler speech" }));
    expect(totalDuration(useProjectStore.getState().project)).toBeCloseTo(4.7);
    expect(panel().getByLabelText("Cut duration change")).toHaveTextContent("0.300 s removed");
  });
  it("explains a 20ms timing estimate and previews explicitly expanded boundaries", () => {
    const { panel, project } = setup();
    const shortened = {
      ...project,
      segments: project.segments.map((s) => ({
        ...s,
        words: s.words.map((w) => (w.id === "w1" ? { ...w, end: 0.52 } : w)),
      })),
    };
    act(() => replaceProjectBaseline(shortened));
    expect(panel().queryByLabelText("Filler timing warning")).not.toBeInTheDocument();
    expect(panel().getByLabelText("Cut duration change")).toHaveTextContent("0.020 s removed");
    expect(panel().getByLabelText("Cut timing details").closest("details")).not.toHaveAttribute(
      "open",
    );
    fireEvent.click(panel().getByLabelText("Cut timing details"));
    expect(panel().getByText(/Recognized span: 20 ms/)).toBeVisible();
    fireEvent.keyDown(panel().getByLabelText("Cut timing details"), { key: "Escape" });
    expect(panel().getByLabelText("Cut timing details").closest("details")).not.toHaveAttribute(
      "open",
    );
    fireEvent.click(panel().getByText("Adjust cut boundaries"));
    fireEvent.change(panel().getByRole("spinbutton", { name: "start offset ms" }), {
      target: { value: "-100" },
    });
    fireEvent.change(panel().getByRole("spinbutton", { name: "end offset ms" }), {
      target: { value: "180" },
    });
    fireEvent.click(panel().getByRole("button", { name: "Preview cut" }));
    const preview = useFillerAuditionStore.getState().request!;
    expect(totalDuration(preview.timeline)).toBeCloseTo(totalDuration(shortened) - 0.3);
    expect(useProjectStore.getState().project).toBe(shortened);
    fireEvent.click(panel().getByRole("button", { name: "Cut filler speech" }));
    expect(useProjectStore.getState().project).toBe(preview.timeline);
  });
  it("automatically applies a bounded audio estimate for a 20ms span without editing the project", async () => {
    const { panel, project } = setup();
    const short = {
      ...project,
      segments: project.segments.map((s) => ({
        ...s,
        words: s.words.map((w) => (w.id === "w1" ? { ...w, end: 0.52 } : w)),
      })),
    };
    vi.mocked(estimateFillerBoundaries).mockResolvedValue({
      start: 0.44,
      end: 0.65,
      reason: "Preview before cutting.",
      limitedByNeighbor: false,
    });
    await act(async () => replaceProjectBaseline(short));
    expect(panel().queryByLabelText("Audio boundary estimate")).not.toBeInTheDocument();
    expect(useProjectStore.getState().project).toBe(short);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    fireEvent.click(panel().getByText("Adjust cut boundaries"));
    expect(panel().getByRole("spinbutton", { name: "start offset ms" })).toHaveValue(-60);
    expect(panel().getByRole("spinbutton", { name: "end offset ms" })).toHaveValue(130);
    fireEvent.click(panel().getByRole("button", { name: "Play before" }));
    const before = useFillerAuditionStore.getState().request!;
    fireEvent.click(panel().getByRole("button", { name: "Preview cut" }));
    const preview = useFillerAuditionStore.getState().request!;
    expect(before.end - before.start - (preview.end - preview.start)).toBeCloseTo(0.21);
    expect(totalDuration(preview.timeline)).toBeCloseTo(totalDuration(short) - 0.21);
    fireEvent.click(panel().getByRole("button", { name: "Cut filler speech" }));
    expect(useProjectStore.getState().project).toBe(preview.timeline);
  });
  it("does not overwrite manual offsets when an older estimate completes", async () => {
    const { panel, project } = setup();
    let resolve!: (estimate: Awaited<ReturnType<typeof estimateFillerBoundaries>>) => void;
    vi.mocked(estimateFillerBoundaries).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const short = {
      ...project,
      segments: project.segments.map((s) => ({
        ...s,
        words: s.words.map((w) => (w.id === "w1" ? { ...w, end: 0.52 } : w)),
      })),
    };
    await act(async () => replaceProjectBaseline(short));
    expect(panel().getByRole("button", { name: "Preview cut" })).toBeDisabled();
    fireEvent.click(panel().getByText("Adjust cut boundaries"));
    fireEvent.change(panel().getByRole("spinbutton", { name: "start offset ms" }), {
      target: { value: "-100" },
    });
    await act(async () =>
      resolve({ start: 0.44, end: 0.65, reason: "estimated", limitedByNeighbor: false }),
    );
    expect(panel().getByRole("spinbutton", { name: "start offset ms" })).toHaveValue(-100);
    expect(panel().getByRole("spinbutton", { name: "end offset ms" })).toHaveValue(0);
    expect(panel().getByRole("button", { name: "Preview cut" })).toBeEnabled();
    expect(useProjectStore.getState().project).toBe(short);
  });
  it("stops pending estimation without allowing late offsets to be applied", async () => {
    const { panel, project } = setup();
    let resolve!: (estimate: Awaited<ReturnType<typeof estimateFillerBoundaries>>) => void;
    vi.mocked(estimateFillerBoundaries).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const short = {
      ...project,
      segments: project.segments.map((s) => ({
        ...s,
        words: s.words.map((w) => (w.id === "w1" ? { ...w, end: 0.52 } : w)),
      })),
    };
    await act(async () => replaceProjectBaseline(short));
    fireEvent.click(panel().getByRole("button", { name: "Stop" }));
    await act(async () =>
      resolve({ start: 0.44, end: 0.65, reason: "estimated", limitedByNeighbor: false }),
    );
    expect(panel().queryByLabelText("Audio boundary estimate")).not.toBeInTheDocument();
    expect(panel().getByLabelText("Cut duration change")).toHaveTextContent("0.020 s removed");
  });
  it("rejects an audio estimate that crosses a neighbor and keeps raw offsets", async () => {
    const { panel, project } = setup();
    vi.mocked(estimateFillerBoundaries).mockResolvedValue({
      start: 0.1,
      end: 0.65,
      reason: "estimated",
      limitedByNeighbor: false,
    });
    const short = {
      ...project,
      segments: project.segments.map((s) => ({
        ...s,
        words: s.words.map((w) => (w.id === "w1" ? { ...w, end: 0.52 } : w)),
      })),
    };
    await act(async () => replaceProjectBaseline(short));
    expect(panel().getByLabelText("Audio boundary estimate")).toHaveTextContent(/neighbor/);
    expect(panel().getByLabelText("Cut duration change")).toHaveTextContent("0.020 s removed");
    expect(useProjectStore.getState().dirty).toBe(false);
  });
  it("discards an estimate when the project session changes", async () => {
    const { panel, project } = setup();
    let resolve!: (estimate: Awaited<ReturnType<typeof estimateFillerBoundaries>>) => void;
    vi.mocked(estimateFillerBoundaries).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const short = {
      ...project,
      segments: project.segments.map((s) => ({
        ...s,
        words: s.words.map((w) => (w.id === "w1" ? { ...w, end: 0.52 } : w)),
      })),
    };
    await act(async () => replaceProjectBaseline(short));
    act(() => replaceProjectBaseline(project));
    await act(async () =>
      resolve({ start: 0.44, end: 0.65, reason: "estimated", limitedByNeighbor: false }),
    );
    expect(panel().queryByLabelText("Audio boundary estimate")).not.toBeInTheDocument();
    expect(panel().getByLabelText("Cut duration change")).toHaveTextContent("0.300 s removed");
    expect(useProjectStore.getState().project).toBe(project);
  });
  it("pins Keep on its own card, revisits kept items and resets them without advancing", () => {
    const { panel } = setup();
    fireEvent.click(panel().getByRole("button", { name: "Keep" }));
    expect(panel().getByText("[UM]")).toBeInTheDocument();
    expect(panel().getByText("Pinned result · 1 in queue")).toBeInTheDocument();
    filter("Kept");
    expect(panel().getByText("1 of 1")).toBeInTheDocument();
    fireEvent.click(panel().getByRole("button", { name: "Reset to unreviewed" }));
    expect(fillerCandidates(useProjectStore.getState().project).every((c) => !c.outcome)).toBe(
      true,
    );
    expect(panel().getByText("[UM]")).toBeInTheDocument();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it("does not offer to undo an unrelated edit after an idempotent Keep", () => {
    const { panel } = setup();
    fireEvent.click(panel().getByRole("button", { name: "Keep" }));
    act(() => useProjectStore.getState().rename("Unrelated rename"));
    fireEvent.click(panel().getByRole("button", { name: "Keep" }));
    expect(panel().getByRole("button", { name: "Undo this decision" })).toBeDisabled();
  });
  it("Skip advances for this session only and Review skipped restores the queue", () => {
    const { panel, project } = setup();
    fireEvent.click(panel().getByRole("button", { name: "Skip" }));
    expect(panel().getByText("[UH]")).toBeInTheDocument();
    expect(useProjectStore.getState().project).toBe(project);
    fireEvent.click(panel().getByRole("button", { name: "Review skipped (1)" }));
    expect(panel().getByText("[UM]")).toBeInTheDocument();
    fireEvent.click(panel().getByRole("button", { name: "Skip" }));
    fireEvent.click(panel().getByRole("button", { name: "Close review" }));
    fireEvent.click(screen.getByRole("button", { name: "Review fillers" }));
    expect(panel().getByText("1 of 2")).toBeInTheDocument();
    expect(useProjectStore.getState().dirty).toBe(false);
  });
  it("removes text only, keeps duration, stays pinned and exposes Audio retained with undo", () => {
    const { panel, project } = setup();
    fireEvent.click(panel().getByRole("button", { name: "Remove text only" }));
    expect(screen.getByRole("textbox", { name: "Editable transcript" })).not.toHaveTextContent(
      "UM",
    );
    expect(totalDuration(useProjectStore.getState().project)).toBe(totalDuration(project));
    expect(panel().getByText("[UM]")).toBeInTheDocument();
    expect(panel().getByText("Text removed, audio retained")).toBeInTheDocument();
    expect(panel().getByRole("button", { name: "Remove text only" })).toBeDisabled();
    fireEvent.click(panel().getByRole("button", { name: "Undo this decision" }));
    expect(screen.getByRole("textbox", { name: "Editable transcript" })).toHaveTextContent("[UM],");
    fireEvent.click(panel().getByRole("button", { name: "Remove text only" }));
    filter("Audio retained");
    expect(panel().getByText("1 of 1")).toBeInTheDocument();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
  it("previews without committing, commits that exact proposal, pins the result and replays explicitly", () => {
    const { panel, project } = setup();
    fireEvent.click(panel().getByRole("button", { name: "Play before" }));
    const before = useFillerAuditionStore.getState().request!;
    expect(before.timeline).toBe(project);
    expect(
      before.timeline.segments.flatMap((s) => s.words).some((w) => w.text.includes("UM")),
    ).toBe(true);
    fireEvent.click(panel().getByRole("button", { name: "Preview cut" }));
    const preview = useFillerAuditionStore.getState().request!;
    expect(preview.mode).toBe("preview");
    expect(preview.timeline).not.toBe(before.timeline);
    expect(
      preview.timeline.segments.flatMap((s) => s.words).some((w) => w.text.includes("UM")),
    ).toBe(false);
    expect(totalDuration(preview.timeline)).toBeCloseTo(totalDuration(project) - 0.3);
    expect(useProjectStore.getState().project).toBe(project);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
    expect(
      screen.getByText("Preview cut — project unchanged", { exact: false }),
    ).toBeInTheDocument();
    fireEvent.click(panel().getByRole("button", { name: "Cut filler speech" }));
    expect(useProjectStore.getState().project).toBe(preview.timeline);
    expect(useFillerAuditionStore.getState().request).toBeNull();
    expect(panel().getByText("Filler speech cut")).toBeInTheDocument();
    expect(panel().getByText("[UM]")).toBeInTheDocument();
    expect(panel().getByRole("button", { name: "Play result" })).toBeEnabled();
    fireEvent.click(panel().getByRole("button", { name: "Play before" }));
    expect(useFillerAuditionStore.getState().request!.timeline).toBe(project);
    expect(useFillerAuditionStore.getState().request!.expected).toBe(preview.timeline);
    fireEvent.click(panel().getByRole("button", { name: "Play result" }));
    expect(useFillerAuditionStore.getState().request!.timeline).toBe(preview.timeline);
    fireEvent.click(panel().getByRole("button", { name: "Undo this decision" }));
    expect(useProjectStore.getState().project).toBe(project);
    expect(useFillerAuditionStore.getState().request).toBeNull();
  });
  it("nudges boundaries 10 ms, discloses retained edges and rejects typed invalid offsets", () => {
    const { panel } = setup();
    fireEvent.click(panel().getByText("Adjust cut boundaries"));
    fireEvent.click(panel().getByRole("button", { name: "start plus 10 ms" }));
    expect(panel().getByRole("spinbutton", { name: "start offset ms" })).toHaveValue(10);
    expect(panel().getByText(/Some filler edges will remain audible/)).toBeInTheDocument();
    fireEvent.change(panel().getByRole("spinbutton", { name: "start offset ms" }), {
      target: { value: "1000" },
    });
    expect(panel().getByRole("button", { name: "Cut filler speech" })).toBeDisabled();
    expect(panel().getByText(/Cut end must be later/)).toBeInTheDocument();
    fireEvent.change(panel().getByRole("spinbutton", { name: "start offset ms" }), {
      target: { value: "10" },
    });
    fireEvent.click(panel().getByRole("button", { name: "Cut filler speech" }));
    filter("Audio retained");
    expect(panel().getByText(/Some filler edges remain audible/)).toBeInTheDocument();
  });
  it("enforces filler-only paragraph restrictions without preventing a full speech cut", () => {
    const { panel } = setup("[UM]");
    fireEvent.click(panel().getByText("Adjust cut boundaries"));
    expect(panel().getByRole("button", { name: "Remove text only" })).toBeDisabled();
    expect(panel().getByText(/A spoken paragraph must retain text/)).toBeInTheDocument();
    fireEvent.click(panel().getByRole("button", { name: "start plus 10 ms" }));
    expect(panel().getByRole("button", { name: "Cut filler speech" })).toBeDisabled();
    fireEvent.click(panel().getByRole("button", { name: "start minus 10 ms" }));
    fireEvent.click(panel().getByRole("button", { name: "Cut filler speech" }));
    expect(panel().getByText("Filler speech cut")).toBeInTheDocument();
    expect(panel().getByRole("button", { name: "Play result" })).toBeEnabled();
  });
  it("allows Keep and Skip while explaining why a grouped correction cannot be cut alone", () => {
    const { panel, project } = setup();
    const block = projectTranscript(project)[0]!;
    const grouped = replaceTranscriptText(project, {
      segmentId: block.segmentId,
      blockId: block.id,
      from: 0,
      to: block.runs[1]!.to,
      text: "Greetings UM",
    });
    act(() => useProjectStore.getState().commitTranscript(grouped, project));
    expect(panel().getByRole("button", { name: "Keep" })).toBeEnabled();
    expect(panel().getByRole("button", { name: "Skip" })).toBeEnabled();
    expect(panel().getByRole("button", { name: "Cut filler speech" })).toBeDisabled();
    expect(panel().getByText(/shares a corrected timing group/)).toBeInTheDocument();
  });
  it("resets skips and listening settings when switching project sessions", () => {
    const { panel, project } = setup();
    fireEvent.click(panel().getByRole("button", { name: "Skip" }));
    fireEvent.change(panel().getByRole("spinbutton", { name: "Context before seconds" }), {
      target: { value: "4" },
    });
    fireEvent.click(panel().getByRole("checkbox", { name: "Loop" }));
    act(() => replaceProjectBaseline({ ...project, id: "new-project" }));
    expect(panel().getByText("1 of 2")).toBeInTheDocument();
    expect(panel().getByRole("spinbutton", { name: "Context before seconds" })).toHaveValue(2);
    expect(panel().getByRole("checkbox", { name: "Loop" })).not.toBeChecked();
  });
  it("invalidates replay and stops audition after an unrelated edit", () => {
    const { panel } = setup();
    fireEvent.click(panel().getByRole("button", { name: "Preview cut" }));
    act(() => useProjectStore.getState().rename("Changed"));
    expect(useFillerAuditionStore.getState().request).toBeNull();
    expect(panel().getByText(/Previous playback comparisons were cleared/)).toBeInTheDocument();
    expect(panel().getByRole("button", { name: "Undo this decision" })).toBeDisabled();
    expect(panel().getByRole("button", { name: "Play result" })).toBeDisabled();
  });
  it("saves opt-in and custom literal detection choices while keeping ordinary words off by default", () => {
    const { panel } = setup();
    fireEvent.click(panel().getByText("Detection settings"));
    fireEvent.click(panel().getByLabelText("like", { exact: true }));
    expect(fillerCandidates(useProjectStore.getState().project).map((c) => c.rule)).toEqual([
      "um",
      "uh",
      "like",
    ]);
    fireEvent.change(panel().getByRole("textbox", { name: "Custom filler phrases" }), {
      target: { value: "world" },
    });
    fireEvent.click(panel().getByRole("button", { name: "Apply custom phrases" }));
    expect(useProjectStore.getState().project.fillerReview!.policy).toEqual({
      optional: ["like"],
      custom: ["world"],
    });
    expect(
      screen.getByRole("textbox", { name: "Editable transcript" }).querySelectorAll(".is-filler"),
    ).toHaveLength(4);
  });
});
