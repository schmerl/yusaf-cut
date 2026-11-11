import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Toolbar } from "@/components/Toolbar/Toolbar";
import { listModels } from "@/lib/ipc";
import { buildCues, buildSrt, buildVtt, buildUntimedTranscript } from "@/lib/captions";
import { scriptReviewAction } from "@/lib/scriptReviewActions";
import { cutTranscriptRanges, replaceTranscriptText } from "@/lib/transcriptEdits";
import { projectTranscript } from "@/lib/transcript";
import { computeTimeline, totalDuration, type Project } from "@/lib/edl";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import fixture from "./fixtures/script-assistance.json";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  listModels: vi.fn(),
}));
vi.mock("@/components/Toolbox/Toolbox", () => ({ Toolbox: () => null }));
vi.mock("@/components/Toolbox/MusicTracksDialog", () => ({ MusicTracksDialog: () => null }));
vi.mock("@/components/Toolbox/SnapshotsDialog", () => ({ SnapshotsDialog: () => null }));

beforeEach(() => {
  vi.resetAllMocks();
  replaceProjectBaseline(structuredClone(fixture) as Project);
  useUIStore.setState({ toasts: [], mediaLoading: false, transcribeProgress: null });
  vi.mocked(listModels).mockResolvedValue([]);
  vi.mocked(writeTextFile).mockResolvedValue();
});
afterEach(cleanup);

function corrected() {
  let p = structuredClone(fixture) as Project;
  // Exercise an actual accepted review action, then a manual multi-anchor edit.
  p.scriptAssistance!.records.find((r) => r.id === "pending-example")!.afterText = "JSON.";
  p = scriptReviewAction(p, "pending-example", "accept");
  const block = projectTranscript(p)[1]!; // repeated source occurrence
  p = replaceTranscriptText(p, {
    segmentId: block.segmentId,
    blockId: block.id,
    from: 0,
    to: 12,
    text: "HTTP",
  });
  return p;
}

it.each(["srt", "vtt", "txt"])(
  "writes corrected %s after save/reopen through Captions",
  async (ext) => {
    const p = corrected();
    const reopened = JSON.parse(JSON.stringify(p)) as Project;
    replaceProjectBaseline(reopened);
    const before = JSON.stringify(reopened);
    vi.mocked(saveDialog).mockResolvedValue(`/tmp/corrected.${ext}`);
    render(<Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Captions" }));
    await waitFor(() => expect(writeTextFile).toHaveBeenCalledOnce());
    const content = vi.mocked(writeTextFile).mock.calls[0]![1];
    if (ext === "txt") {
      expect(content).not.toContain("-->");
      expect(vi.mocked(saveDialog).mock.calls[0]![0]?.filters).toContainEqual({
        name: "YouTube transcript (without timing)",
        extensions: ["txt"],
      });
    }
    expect(content).toContain("JSON.");
    expect(content).toContain("HTTP");
    expect(content).not.toContain("serveur.");
    expect(content).toBe(
      ext === "txt"
        ? buildUntimedTranscript(reopened)
        : ext === "vtt"
          ? buildVtt(reopened)
          : buildSrt(reopened),
    );
    expect(JSON.stringify(useProjectStore.getState().project)).toBe(before);
    expect(computeTimeline(p)).toEqual(computeTimeline(fixture as Project));
    expect(p.segments.map((s) => s.words)).toEqual(fixture.segments.map((s) => s.words));
  },
);

it("exports corrections completed while the save dialog is pending", async () => {
  let resolve!: (value: string) => void;
  vi.mocked(saveDialog).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<Toolbar />);
  fireEvent.click(screen.getByRole("button", { name: "Captions" }));
  const current = useProjectStore.getState().project;
  const p = corrected();
  act(() => useProjectStore.getState().commitTranscript(p, current));
  await act(async () => resolve("/tmp/current.srt"));
  await waitFor(() => expect(writeTextFile).toHaveBeenCalledWith("/tmp/current.srt", buildSrt(p)));
});

it("does not write a different project into a pending export", async () => {
  let resolve!: (value: string) => void;
  vi.mocked(saveDialog).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<Toolbar />);
  fireEvent.click(screen.getByRole("button", { name: "Captions" }));
  act(() => replaceProjectBaseline(corrected()));
  await act(async () => resolve("/tmp/old-project.srt"));
  expect(writeTextFile).not.toHaveBeenCalled();
  expect(useUIStore.getState().toasts.at(-1)?.description).toMatch(/project changed/);
});

it.each(["srt", "vtt", "txt"])(
  "preserves hidden text and cuts splitting a paragraph in %s",
  (ext) => {
    const p = corrected();
    const first = projectTranscript(p)[0]!;
    const cut = cutTranscriptRanges(p, [
      {
        segmentId: first.segmentId,
        blockId: first.id,
        from: first.runs[1]!.from,
        to: first.runs[1]!.to,
      },
    ]);
    const reopened = JSON.parse(JSON.stringify(cut)) as Project;
    const content = ext === "srt" ? buildSrt(reopened) : buildVtt(reopened);
    expect(content).toContain("JSON.");
    expect(content).toContain("HTTP");
    const cues = buildCues(reopened);
    expect(cues[0]!.start).toBe(0);
    expect(cues.at(-1)!.end).toBeCloseTo(totalDuration(reopened), 8);
    for (let i = 1; i < cues.length; i++)
      expect(cues[i]!.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
    const displayed = projectTranscript(reopened)
      .filter((b) => b.segmentId !== "s2")
      .map((b) => b.text)
      .join(" ");
    expect(displayed).not.toContain("old"); // hidden anchor is retained, never captioned
    expect(displayed).not.toContain("are not"); // cut audio
    expect(reopened.segments.at(-1)!.words).toEqual(p.segments.at(-1)!.words);
  },
);

it("cancels without writing and reports a real write failure", async () => {
  vi.mocked(saveDialog).mockResolvedValue(null);
  render(<Toolbar />);
  fireEvent.click(screen.getByRole("button", { name: "Captions" }));
  await act(async () => {});
  expect(writeTextFile).not.toHaveBeenCalled();
  vi.mocked(saveDialog).mockResolvedValue("/tmp/fail.srt");
  vi.mocked(writeTextFile).mockRejectedValue(new Error("Disk full"));
  fireEvent.click(screen.getByRole("button", { name: "Captions" }));
  await waitFor(() =>
    expect(useUIStore.getState().toasts.at(-1)?.description).toContain("Disk full"),
  );
  expect(useUIStore.getState().toasts.at(-1)?.title).toBe("Caption export failed");
});
