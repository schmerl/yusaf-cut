import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Toolbar } from "@/components/Toolbar/Toolbar";
import { addMediaWithTranscript, newProject } from "@/lib/edl";
import { importMedia, loadProject, saveProject } from "@/lib/ipc";
import { isProjectPath, openSavedProject, projectBundlePath } from "@/lib/openProject";
import { usePlayerStore } from "@/stores/playerStore";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/ipc")>(),
  importMedia: vi.fn(),
  loadProject: vi.fn(),
  saveProject: vi.fn(),
}));
vi.mock("@/components/Toolbox/Toolbox", () => ({ Toolbox: () => null }));
vi.mock("@/components/Toolbox/MusicTracksDialog", () => ({ MusicTracksDialog: () => null }));
vi.mock("@/components/Toolbox/SnapshotsDialog", () => ({ SnapshotsDialog: () => null }));

const bundle = "/tmp/Teaching/05.1-http-semantics.scribe";
const jsonPath = `${bundle}/project.json`;
const media = {
  id: "m1", path: "/tmp/lecture.mp4", duration: 60, fps: 30,
  width: 1920, height: 1080, audioSampleRate: 48000, sha256: "media-hash",
};

function savedProject() {
  const project = addMediaWithTranscript(newProject("Lecture"), media, [
    { id: "w1", text: "idempotency", start: 0, end: 1, confidence: 0.99 },
  ]);
  // Model saved cuts, rather than replacing them with a freshly imported clip.
  project.segments[0]!.sourceIn = 0.25;
  project.segments[0]!.sourceOut = 12;
  return project;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useProjectStore.setState({ project: newProject("Current"), filePath: null, dirty: false });
  useProjectStore.getState().setPauseTokens([]);
  usePlayerStore.getState().reset();
  useUIStore.setState({ toasts: [], mediaLoading: false });
});

afterEach(cleanup);

describe("reopening saved projects", () => {
  it.each([bundle, jsonPath, `${bundle}/`])("recognizes %s as a project", (path) => {
    expect(isProjectPath(path)).toBe(true);
    expect(projectBundlePath(path)).toBe(bundle);
  });

  it("does not classify media or unrelated JSON as projects", () => {
    expect(isProjectPath(media.path)).toBe(false);
    expect(isProjectPath("/tmp/settings.json")).toBe(false);
  });

  it("opens project.json from the toolbar without importing it as media, then saves to its bundle", async () => {
    const project = savedProject();
    vi.mocked(openDialog).mockResolvedValue(jsonPath);
    vi.mocked(loadProject).mockResolvedValue(project);
    vi.mocked(saveProject).mockResolvedValue();
    usePlayerStore.getState().setCurrentTime(20);
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(useProjectStore.getState().filePath).toBe(bundle));

    expect(loadProject).toHaveBeenCalledWith(jsonPath);
    expect(importMedia).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project).toEqual(project);
    expect(useProjectStore.getState().dirty).toBe(false);
    expect(usePlayerStore.getState().currentTime).toBe(0);
    expect(useUIStore.getState().mediaLoading).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveProject).toHaveBeenCalledWith(project, bundle));
  });

  it("lets Open Project select a bundle directory", async () => {
    vi.mocked(openDialog).mockResolvedValue(bundle);
    vi.mocked(loadProject).mockResolvedValue(savedProject());
    render(<Toolbar />);

    fireEvent.keyDown(screen.getByRole("button", { name: "File" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open Project" }));

    await waitFor(() => expect(loadProject).toHaveBeenCalledWith(bundle));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(importMedia).not.toHaveBeenCalled();
  });

  it("still imports videos from the toolbar", async () => {
    vi.mocked(openDialog).mockResolvedValue(media.path);
    vi.mocked(importMedia).mockResolvedValue(media);
    render(<Toolbar />);

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(importMedia).toHaveBeenCalledWith(media.path));
    expect(loadProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().filePath).toBeNull();
  });

  it("leaves the current project intact when opening fails", async () => {
    const previous = useProjectStore.getState().project;
    vi.mocked(loadProject).mockRejectedValue(new Error("Invalid project"));

    await openSavedProject(jsonPath);

    expect(useProjectStore.getState().project).toBe(previous);
    expect(useProjectStore.getState().filePath).toBeNull();
    expect(importMedia).not.toHaveBeenCalled();
    expect(useUIStore.getState().mediaLoading).toBe(false);
    expect(useUIStore.getState().toasts.at(-1)?.title).toBe("Failed to open project");
  });
});
