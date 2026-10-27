import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Toolbar } from "@/components/Toolbar/Toolbar";
import { createSnapshot, detectPauses, listModels, saveProject, transcribe } from "@/lib/ipc";
import { projectTranscript } from "@/lib/transcript";
import { replaceProjectBaseline, useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import type { Project } from "@/lib/edl";
import fixture from "./fixtures/transcript-corrections.json";
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  listModels: vi.fn(),
  transcribe: vi.fn(),
  saveProject: vi.fn(),
  createSnapshot: vi.fn(),
  detectPauses: vi.fn(),
}));
vi.mock("@/components/Toolbox/Toolbox", () => ({ Toolbox: () => null }));
vi.mock("@/components/Toolbox/MusicTracksDialog", () => ({ MusicTracksDialog: () => null }));
vi.mock("@/components/Toolbox/SnapshotsDialog", () => ({ SnapshotsDialog: () => null }));
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  replaceProjectBaseline(structuredClone(fixture) as Project);
  useUIStore.setState({ toasts: [], mediaLoading: false, transcribeProgress: null });
  vi.mocked(listModels).mockResolvedValue([
    { name: "large-v3-turbo", engine: "whisper-cpp", installed: true, sizeMb: 1600 },
  ]);
  vi.mocked(saveProject).mockResolvedValue();
  vi.mocked(createSnapshot).mockResolvedValue({
    id: "s",
    label: "s",
    createdAt: "now",
    segments: 2,
    durationSec: 6,
  });
  vi.mocked(detectPauses).mockResolvedValue([]);
  vi.mocked(transcribe).mockImplementation(async ({ mediaId }) => ({
    mediaId,
    engine: "whisper-cpp",
    words: [{ id: "new", text: "Recognized.", start: 0, end: 2.9, confidence: 1 }],
  }));
});
afterEach(cleanup);
async function warning() {
  render(<Toolbar />);
  fireEvent.click(screen.getByRole("button", { name: "Re-Transcribe" }));
  await screen.findByRole("dialog", { name: "Re-Transcribe" });
  fireEvent.click(screen.getByRole("button", { name: "Re-Transcribe" }));
  await screen.findByRole("dialog", { name: "Replace existing transcript?" });
}
it("shows correction warning with all choices; Cancel makes no edit, save, snapshot or recognition", async () => {
  const original = useProjectStore.getState().project;
  await warning();
  expect(screen.getByText(/1 corrected occurrence/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Proceed" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Snapshot first" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(useProjectStore.getState().project).toBe(original);
  expect(transcribe).not.toHaveBeenCalled();
  expect(createSnapshot).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
});
it("Proceed replaces corrected text without claiming to create a snapshot", async () => {
  await warning();
  fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
  await waitFor(() =>
    expect(projectTranscript(useProjectStore.getState().project)[0]!.text).toBe("Recognized."),
  );
  expect(createSnapshot).not.toHaveBeenCalled();
  expect(saveProject).not.toHaveBeenCalled();
});
it("Snapshot first saves an unsaved project and snapshots corrections before recognition", async () => {
  vi.mocked(saveDialog).mockResolvedValue("/tmp/protected.scribe");
  const original = useProjectStore.getState().project;
  await warning();
  fireEvent.click(screen.getByRole("button", { name: "Snapshot first" }));
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  expect(createSnapshot).toHaveBeenCalledWith(
    original,
    "/tmp/protected.scribe",
    "Before re-transcription",
  );
  expect(vi.mocked(createSnapshot).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(transcribe).mock.invocationCallOrder[0]!,
  );
  await waitFor(() => expect(useUIStore.getState().transcribeProgress).toBeNull());
});
it.each(["cancel", "save failure", "snapshot failure"])(
  "preserves corrections and explains %s without recognizing",
  async (scenario) => {
    if (scenario === "cancel") vi.mocked(saveDialog).mockResolvedValue(null);
    else {
      vi.mocked(saveDialog).mockResolvedValue("/tmp/protected.scribe");
      if (scenario === "save failure")
        vi.mocked(saveProject).mockRejectedValue(new Error("Save disk error"));
      else vi.mocked(createSnapshot).mockRejectedValue(new Error("Snapshot disk error"));
    }
    const original = useProjectStore.getState().project;
    await warning();
    fireEvent.click(screen.getByRole("button", { name: "Snapshot first" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toMatch(/cancelled|disk error/);
    expect(useProjectStore.getState().project).toBe(original);
    expect(transcribe).not.toHaveBeenCalled();
  },
);
it("recognition failure preserves corrections and reports the actual failure", async () => {
  vi.mocked(transcribe).mockRejectedValue(new Error("Whisper failed"));
  const original = useProjectStore.getState().project;
  await warning();
  fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
  await waitFor(() =>
    expect(
      useUIStore.getState().toasts.some((t) => t.description?.includes("Whisper failed")),
    ).toBe(true),
  );
  expect(useProjectStore.getState().project).toBe(original);
});
it("a changed project invalidates the confirmation before recognition starts", async () => {
  await warning();
  act(() => useProjectStore.getState().rename("changed while warning open"));
  fireEvent.click(screen.getByRole("button", { name: "Proceed" }));
  expect(screen.getByRole("alert").textContent).toMatch(/project changed/);
  expect(transcribe).not.toHaveBeenCalled();
});
