import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  status: vi.fn(),
  download: vi.fn(),
  ollama: vi.fn(),
}));
vi.mock("@/lib/retakeIpc", () => ({
  retakeModelStatus: mocks.status,
  downloadRetakeModel: mocks.download,
  retakeOllamaModels: mocks.ollama,
  analyzeRetakeWindows: vi.fn(),
}));
vi.mock("@/lib/retakeWorkflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/retakeWorkflow")>()),
  detectRetakes: mocks.detect,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p }));
vi.mock("@/hooks/useVideoFrameClock", () => ({ useVideoFrameClock: vi.fn() }));
import { RetakeReviewDialog } from "@/components/Retakes/RetakeReviewDialog";
import { lexicalRetakes, retakeRecords, retakeWindows } from "@/lib/retakes";
import { useProjectStore, replaceProjectBaseline } from "@/stores/projectStore";
import { usePlayerStore } from "@/stores/playerStore";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { speech } from "./helpers/retakeProject";
import { projectTranscript } from "@/lib/transcript";
function GlobalShortcuts() {
  useKeyboardShortcuts();
  return null;
}
beforeEach(() => {
  localStorage.clear();
  mocks.status.mockReset().mockResolvedValue({
    installed: true,
    sizeBytes: 4.6e9,
    modelId: "fixture",
    revision: "fixture",
  });
  mocks.detect.mockReset();
  mocks.download.mockReset();
  mocks.ollama.mockReset().mockResolvedValue(["qwen:8b", "gemma:12b"]);
  const p = speech("Before. The server The server The server responds. After.");
  replaceProjectBaseline(p);
  usePlayerStore.getState().reset();
  mocks.detect.mockResolvedValue(lexicalRetakes(retakeWindows(retakeRecords(p))[0]!));
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function openReview() {
  render(
    <>
      <GlobalShortcuts />
      <RetakeReviewDialog open onOpenChange={() => {}} />
    </>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Find retakes" }));
  await screen.findByRole("radio", { name: "Keep take 1" });
}
describe("grouped retake review", () => {
  it("uses a selected installed Ollama model without downloading MLX", async () => {
    mocks.status.mockResolvedValue({ installed: false, sizeBytes: 4.6e9 });
    render(<RetakeReviewDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Analysis runtime"), { target: { value: "ollama" } });
    const selector = await screen.findByLabelText("Ollama model");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "gemma:12b" })).toBeInTheDocument(),
    );
    fireEvent.change(selector, { target: { value: "gemma:12b" } });
    expect(screen.queryByRole("button", { name: "Download retake model" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Find retakes" }));
    await waitFor(() =>
      expect(mocks.detect).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(AbortSignal),
        expect.any(Function),
        expect.any(Function),
        { kind: "ollama", model: "gemma:12b" },
      ),
    );
    expect(localStorage.getItem("retake-ollama-model")).toBe("gemma:12b");
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("requires transcription and treats no results as ordinary", async () => {
    const p = speech("Words.");
    p.segments[0]!.words = [];
    replaceProjectBaseline(p);
    const { unmount } = render(<RetakeReviewDialog open onOpenChange={() => {}} />);
    expect(screen.getByText(/Transcribe the project/)).toBeInTheDocument();
    expect(mocks.status).not.toHaveBeenCalled();
    unmount();
    replaceProjectBaseline(speech("Just one thought."));
    mocks.detect.mockResolvedValue([]);
    render(<RetakeReviewDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Find retakes" }));
    expect(await screen.findByText("No likely retakes found.")).toBeInTheDocument();
  });
  it("auditions and chooses a middle take without editing until explicit acceptance", async () => {
    const before = useProjectStore.getState().project;
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Play original" }));
    expect(screen.getByText("Original passage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Keep take 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview cut" }));
    expect(screen.getByText("Proposed cut — not accepted")).toBeInTheDocument();
    expect(useProjectStore.getState().project).toBe(before);
    expect(useProjectStore.getState().dirty).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Accept cut" }));
    expect(await screen.findByText(/All candidates reviewed. 1 accepted/)).toBeInTheDocument();
    const after = useProjectStore.getState().project;
    const words = after.segments.flatMap((s) => s.words.map((w) => w.id));
    expect(words).toContain("w3");
    expect(words).toContain("w4");
    expect(words).not.toContain("w1");
    expect(words).not.toContain("w5");
    expect(
      projectTranscript(after)
        .map((b) => b.text)
        .join(" "),
    ).toBe("Before. The server responds. After.");
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(1);
    act(() => useProjectStore.temporal.getState().undo());
    expect(useProjectStore.getState().project).toBe(before);
    expect(await screen.findByText(/The project changed/)).toBeInTheDocument();
  });
  it("dismisses with no edit or undo entry", async () => {
    const before = useProjectStore.getState().project;
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText(/0 accepted, 1 dismissed/)).toBeInTheDocument();
    expect(useProjectStore.getState().project).toBe(before);
    expect(useProjectStore.temporal.getState().pastStates).toHaveLength(0);
  });
  it("invalidates previews on an external edit and suppresses main editing shortcuts", async () => {
    await openReview();
    fireEvent.click(screen.getByRole("button", { name: "Preview cut" }));
    const before = useProjectStore.getState().project;
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "b" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "x", ctrlKey: true, shiftKey: true });
    expect(useProjectStore.getState().project).toBe(before);
    act(() => useProjectStore.getState().rename("Changed externally"));
    expect(await screen.findByText(/The project changed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept cut" })).not.toBeInTheDocument();
    expect(screen.queryByText("Proposed cut — not accepted")).not.toBeInTheDocument();
  });
  it("cancels pending detection and ignores a late result", async () => {
    let resolve!: (v: []) => void;
    let signal!: AbortSignal;
    mocks.detect.mockImplementation((_p, s) => {
      signal = s;
      return new Promise<[]>((r) => {
        resolve = r;
      });
    });
    const before = useProjectStore.getState().project;
    render(<RetakeReviewDialog open onOpenChange={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Find retakes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve([]);
    });
    expect(screen.queryByText("No likely retakes found.")).not.toBeInTheDocument();
    expect(useProjectStore.getState().project).toBe(before);
  });
  it("requires explicit model setup and shows inference failures as errors", async () => {
    mocks.status.mockResolvedValue({ installed: false, sizeBytes: 4.6e9 });
    render(<RetakeReviewDialog open onOpenChange={() => {}} />);
    expect(
      await screen.findByRole("button", { name: "Download retake model" }),
    ).toBeInTheDocument();
    expect(mocks.download).not.toHaveBeenCalled();
    mocks.download.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ installed: true, sizeBytes: 4.6e9 });
    fireEvent.click(screen.getByRole("button", { name: "Download retake model" }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
    mocks.detect.mockRejectedValue(new Error("model process failed"));
    fireEvent.click(await screen.findByRole("button", { name: "Find retakes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("model process failed");
    expect(screen.queryByText("No likely retakes found.")).not.toBeInTheDocument();
  });
});
